import { randomUUID } from "node:crypto";
import { runCuratorStage } from "../curator/session.ts";
import { configureCuratorResearch, type CuratorResearchConfig } from "../curator/tools.ts";
import { runEditorStage } from "../editor/session.ts";
import type { Sql } from "../db/client.ts";
import { getBrief, latestBriefDate, saveBrief, saveDraft } from "../db/briefs.ts";
import { getMaterials, saveMaterials } from "../db/materials.ts";
import { finishAgentRun, getRun, recordAttempt, startAgentRun, upsertRun } from "../db/runs.ts";
import { listSignals, observeSignal } from "../db/signals.ts";
import { renderBriefMarkdown } from "../renderer/markdown.ts";
import type { AgentDriverFactory } from "../runtime/agent-driver.ts";
import { createPiAgentDriver } from "../runtime/agent-driver.ts";
import { MODEL_CHAIN, modelKey, type ModelSpec } from "../runtime/model-config.ts";
import { RouterState, runStageWithFallback } from "../runtime/model-router.ts";
import type { DailyBrief, DailyManifest, DailyMaterials, RunState } from "../schemas/index.ts";
import { DailyBrief as DailyBriefSchema } from "../schemas/index.ts";
import { PostgresStoryRepository } from "../stories/postgres-repository.ts";
import { validateBrief } from "../validator/brief-validator.ts";
import { buildManifestFromDb } from "./manifest.ts";
import {
	type CollectionSummary,
	type RegistryEntry,
	type SecretAccess,
	createPostgresCollectionStore,
	runCollectionForDay,
} from "./collection.ts";
import { type KnownSignal, reconcileSignals } from "./signals.ts";

/* -------------------------------------------------------------------------- */
/* State machine                                                               */
/* -------------------------------------------------------------------------- */

export const PIPELINE_STATES = [
	"CREATED",
	"COLLECTING",
	"COLLECTED",
	"CURATING",
	"MATERIALS_READY",
	"WRITING",
	"DRAFT_READY",
	"VALIDATING",
	"PUBLISHED",
	"COLLECTION_FAILED",
	"CURATION_FAILED",
	"EDITOR_FAILED",
	"VALIDATION_FAILED",
] as const;
export type PipelineState = (typeof PIPELINE_STATES)[number];

/**
 * Legal edges. Every failure state has an edge back to the entry state of the
 * stage that failed and nowhere else — that is what "retry one stage" means, and
 * it is why a failed curation can never skip forward to publishing.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<PipelineState, readonly PipelineState[]>> = Object.freeze({
	CREATED: ["COLLECTING", "CURATING"],
	COLLECTING: ["COLLECTED", "COLLECTION_FAILED"],
	COLLECTED: ["CURATING"],
	CURATING: ["MATERIALS_READY", "CURATION_FAILED"],
	MATERIALS_READY: ["WRITING"],
	WRITING: ["DRAFT_READY", "EDITOR_FAILED"],
	DRAFT_READY: ["VALIDATING"],
	VALIDATING: ["PUBLISHED", "VALIDATION_FAILED"],
	// Terminal. A new day, or a new run, starts at CREATED.
	PUBLISHED: [],
	COLLECTION_FAILED: ["COLLECTING"],
	CURATION_FAILED: ["CURATING"],
	// A rejected draft is rewritten by a fresh editor session; validation is not
	// retried against the same draft, because the draft is what was wrong.
	EDITOR_FAILED: ["WRITING"],
	VALIDATION_FAILED: ["WRITING", "VALIDATING"],
});

export function isLegalTransition(from: PipelineState, to: PipelineState): boolean {
	return LEGAL_TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
	override name = "IllegalTransitionError";
	constructor(from: PipelineState, to: PipelineState) {
		super(
			`Illegal run transition ${from} -> ${to}. Legal from ${from}: ${
				LEGAL_TRANSITIONS[from].join(", ") || "(none; terminal)"
			}`,
		);
	}
}

export function assertTransition(from: PipelineState, to: PipelineState): void {
	if (!isLegalTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/*
 * migration 002 widened `daily_runs_status_check` to accept every pipeline
 * state (plus PUBLISHED and the back-compat COMPLETED), so `PipelineState`
 * is persisted to `daily_runs.status` verbatim — no lossy mapping, and
 * `/admin/runs` reads the real state directly.
 */

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

export type PipelineStage = "collect" | "curate" | "write" | "validate" | "publish";

