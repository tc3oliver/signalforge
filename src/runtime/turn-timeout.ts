import type { AgentDriver } from "./agent-driver.ts";

/*
 * A bound on one model turn.
 *
 * `config/agent.yaml` has carried `timeoutMs` per stage since the pipeline was
 * written and nothing read it, so nothing limited how long a single turn could
 * take. On 2026-09-13 the editor spent 114 minutes across six turns of 14 to 21
 * minutes each -- the tool calls between them took seconds -- and the run was
 * never in a failed state, just a slow one, so no fallback ever triggered.
 *
 * The timeout is per turn rather than per stage on purpose: a stage that makes
 * steady progress across many turns is healthy however long it runs, while a
 * single turn that stops producing anything is not.
 */

/** Thrown when a turn outruns its bound. Named so the classifier reads it as TIMEOUT. */
export class TurnTimeoutError extends Error {
	override name = "TimeoutError";
	constructor(stage: string, timeoutMs: number) {
		super(`${stage} turn exceeded ${Math.round(timeoutMs / 1000)}s without completing`);
	}
}

/**
 * Runs one turn under `timeoutMs`, aborting the session if it overruns.
 *
 * The abort is best effort: it asks the agent session to stop and is not
 * awaited past its own failure, because the caller is already unwinding toward
 * the router, which will retry or fall back. Leaving the turn running while
 * reporting a timeout would be worse than a noisy abort.
 */
export async function withTurnTimeout(
	driver: AgentDriver,
	stage: string,
	timeoutMs: number | undefined,
	run: () => Promise<void>,
): Promise<void> {
	if (timeoutMs === undefined || timeoutMs <= 0) return await run();

	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			run(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new TurnTimeoutError(stage, timeoutMs)), timeoutMs);
			}),
		]);
	} catch (err) {
		if (err instanceof TurnTimeoutError) {
			await driver.abort?.().catch(() => {});
		}
		throw err;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
