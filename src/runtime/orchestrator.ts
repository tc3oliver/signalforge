import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DailyBrief, DailyManifest, DailyMaterials } from "../schemas/index.ts";
import { DailyManifest as DailyManifestSchema } from "../schemas/index.ts";
import { JsonStoryRepository } from "../stories/json-repository.ts";
import { runCuratorStage } from "../curator/session.ts";
import { runEditorStage } from "../editor/session.ts";
import { renderBriefMarkdown } from "../renderer/markdown.ts";
import { validateBrief } from "../validator/brief-validator.ts";
import { MODEL_CHAIN, modelKey, type ModelSpec } from "./model-config.ts";
import { RouterState, runStageWithFallback } from "./model-router.ts";
import { RunStateStore } from "./run-state.ts";
import { readJson, readJsonIfExists, writeJsonAtomic, writeTextAtomic } from "./atomic-json.ts";
import { createPiAgentDriver, type AgentDriverFactory } from "./agent-driver.ts";
import { createLogger } from "./logger.ts";
import { loadStageTuning, type StageTuning } from "../config/stage-tuning.ts";

export interface Phase1Paths {
	root: string;
	fixturesDir: string;
	ledgerDir: string;
	runsDir: string;
	skillsRoot: string;
	goldDir: string;
}

/**
 * An experiment is an independent lineage: its own runs and, crucially, its own story
 * ledger. Cross-day continuity lives inside one experiment and never leaks between
 * them, which is what makes repeated runs over the same fixture comparable — a second
 * run that inherited the first one's ledger would see nothing unseen and would be
 * scoring the first run's work.
 */
export function resolvePaths(root: string, experiment?: string): Phase1Paths {
	const runsRoot = experiment ? join(root, "experiments", experiment) : join(root, "runs");
	return {
		root,
		fixturesDir: join(root, "fixtures", "generated"),
		ledgerDir: join(runsRoot, "_ledger"),
		runsDir: runsRoot,
		skillsRoot: join(root, "agent", "skills"),
		goldDir: join(root, "eval", "gold"),
	};
}

export function loadManifest(paths: Phase1Paths, date: string): DailyManifest {
	const raw = readJson<unknown>(join(paths.fixturesDir, date, "manifest.json"));
	return DailyManifestSchema.parse(raw);
}

export interface StageOutcome {
	materials?: DailyMaterials;
	brief?: DailyBrief;
}

export interface Phase1RunOptions {
	date: string;
	paths: Phase1Paths;
	chain?: readonly ModelSpec[];
	driverFactory?: AgentDriverFactory;
	now?: () => Date;
	/** Skip the editor stage; used by `phase1:curate`. */
	curateOnly?: boolean;
	/** Reuse an existing run directory instead of creating one (resume). */
	runId?: string;
	/**
	 * Per-stage timeouts and attempt ceilings. Defaults to `config/agent.yaml`,
	 * the same source the production pipeline reads, so a fixture or eval run is
	 * bounded by the same numbers a real day is. Without this nothing passed
	 * `timeoutMs` to either stage and a stuck model hung the run indefinitely.
	 */
	stages?: StageTuning;
}

export interface Phase1RunResult {
	runId: string;
	runDir: string;
	materials: DailyMaterials;
	brief?: DailyBrief;
	fallbackOccurred: boolean;
	attempts: number;
	editorRejectedSubmissions: number;
}

/**
 * One day, end to end: curator -> materials -> fresh editor session -> brief ->
 * validation -> rendered markdown. Every durable artifact is written under the run
 * directory as it is produced, so a crash leaves a run that can be inspected.
 */