export interface DailyRunOptions {
	sql: Sql;
	date: string;
	lineage?: string;
	/** Resume an existing run instead of creating one. */
	runId?: string;
	/** Run exactly one stage of an existing run, reading everything else from the store. */
	stage?: PipelineStage;
	/** Skip collection entirely (a resumed run whose collection already finished). */
	skipCollection?: boolean;
	now?: () => Date;
	chain?: readonly ModelSpec[];
	driverFactory?: AgentDriverFactory;
	skillsRoot: string;
	/** Sandbox cwd for the agent sessions. */
	cwd: string;
	/** Inclusive lower bound for incremental collection; defaults to the day's start. */
	since?: Date;
	/**
	 * Narrows what collection does. Production leaves this unset and gets the
	 * real registry; a test passes fake collectors so no provider is ever called.
	 */
	collection?: {
		entries?: readonly RegistryEntry[];
		enabledSourceKeys?: readonly string[];
		secrets?: SecretAccess;
		fetchImpl?: typeof globalThis.fetch;
		concurrency?: number;
	};
	/** Enables the curator's `search_web` tool for this run only. */
	research?: CuratorResearchConfig;
	log?: (msg: string, fields?: Record<string, unknown>) => void;
	onEvent?: (event: Record<string, unknown>) => void;
}

export interface DailyRunResult {
	runId: string;
	state: PipelineState;
	/** One or more collectors failed; the run is still publishable. */
	degraded: boolean;
	/** Human-readable reason(s), mirrors `daily_runs.degraded_reason`; unset when healthy. */
	degradedReason?: string;
	collection?: CollectionSummary;
	materials?: DailyMaterials;
	brief?: DailyBrief;
	markdown?: string;
	signalsWritten: number;
	attempts: number;
	fallbackOccurred: boolean;
}

interface RunRecorder {
	state: PipelineState;
	transition(to: PipelineState, patch?: Partial<RunState>): Promise<void>;
	patch(patch: Partial<RunState>): Promise<void>;
}

function createRecorder(
	sql: Sql,
	lineage: string,
	seed: RunState,
	initial: PipelineState,
	now: () => Date,
	onEvent?: (event: Record<string, unknown>) => void,
): RunRecorder {
	let current = { ...seed };
	let state = initial;
	const write = async () => {
		await upsertRun(sql, { ...current, status: state, updatedAt: now().toISOString() }, lineage);
	};
	return {
		get state() {
			return state;
		},
		async transition(to, patch) {
			assertTransition(state, to);
			state = to;
			if (patch) current = { ...current, ...patch };
			await write();
			onEvent?.({ kind: "state", runId: current.runId, state: to });
		},
		async patch(patch) {
			current = { ...current, ...patch };
			await write();
		},
	};
}

/** The most recent published brief strictly before `date`, for "what changed". */
async function findPreviousBrief(
	sql: Sql,
	lineage: string,
	date: string,
): Promise<DailyBrief | undefined> {
	const latest = await latestBriefDate(sql, lineage);
	if (!latest || latest >= date) return undefined;
	return getBrief(sql, lineage, latest);
}

interface DraftRow {
	body: unknown;
	validation_status: string;
}

/**
 * Latest editor draft for the day. Drafts are append-only history, so the
 * highest draft_no is the one validation and publishing act on; reading it is
 * what lets `--stage validate` and `--stage publish` run without another editor
 * session.
 */
async function loadLatestDraft(
	sql: Sql,
	lineage: string,
	date: string,
): Promise<{ brief: DailyBrief; validated: boolean } | undefined> {
	const rows = await sql<DraftRow[]>`
		select body, validation_status from daily_brief_drafts
		where lineage = ${lineage} and date = ${date}
		order by draft_no desc limit 1
	`;
	const row = rows[0];
	if (!row) return undefined;
	return { brief: DailyBriefSchema.parse(row.body), validated: row.validation_status === "PASSED" };
}

async function loadKnownSignals(sql: Sql, lineage: string): Promise<KnownSignal[]> {
	const signals = await listSignals(sql, lineage);
	return signals.map((s) => ({
		signalId: s.signalId,
		label: s.label,
		state: s.state,
		confidence: s.confidence,
		storyIds: s.storyIds,
		firstSeenAt: s.firstSeenAt,
		lastSeenAt: s.lastSeenAt,
	}));
}

