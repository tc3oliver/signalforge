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
export interface StageTuning {
	CURATOR: { timeoutMs: number; maxAttemptsPerModel: number; maxNudges: number };
	EDITOR: { timeoutMs: number; maxAttemptsPerModel: number; maxNudges: number };
}

/**
 * The values shipped in `config/agent.yaml`. These two must stay in agreement:
 * the config file is what an operator edits, and this is what a run falls back
 * to when the config cannot be read at all. `tests/stage-tuning.test.ts`
 * enforces the agreement so the pair cannot drift silently.
 */
export const DEFAULT_STAGE_TUNING: StageTuning = Object.freeze({
	CURATOR: { timeoutMs: 300_000, maxAttemptsPerModel: 4, maxNudges: 3 },
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
export function loadStageTuning(root?: string): StageTuning {
	try {
		return (root === undefined ? loadConfig() : loadConfig(root)).agent.stages;
	} catch (err) {
		log.warn("config unreadable; using built-in stage bounds", {
			error: err instanceof Error ? err.message : String(err),
		});
		return DEFAULT_STAGE_TUNING;
	}
}
