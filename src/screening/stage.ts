import { randomUUID } from "node:crypto";
import type { InterestsConfig, ScreeningConfig } from "../config/schema.ts";
import { resolveSecret } from "../config/secrets.ts";
import type { Sql } from "../db/client.ts";
import { finishAgentRun, recordAttempt, startAgentRun } from "../db/runs.ts";
import { loadRoutedDropItemIds, saveScreening, screenedItemIds } from "../db/screening.ts";
import type { DailyManifest } from "../schemas/index.ts";
import { screenItems } from "./screener.ts";
import { isAuditSampled, type ScreeningInput, type ScreeningVerdict } from "./types.ts";

/*
 * The screening stage as the pipeline runs it: which items to screen, what to
 * persist, what to withhold, and how to say what happened. The model call
 * itself is in screener.ts; this file owns the semantics around it.
 */

export interface ScreeningStageOptions {
	sql: Sql;
	lineage: string;
	date: string;
	/**
	 * The daily run this pass belongs to. Absent for a backfill (`pnpm screen`),
	 * which has no run row to hang telemetry on and reports usage to its caller
	 * instead.
	 */
	runId?: string;
	manifest: DailyManifest;
	config: ScreeningConfig;
	interests: InterestsConfig;
	/**
	 * Forces shadow semantics regardless of `config.mode`: nothing is marked
	 * routed. The backfill uses this so replaying the screener over a past day
	 * can never retroactively withhold anything.
	 */
	forceShadow?: boolean;
	/** Only screen items that carry no verdict from this (model, policy) yet. Default true. */
	incremental?: boolean;
	now?: () => Date;
	log?: (msg: string, fields?: Record<string, unknown>) => void;
	/** Test seam; defaults to global fetch. */
	fetchImpl?: typeof fetch;
}

export interface ScreeningStageOutcome {
	/** "shadow" or "route": what this pass actually did, after trust checks. */
	effectiveMode: "shadow" | "route";
	/** Items withheld from the Curator's default scan. Empty unless effectiveMode is route. */
	screenedOutItemIds: ReadonlySet<string>;
	screened: number;
	unscreened: number;
	tally: Record<ScreeningVerdict, number>;
	auditSampled: number;
	batchesOk: number;
	batchesFailed: number;
	durationMs: number;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; reportedBy: number };
	/** Reasons the run should be marked degraded, if any. Empty in a healthy shadow pass. */
	degradedReasons: string[];
}

/**
 * Whether route mode may actually withhold anything with this configuration.
 *
 * Route needs the configured screener to BE the trusted one. A config that
 * bumps `policyVersion` or `model` without also updating `routing.trusted*`
 * has changed the thing that was measured, and the new version screens in
 * shadow until it has been measured itself. This is the evidence epoch rule,
 * enforced by configuration shape rather than by remembering to do it.
 */
export function routingIsTrusted(config: ScreeningConfig): { ok: true } | { ok: false; why: string } {
	if (config.mode !== "route") return { ok: false, why: `mode is ${config.mode}` };
	if (!config.routing) return { ok: false, why: "no routing.trustedModel / trustedPolicyVersion configured" };
	if (config.routing.trustedModel !== config.model) {
		return { ok: false, why: `configured model ${config.model} is not the trusted ${config.routing.trustedModel}` };
	}
	if (config.routing.trustedPolicyVersion !== config.policyVersion) {
		return {
			ok: false,
			why: `configured policyVersion ${config.policyVersion} is not the trusted ${config.routing.trustedPolicyVersion}`,
		};
	}
	return { ok: true };
}

/** The per-source scan hint; the same projection the Curator's scan view uses. */
export function screeningHint(item: DailyManifest["items"][number]): string | undefined {
	const m = item.metadata;
	switch (item.sourceType) {
		case "github": {
			const parts = [m["repo"], m["kind"], m["tag"], m["prerelease"] === true ? "prerelease" : undefined];
			const hint = parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" ");
			return hint || undefined;
		}
		case "hackernews":
			return typeof m["score"] === "number" ? `score ${m["score"]}` : undefined;
		case "arxiv":
			return Array.isArray(m["categories"]) ? (m["categories"] as unknown[]).slice(0, 4).join(",") : undefined;
		default:
			return undefined;
	}
}

