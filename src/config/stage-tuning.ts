import { loadConfig } from "./loader.ts";

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
 * Reads the stage block, falling back to the code defaults if it is absent.
 *
 * A config that cannot be read is the config loader's problem to report on its
 * own terms; the stages are tuning, not correctness, so an unreadable config
 * must not be the reason a fixture run refuses to start.
 */
export function loadStageTuning(root?: string): StageTuning | undefined {
	try {
		return (root === undefined ? loadConfig() : loadConfig(root)).agent.stages;
	} catch {
		return undefined;
	}
}