export async function runPhase1Day(opts: Phase1RunOptions): Promise<Phase1RunResult> {
	const now = opts.now ?? (() => new Date());
	const chain = opts.chain ?? MODEL_CHAIN;
	const driverFactory = opts.driverFactory ?? createPiAgentDriver;
	const stages = opts.stages ?? loadStageTuning();
	const log = createLogger("phase1");

	const manifest = loadManifest(opts.paths, opts.date);

	// The ledger is keyed by date and shared across runs, which is what lets a
	// fallback model resume mid-run and what lets tomorrow read today's history.
	// A fresh run of a date must therefore clear that date first, or the curator
	// would open with zero unseen items and submit the previous run's work —
	// which would silently invalidate any cross-model comparison. Earlier dates
	// are never touched: they are the history.
	if (!opts.runId) {
		rmSync(join(opts.paths.ledgerDir, opts.date), { recursive: true, force: true });
	}
	const repo = new JsonStoryRepository(opts.paths.ledgerDir);
	const store = opts.runId
		? RunStateStore.open({ root: opts.paths.runsDir, date: opts.date, runId: opts.runId, now })
		: RunStateStore.create({ root: opts.paths.runsDir, date: opts.date, now });
	const runDir = store.dir;

	store.patch({ totalItems: manifest.items.length });
	writeJsonAtomic(join(runDir, "manifest.json"), manifest);

	const routerState = new RouterState();
	const onEvent = (event: Record<string, unknown>) =>
		store.appendEvent({ kind: String(event["kind"] ?? "stage"), ...event });

	let fallbackOccurred = false;
	let attempts = 0;

	// ---- Curator ----------------------------------------------------------
	store.transition("CURATING");
	const curatorResult = await runStageWithFallback({
		stage: "CURATOR",
		chain,
		...(stages ? { maxAttemptsPerModel: stages.CURATOR.maxAttemptsPerModel } : {}),
		routerState,
		recordAttempt: (a) => {
			attempts += 1;
			if (a.fallbackReason) fallbackOccurred = true;
			store.appendAttempt(a);
		},
		now,
		onAttempt: async ({ spec, mode, checkFault, lastError }) => {
			log.info("curator attempt", { model: modelKey(spec), mode });
			return runCuratorStage({
				...(stages ? { maxNudges: stages.CURATOR.maxNudges, timeoutMs: stages.CURATOR.timeoutMs } : {}),
				...(lastError === undefined ? {} : { lastError }),
				date: opts.date,
				manifest,
				repo,
				spec,
				skillsRoot: opts.paths.skillsRoot,
				cwd: runDir,
				driverFactory,
				// A fresh model always resumes from durable state rather than replaying
				// the day: decisions and stories already recorded stay recorded.
				mode: mode === "FRESH" ? "RESUME" : mode,
				now,
				onEvent,
				checkFault,
			});
		},
	}).catch((err) => {
		store.patch({ failureReason: err instanceof Error ? err.message : String(err) });
		store.transition("CURATION_FAILED");
		throw err;
	});

	const materials = curatorResult.materials;
	writeJsonAtomic(join(runDir, "materials.json"), materials);
	writeJsonAtomic(join(runDir, "item-decisions.json"), await repo.listDecisions(opts.date));
	writeJsonAtomic(join(runDir, "story-ledger.json"), await repo.listStories(opts.date));
	store.patch({
		processedItems: (await repo.processedItemIds(opts.date)).size,
		storyCount: (await repo.listStories(opts.date)).length,
	});
	store.transition("MATERIALS_READY");
	writeJsonAtomic(join(runDir, "restricted-runtime.json"), {
		curatorActiveTools: curatorResult.activeToolNames,
	});

	if (opts.curateOnly) {
		return {
			runId: store.runId,
			runDir,
			materials,
			fallbackOccurred,
			attempts,
			editorRejectedSubmissions: 0,
		};
	}

	// ---- Editor (a completely separate session) ---------------------------
	const previousBrief = findPreviousBrief(opts.paths, opts.date);
	store.transition("WRITING");
	const editorResult = await runStageWithFallback({
		stage: "EDITOR",
		chain,
		...(stages ? { maxAttemptsPerModel: stages.EDITOR.maxAttemptsPerModel } : {}),
		routerState,
		recordAttempt: (a) => {
			attempts += 1;
			if (a.fallbackReason) fallbackOccurred = true;
			store.appendAttempt(a);
		},
		now,
		onAttempt: async ({ spec, mode, checkFault, lastError }) => {
			log.info("editor attempt", { model: modelKey(spec), mode });
			return runEditorStage({
				...(stages ? { maxNudges: stages.EDITOR.maxNudges, timeoutMs: stages.EDITOR.timeoutMs } : {}),
				...(lastError === undefined ? {} : { lastError }),
				date: opts.date,
				manifest,
				materials,
				repo,
				previousBrief,
				spec,
				skillsRoot: opts.paths.skillsRoot,
				cwd: runDir,
				driverFactory,
				mode,
				now,
				onEvent,
				checkFault,
			});
		},
	}).catch((err) => {
		store.patch({ failureReason: err instanceof Error ? err.message : String(err) });
		store.transition("EDITOR_FAILED");
		throw err;
	});

	const brief = editorResult.brief;
	writeJsonAtomic(join(runDir, "brief.json"), brief);
	store.transition("DRAFT_READY");

	// ---- Validation (the trust boundary) ----------------------------------
	store.transition("VALIDATING");
	const validation = validateBrief(
		{
			stories: brief.stories,
			emergingSignals: brief.emergingSignals,
			dailyAnalysis: brief.dailyAnalysis,
			watchNext: brief.watchNext,
		},
		{ manifest, materials },
	);
	writeJsonAtomic(join(runDir, "validation.json"), validation);
	if (!validation.ok) {
		store.patch({ failureReason: validation.errors.join("; ") });
		store.transition("VALIDATION_FAILED");
		throw new Error(`Brief failed post-submit validation: ${validation.errors.join("; ")}`);
	}

	writeTextAtomic(
		join(runDir, "brief.md"),
		renderBriefMarkdown(brief, { facts: manifest.facts, items: manifest.items }),
	);
	writeJsonAtomic(join(runDir, "restricted-runtime.json"), {
		curatorActiveTools: curatorResult.activeToolNames,
		editorActiveTools: editorResult.activeToolNames,
	});
	store.transition("COMPLETED");

	return {
		runId: store.runId,
		runDir,
		materials,
		brief,
		fallbackOccurred,
		attempts,
		editorRejectedSubmissions: editorResult.rejectedSubmissions,
	};
}

/** The most recent completed brief before `date`, used for "what changed". */
function findPreviousBrief(paths: Phase1Paths, date: string): DailyBrief | undefined {
	if (!existsSync(paths.runsDir)) return undefined;
	const dates = readdirSync(paths.runsDir)
		.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < date)
		.sort()
		.reverse();
	for (const d of dates) {
		const dayDir = join(paths.runsDir, d);
		const runs = readdirSync(dayDir).sort().reverse();
		for (const runId of runs) {
			const brief = readJsonIfExists<DailyBrief>(join(dayDir, runId, "brief.json"));
			if (brief) return brief;
		}
	}
	return undefined;
}