function toScreeningInput(item: DailyManifest["items"][number], includeHint: boolean): ScreeningInput {
	const hint = includeHint ? screeningHint(item) : undefined;
	return {
		id: item.id,
		sourceType: item.sourceType,
		sourceName: item.sourceName,
		title: item.title,
		summary: item.summary,
		...(hint ? { hint } : {}),
	};
}

/**
 * Runs one screening pass over the manifest and returns the workset it
 * produced. Never throws: every failure is a logged, fail-open outcome.
 */
export async function runScreeningStage(opts: ScreeningStageOptions): Promise<ScreeningStageOutcome> {
	const now = opts.now ?? (() => new Date());
	const log = opts.log ?? (() => {});
	const { config } = opts;
	const startedAt = now();

	const trust = routingIsTrusted(config);
	const effectiveMode: "shadow" | "route" = !opts.forceShadow && trust.ok ? "route" : "shadow";
	const degradedReasons: string[] = [];
	if (config.mode === "route" && !trust.ok) {
		degradedReasons.push(
			`screening: route mode requested but not trusted (${trust.why}); screened in shadow, full Curator coverage`,
		);
	}

	const empty = (): ScreeningStageOutcome => ({
		effectiveMode,
		screenedOutItemIds: new Set(),
		screened: 0,
		unscreened: opts.manifest.items.length,
		tally: { DROP: 0, KEEP: 0, UNSURE: 0 },
		auditSampled: 0,
		batchesOk: 0,
		batchesFailed: 0,
		durationMs: now().getTime() - startedAt.getTime(),
		degradedReasons,
	});

	if (opts.runId) {
		await startAgentRun(opts.sql, opts.runId, "SCREENER", startedAt.toISOString());
	}

	const attemptId = randomUUID();
	const finishTelemetry = async (
		status: "SUCCESS" | "FAILED",
		meta: Record<string, unknown>,
		usage?: ScreeningStageOutcome["usage"],
	): Promise<void> => {
		if (!opts.runId) return;
		const finishedAt = now();
		const durationMs = finishedAt.getTime() - startedAt.getTime();
		await recordAttempt(opts.sql, opts.runId, {
			attemptId,
			stage: "SCREENER",
			provider: config.provider,
			model: config.model,
			startedAt: startedAt.toISOString(),
			finishedAt: finishedAt.toISOString(),
			durationMs,
			status,
			errorMeta: { policyVersion: config.policyVersion, effectiveMode, ...meta },
			...(usage ? { tokenUsage: usage } : {}),
		});
		await finishAgentRun(opts.sql, opts.runId, "SCREENER", {
			status,
			finishedAt: finishedAt.toISOString(),
			durationMs,
			provider: config.provider,
			model: config.model,
		});
	};

	try {
		const apiKey = await resolveSecret(config.apiKeySecret);

		const already =
			opts.incremental === false
				? new Set<string>()
				: await screenedItemIds(opts.sql, {
						lineage: opts.lineage,
						date: opts.date,
						model: config.model,
						policyVersion: config.policyVersion,
					});
		/*
		 * Mechanical KEEPs first, with no model call.
		 *
		 * Every GitHub item comes from a repository on the reader's watchlist --
		 * the collector polls nothing else -- so "is this worth the Curator's
		 * attention?" is already answered by configuration. On 2026-09-17 the v2
		 * policy dropped three sst/opencode issues that the Curator had built a
		 * Must Know story from; no prompt wording should be able to do that to a
		 * watched repository. Recorded as a KEEP row whose reason says it was
		 * decided by rule, so the report does not count it as the model's opinion.
		 */
		const pending = opts.manifest.items.filter((i) => !already.has(i.id));
		const mechanical = pending
			.filter((i) => i.sourceType === "github")
			.map((i) => ({
				itemId: i.id,
				verdict: "KEEP" as const,
				reasonCode: "WATCHED_ENTITY" as const,
				reason: "deterministic: the GitHub collector only polls watched repositories",
			}));
		const toScreen = pending
			.filter((i) => i.sourceType !== "github")
			.map((i) => toScreeningInput(i, config.includeHint));

		const outcome = await screenItems(toScreen, {
			config,
			apiKey,
			interests: opts.interests,
			log: (msg, fields) => log(msg, fields ?? {}),
			now: () => now().getTime(),
			...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
		});

		const tally: Record<ScreeningVerdict, number> = { DROP: 0, KEEP: 0, UNSURE: 0 };
		let auditSampled = 0;
		const rows = [...mechanical, ...outcome.decisions].map((d) => {
			tally[d.verdict] += 1;
			const sampled =
				d.verdict === "DROP" &&
				isAuditSampled({ date: opts.date, itemId: d.itemId, policyVersion: config.policyVersion }, config.auditDropSampleRate);
			if (sampled) auditSampled += 1;
			return {
				...d,
				auditSampled: sampled,
				// Only a DROP that was not audit-sampled, in a trusted route pass,
				// withholds anything. Recorded on the row so the observation report
				// can tell "was withheld and rescued" from "was offered and judged".
				routed: effectiveMode === "route" && d.verdict === "DROP" && !sampled,
			};
		});

		await saveScreening(
			opts.sql,
			{
				lineage: opts.lineage,
				date: opts.date,
				provider: config.provider,
				model: config.model,
				policyVersion: config.policyVersion,
				...(opts.runId ? { runId: opts.runId } : {}),
			},
			rows,
		);

		/*
		 * Read back from the table rather than from this pass's rows, so a resumed
		 * run whose earlier attempt already screened the day gets the same workset.
		 */
		const screenedOutItemIds =
			effectiveMode === "route" && config.routing
				? await loadRoutedDropItemIds(opts.sql, {
						lineage: opts.lineage,
						date: opts.date,
						trustedModel: config.routing.trustedModel,
						trustedPolicyVersion: config.routing.trustedPolicyVersion,
					})
				: new Set<string>();

		if (outcome.batchesFailed > 0 && effectiveMode === "route") {
			degradedReasons.push(
				`screening: ${outcome.batchesFailed} batch(es) failed, ${outcome.unscreened.length} item(s) unscreened and offered to the Curator`,
			);
		}

		const usage = outcome.usage;
		const meta = {
			manifestItems: opts.manifest.items.length,
			alreadyScreened: already.size,
			mechanicalKeep: mechanical.length,
			screened: outcome.decisions.length,
			unscreened: outcome.unscreened.length,
			batchesOk: outcome.batchesOk,
			batchesFailed: outcome.batchesFailed,
			auditSampled,
			withheld: screenedOutItemIds.size,
			...tally,
		};
		await finishTelemetry(outcome.batchesOk > 0 || toScreen.length === 0 ? "SUCCESS" : "FAILED", meta, usage);
		log(`screening recorded (${effectiveMode})`, {
			model: config.model,
			policyVersion: config.policyVersion,
			durationMs: outcome.durationMs,
			...meta,
			usage: usage ?? "unavailable",
		});

		return {
			effectiveMode,
			screenedOutItemIds,
			screened: outcome.decisions.length + mechanical.length,
			unscreened: outcome.unscreened.length,
			tally,
			auditSampled,
			batchesOk: outcome.batchesOk,
			batchesFailed: outcome.batchesFailed,
			durationMs: outcome.durationMs,
			...(usage ? { usage } : {}),
			degradedReasons,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log("screening skipped", { error: message, effectiveMode });
		if (effectiveMode === "route") {
			degradedReasons.push(`screening failed (${message}); run reverted to full Curator coverage`);
		}
		await finishTelemetry("FAILED", { error: message }).catch(() => undefined);
		return empty();
	}
}