/**
 * One production day, end to end, resumable at stage granularity.
 *
 * Each stage reads its input from the store rather than from the previous
 * stage's memory, which is the whole point: a curator crash is retried with a
 * curator session, never with another pass over eleven providers.
 */
export async function runDailyPipeline(options: DailyRunOptions): Promise<DailyRunResult> {
	const now = options.now ?? (() => new Date());
	const lineage = options.lineage ?? process.env["DI_LINEAGE"] ?? "default";
	const log = options.log ?? (() => {});
	const chain = options.chain ?? MODEL_CHAIN;
	const driverFactory = options.driverFactory ?? createPiAgentDriver;
	const stage = options.stage;

	const existing = options.runId ? await getRun(options.sql, options.runId) : undefined;
	if (options.runId && !existing) throw new Error(`Run "${options.runId}" not found`);

	const createdAt = existing?.createdAt ?? now().toISOString();
	const seed: RunState = existing ?? {
		runId: randomUUID(),
		date: options.date,
		status: "CREATED",
		createdAt,
		updatedAt: createdAt,
		totalItems: 0,
		processedItems: 0,
		storyCount: 0,
	};
	const recorder = createRecorder(options.sql, lineage, seed, "CREATED", now, options.onEvent);
	if (!existing) await recorder.patch({});

	const repo = new PostgresStoryRepository(options.sql, lineage);
	let degraded = existing?.degradedReason !== undefined;
	// Human-readable reasons accumulate across the run — a collector outage and
	// a search_web fallback can both degrade the same day. Joined into the
	// single `degraded_reason` column an operator reads on /admin/runs.
	const degradedReasons: string[] = existing?.degradedReason ? [existing.degradedReason] : [];
	const addDegradedReason = async (reason: string): Promise<void> => {
		degraded = true;
		degradedReasons.push(reason);
		await recorder.patch({ degradedReason: degradedReasons.join(" | ") });
	};
	let attempts = 0;
	let fallbackOccurred = false;
	const routerState = new RouterState();
	// runStageWithFallback records attempts synchronously; the DB write is queued
	// and drained after the stage so no insert outlives the run.
	const attemptWrites: Promise<void>[] = [];
	const recordStageAttempt = (attempt: Parameters<typeof recordAttempt>[2]): void => {
		attempts += 1;
		if (attempt.fallbackReason) fallbackOccurred = true;
		attemptWrites.push(recordAttempt(options.sql, seed.runId, attempt));
	};
	const drainAttempts = async (): Promise<void> => {
		await Promise.allSettled(attemptWrites.splice(0, attemptWrites.length));
	};

	const result: DailyRunResult = {
		runId: seed.runId,
		state: "CREATED",
		degraded,
		signalsWritten: 0,
		attempts: 0,
		fallbackOccurred: false,
	};

	// ---- Collection -------------------------------------------------------
	const wantsCollection = stage === undefined || stage === "collect";
	if (wantsCollection && !options.skipCollection) {
		await recorder.transition("COLLECTING");
		try {
			const summary = await runCollectionForDay({
				store: createPostgresCollectionStore(options.sql, lineage),
				since: options.since ?? new Date(`${options.date}T00:00:00.000Z`),
				now,
				runId: seed.runId,
				log,
				...(options.collection ?? {}),
			});
			result.collection = summary;
			if (summary.degraded) {
				const failedReasons = summary.outcomes
					.filter((o) => o.health === "FAILED")
					.map((o) => `${o.collectorId} unavailable: ${o.error ?? "unknown error"}`);
				if (summary.silentCollectors.length > 0) {
					// Healthy and returned nothing, from sources that normally return
					// something. Not a failure on its own -- an incremental collector
					// can be legitimately quiet in a narrow window -- but it belongs on
					// the run an operator reads rather than only in the collector's row.
					failedReasons.push(`no items from ${summary.silentCollectors.join(", ")}`);
				}
				await addDegradedReason(failedReasons.join("; ") || summary.suspiciousReason || "one or more collectors failed");
			}
			/*
			 * A run that collected nothing at all cannot produce a brief, and the
			 * previous condition only caught it when something had also FAILED --
			 * so the failure modes that leave every collector reporting success
			 * with an empty hand (an expired token answering 200 [], everything
			 * 304, a watermark stuck ahead of now) walked straight through into an
			 * empty manifest. `suspiciousReason` is set by the collection layer,
			 * which knows which sources are allowed to be quiet.
			 */
			if (summary.suspiciousReason !== undefined) {
				await recorder.transition("COLLECTION_FAILED", { failureReason: summary.suspiciousReason });
				result.state = "COLLECTION_FAILED";
				result.degraded = true;
				result.degradedReason = degradedReasons.join(" | ") || undefined;
				return result;
			}
			await recorder.transition("COLLECTED");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await addDegradedReason(`collection crashed: ${message}`);
			await recorder.transition("COLLECTION_FAILED", { failureReason: message });
			result.state = "COLLECTION_FAILED";
			result.degraded = true;
			result.degradedReason = degradedReasons.join(" | ") || undefined;
			return result;
		}
		if (stage === "collect") {
			result.state = "COLLECTED";
			result.degraded = degraded;
			result.degradedReason = degradedReasons.join(" | ") || undefined;
			return result;
		}
	}

	const manifest: DailyManifest = await buildManifestFromDb({
		sql: options.sql,
		lineage,
		date: options.date,
		now,
	});
	await recorder.patch({ totalItems: manifest.items.length });

	// ---- Curation ---------------------------------------------------------
	const wantsCuration = stage === undefined || stage === "curate";
	let materials = await getMaterials(options.sql, lineage, options.date);
	if (wantsCuration && (stage === "curate" || !materials)) {
		await recorder.transition("CURATING");
		const startedAt = now();
		await startAgentRun(options.sql, seed.runId, "CURATOR", startedAt.toISOString());
		// Registered for this run only; an eval, gold or offline run leaves it
		// unset and its curator never sees a network tool.
		configureCuratorResearch(
			options.research
				? {
						...options.research,
						onDegraded: (reason) => {
							void addDegradedReason(reason);
							options.research?.onDegraded?.(reason);
						},
					}
				: undefined,
		);
		try {
			const curated = await runStageWithFallback({
				stage: "CURATOR",
				chain,
				routerState,
				recordAttempt: recordStageAttempt,
				now,
				onAttempt: async ({ spec, mode, checkFault }) => {
					log("curator attempt", { model: modelKey(spec), mode });
					return runCuratorStage({
						date: options.date,
						manifest,
						repo,
						spec,
						skillsRoot: options.skillsRoot,
						cwd: options.cwd,
						driverFactory,
						mode: mode === "FRESH" ? "RESUME" : mode,
						now,
						...(options.onEvent ? { onEvent: options.onEvent } : {}),
						checkFault,
					});
				},
			});
			await drainAttempts();
			materials = curated.materials;
			await saveMaterials(options.sql, lineage, materials, seed.runId);
			await finishAgentRun(options.sql, seed.runId, "CURATOR", {
				status: "SUCCESS",
				finishedAt: now().toISOString(),
				durationMs: now().getTime() - startedAt.getTime(),
			});
			await recorder.patch({
				processedItems: (await repo.processedItemIds(options.date)).size,
				storyCount: (await repo.listStories(options.date)).length,
			});
			await recorder.transition("MATERIALS_READY");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await drainAttempts();
			await finishAgentRun(options.sql, seed.runId, "CURATOR", {
				status: "FAILED",
				finishedAt: now().toISOString(),
				durationMs: now().getTime() - startedAt.getTime(),
			});
			await recorder.transition("CURATION_FAILED", { failureReason: message });
			result.state = "CURATION_FAILED";
			result.degraded = degraded;
			result.degradedReason = degradedReasons.join(" | ") || undefined;
			result.attempts = attempts;
			return result;
		} finally {
			configureCuratorResearch(undefined);
		}
		if (stage === "curate") {
			result.state = "MATERIALS_READY";
			result.materials = materials;
			result.degraded = degraded;
			result.degradedReason = degradedReasons.join(" | ") || undefined;
			result.attempts = attempts;
			return result;
		}
	}

	if (!materials) {
		throw new Error(`No materials stored for ${options.date}; run the curate stage first`);
	}
	result.materials = materials;

	// ---- Writing ----------------------------------------------------------
	const wantsWriting = stage === undefined || stage === "write";
	let draft = await loadLatestDraft(options.sql, lineage, options.date);
	if (wantsWriting || !draft) {
		if (recorder.state !== "MATERIALS_READY") {
			// Resuming straight into the editor: the materials are already durable,
			// so the run walks the legal edges to WRITING without redoing curation.
			await recorder.transition("CURATING");
			await recorder.transition("MATERIALS_READY");
		}
		await recorder.transition("WRITING");
		const startedAt = now();
		await startAgentRun(options.sql, seed.runId, "EDITOR", startedAt.toISOString());
		const previousBrief = await findPreviousBrief(options.sql, lineage, options.date);
		try {
			const written = await runStageWithFallback({
				stage: "EDITOR",
				chain,
				routerState,
				recordAttempt: recordStageAttempt,
				now,
				onAttempt: async ({ spec, mode, checkFault }) => {
					log("editor attempt", { model: modelKey(spec), mode });
					return runEditorStage({
						date: options.date,
						manifest,
						materials: materials!,
						repo,
						...(previousBrief ? { previousBrief } : {}),
						spec,
						skillsRoot: options.skillsRoot,
						cwd: options.cwd,
						driverFactory,
						mode,
						now,
						...(options.onEvent ? { onEvent: options.onEvent } : {}),
						checkFault,
					});
				},
			});
			await drainAttempts();
			await finishAgentRun(options.sql, seed.runId, "EDITOR", {
				status: "SUCCESS",
				finishedAt: now().toISOString(),
				durationMs: now().getTime() - startedAt.getTime(),
			});
			draft = { brief: written.brief, validated: false };
			await saveDraft(options.sql, lineage, options.date, written.brief, {
				producedAt: written.brief.producedAt,
				runId: seed.runId,
				validationStatus: "PENDING",
			});
			await recorder.transition("DRAFT_READY");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await drainAttempts();
			await finishAgentRun(options.sql, seed.runId, "EDITOR", {
				status: "FAILED",
				finishedAt: now().toISOString(),
				durationMs: now().getTime() - startedAt.getTime(),
			});
			await recorder.transition("EDITOR_FAILED", { failureReason: message });
			result.state = "EDITOR_FAILED";
			result.degraded = degraded;
			result.degradedReason = degradedReasons.join(" | ") || undefined;
			result.attempts = attempts;
			return result;
		}
	} else if (recorder.state !== "DRAFT_READY") {
		await recorder.transition("CURATING");
		await recorder.transition("MATERIALS_READY");
		await recorder.transition("WRITING");
		await recorder.transition("DRAFT_READY");
	}

	const brief = draft.brief;
	result.brief = brief;

	// ---- Validation (the trust boundary) ----------------------------------
	await recorder.transition("VALIDATING");
	const validation = validateBrief(
		{
			stories: brief.stories,
			emergingSignals: brief.emergingSignals,
			dailyAnalysis: brief.dailyAnalysis,
			watchNext: brief.watchNext,
		},
		{ manifest, materials },
	);
	await saveDraft(options.sql, lineage, options.date, brief, {
		producedAt: brief.producedAt,
		runId: seed.runId,
		validationStatus: validation.ok ? "PASSED" : "FAILED",
		validationErrors: validation.ok ? [] : validation.errors,
	});
	if (!validation.ok) {
		await recorder.transition("VALIDATION_FAILED", { failureReason: validation.errors.join("; ") });
		result.state = "VALIDATION_FAILED";
		result.degraded = degraded;
		result.degradedReason = degradedReasons.join(" | ") || undefined;
		result.attempts = attempts;
		return result;
	}

	// ---- Publish ----------------------------------------------------------
	// Only reached with a validated brief: publishing is what makes the brief
	// visible, so an unvalidated draft must never get here.
	await saveBrief(options.sql, lineage, brief, seed.runId);

	const known = await loadKnownSignals(options.sql, lineage);
	const observedAt = now().toISOString();
	const { observed, faded } = reconcileSignals(
		brief.emergingSignals.map((s) => ({ label: s.label, rationale: s.body, storyIds: s.storyIds })),
		known,
		observedAt,
	);
	for (const update of [...observed, ...faded]) {
		await observeSignal(options.sql, lineage, {
			signalId: update.signalId,
			label: update.label,
			rationale: update.rationale,
			state: update.state,
			confidence: update.confidence,
			storyIds: update.storyIds,
			observedAt: update.observedAt,
		});
	}

	await recorder.transition("PUBLISHED");
	result.state = "PUBLISHED";
	result.degraded = degraded;
	result.degradedReason = degradedReasons.join(" | ") || undefined;
	result.attempts = attempts;
	result.fallbackOccurred = fallbackOccurred;
	result.signalsWritten = observed.length + faded.length;
	result.markdown = renderBriefMarkdown(brief, { facts: manifest.facts, items: manifest.items });
	return result;
}
