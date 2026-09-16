import { loadConfig } from "./loader.ts";
import { createLogger } from "../runtime/logger.ts";

/**
 * Per-stage bounds from `config/agent.yaml`: how long one model turn may take,
 * how many attempts one model gets, and how many times a stage may nudge a
 * model that has not submitted yet.
 *
 * These exist because an unbounded stage is not a slow run, it is a hung one:
 * the editor once spent 114 minutes on a single attempt without any stage being
 * considered failed, because `timeoutMs` was declared in the config and read by
 * nobody.
 */
export interface StageBounds {
	timeoutMs: number;
	maxAttemptsPerModel: number;
	maxNudges: number;
	/** Decisions one attempt may record before yielding; undefined means unbounded. */
	maxDecisionsPerTurn?: number;
	maxContinuations?: number;
	maxStageWallClockMs?: number;
}

export interface StageTuning {
	CURATOR: StageBounds;
	EDITOR: StageBounds;
}

/**
 * The values shipped in `config/agent.yaml`. These two must stay in agreement:
 * the config file is what an operator edits, and this is what a run falls back
 * to when the config cannot be read at all. `tests/stage-tuning.test.ts`
 * enforces the agreement so the pair cannot drift silently.
 */
/**
 * The curator's work unit, in decisions per attempt.
 *
 * Sized against the turn clock rather than against "how much can we fit". The
 * 2026-09-16 run measured 50 decisions per ~75s (21 pages, median 75s), so a
 * page costs about 75s of a 300s turn. The rule this follows is that a work
 * unit should target 60-70% of `timeoutMs`, leaving the rest as margin for the
 * story work that happens alongside the paging -- upsert_story, find_history,
 * search_items -- and for a page that runs slow.
 *
 * Two pages: 2 x 75s = 150s, 50% of the clock. Three pages would be 225s, or
 * 75%, which is over the target and makes every turn a race between a clean
 * yield and an abort; four pages is the whole clock, which is how the run
 * failed in the first place. The aim is not maximum throughput per session --
 * it is a turn that ends predictably, on a page boundary, without the timeout
 * ever being the thing that ends it. Raise it only if telemetry shows pages
 * completing well under 75s.
 */
const CURATOR_WORK_UNIT = 100;

export const DEFAULT_STAGE_TUNING: StageTuning = Object.freeze({
	CURATOR: {
		timeoutMs: 300_000,
		maxAttemptsPerModel: 4,
		maxNudges: 3,
		maxDecisionsPerTurn: CURATOR_WORK_UNIT,
	},
	EDITOR: { timeoutMs: 300_000, maxAttemptsPerModel: 4, maxNudges: 3 },
});

const log = createLogger("stage-tuning");

/**
 * Reads the stage block, falling back to {@link DEFAULT_STAGE_TUNING} if the
 * config cannot be read.
 *
 * It never returns undefined, and that is the whole point. `loadConfig()`
 * eagerly parses five files, including gitignored `*.local.yaml` overrides, so
 * a typo in any one of them used to leave every call site spreading nothing and
 * `timeoutMs` unset — which is exactly the unbounded turn that produced the
 * 114-minute editor attempt. `maxNudges` is tuning; `timeoutMs` is correctness,
 * and correctness does not get to be absent. The swallowed error is logged so
 * the degradation is visible rather than silent.
 */
/**
 * Fills the optional bounds from the built-in defaults.
 *
 * The same argument as the catch block below, one level down. `agent.yaml` is a
 * file operators edit and `*.local.yaml` overrides it outright, so a config
 * written before `maxDecisionsPerTurn` existed parses perfectly and leaves it
 * undefined -- which means an unbounded curator turn, the exact failure this
 * field was added to prevent. A newly optional bound must default to the safe
 * value, not to "off".
 */
function withDefaults(stages: StageTuning): StageTuning {
	const merge = (name: keyof StageTuning): StageBounds => ({
		...DEFAULT_STAGE_TUNING[name],
		...stages[name],
	});
	return { CURATOR: merge("CURATOR"), EDITOR: merge("EDITOR") };
}

export function loadStageTuning(root?: string): StageTuning {
	try {
		return withDefaults((root === undefined ? loadConfig() : loadConfig(root)).agent.stages);
	} catch (err) {
		log.warn("config unreadable; using built-in stage bounds", {
			error: err instanceof Error ? err.message : String(err),
		});
		return DEFAULT_STAGE_TUNING;
	}
}
