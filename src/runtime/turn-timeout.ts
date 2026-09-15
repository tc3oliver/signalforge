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
 * How long to wait for an aborted turn to actually stop before giving up on it.
 *
 * Short, because this is pure delay on a run that has already failed; long
 * enough that a tool call in flight when the abort landed gets to finish.
 */
const ABORT_GRACE_MS = 5_000;

/**
 * Runs one turn under `timeoutMs`, aborting the session if it overruns.
 *
 * After the abort, the turn is awaited rather than discarded. `Promise.race`
 * abandons the losing promise but does not stop it, so the timed-out turn kept
 * running while the router opened its replacement: a `record_item_decisions`
 * still in flight could land after the new session had already read the decided
 * set, and the replacement would work from a snapshot that was stale the moment
 * it was taken. Both repositories upsert by item id, so the cost was a stale row
 * rather than corruption -- but "probably harmless" is not the same as knowing
 * the previous turn is done.
 *
 * The wait is bounded. If the session does not stop within the grace period the
 * caller still unwinds to the router, which is the old behaviour; the difference
 * is that it is now a deadline rather than an assumption.
 */
export async function withTurnTimeout(
	driver: AgentDriver,
	stage: string,
	timeoutMs: number | undefined,
	run: () => Promise<void>,
	/** Overridable so a test need not spend the real grace period waiting. */
	abortGraceMs: number = ABORT_GRACE_MS,
): Promise<void> {
	if (timeoutMs === undefined || timeoutMs <= 0) return await run();

	let timer: ReturnType<typeof setTimeout> | undefined;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	// Held so the losing side of the race can still be awaited on timeout.
	const running = run();
	// The turn's own rejection is handled below; this keeps an overrun from
	// surfacing as an unhandled rejection while the timeout path unwinds.
	running.catch(() => {});
	try {
		await Promise.race([
			running,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new TurnTimeoutError(stage, timeoutMs)), timeoutMs);
			}),
		]);
	} catch (err) {
		if (err instanceof TurnTimeoutError) {
			await driver.abort?.().catch(() => {});
			await Promise.race([
				running.catch(() => {}),
				new Promise<void>((resolve) => {
					graceTimer = setTimeout(resolve, abortGraceMs);
				}),
			]);
		}
		throw err;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (graceTimer !== undefined) clearTimeout(graceTimer);
	}
}
