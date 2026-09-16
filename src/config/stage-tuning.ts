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
 * Sized against the turn clock, and against the SLOW end of it rather than the
 * middle. Measured over the six bounded turns of the 2026-09-16 recovery:
 *
 *   unit  decisions  duration  s/decision  ended by
 *   1     100        233s      2.33        work unit
 *   2     100        300s      3.00        the clock
 *   3     100        195s      1.95        work unit
 *   4      50        300s      6.00        the clock
 *   5     100        240s      2.40        work unit
 *   6      87        300s      3.45        the clock
 *
 * p50 2.40 s/decision, p90 3.45, max 6.00 -- a threefold spread, and three of
 * the six turns ended on the clock rather than on the ceiling. 100 was sized
 * from the p50 of an earlier run, and sizing from the middle of a distribution
 * this wide is exactly what produced those three timeouts.
 *
 * So: 50, from p90. 50 x 3.45s = 172s, 57% of the 300s clock, and it still
 * fits at the observed maximum. Two further reasons not to round it up. Unit 2
 * exhausted its budget and *still* ran to the clock, so the ceiling is not
 * instantaneous -- the model needs room to wind down after `list_unseen_items`
 * reports the turn complete. And a turn that ends on the clock costs the abort
 * grace period and re-establishes context in a fresh session, so the timeout
 * path is more expensive per decision than the yield path, not less.
 *
 * The real fix is a time-aware budget -- yield at elapsed >= 60% of timeoutMs,
 * with the count as a backstop -- because no fixed count can hold a time budget
 * across a 3x rate spread. That is a backlog item, not this change.
 */
const CURATOR_WORK_UNIT = 50;

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
