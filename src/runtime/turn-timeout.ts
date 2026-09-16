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
 * Thrown when a turn outran its bound AND did not stop when aborted.
 *
 * This is a different fact from a timeout and needs a different answer. A turn
 * that timed out and then stopped is safe to replace: whatever it wrote, it
 * wrote before the replacement read anything. A turn that is still running is
 * not, because the two sessions would share one durable state -- the old one's
 * in-flight `record_item_decisions` landing after the new one has already taken
 * its unseen snapshot, so the replacement works from a set that was stale the
 * moment it was read.
 *
 * Both repositories upsert by item id, so the visible cost is a stale row
 * rather than corruption. That is not the standard: two curator sessions
 * writing the same day concurrently is not an acceptable execution semantic
 * whatever the write layer happens to tolerate. So this is terminal -- no
 * retry, no continuation, no fallback, because every one of those would start
 * the overlapping session this exists to prevent.
 *
 * Extends {@link TurnTimeoutError} because it *is* a timeout, plus one further
 * fact. Anything that only wants to know "did this turn overrun" keeps working,
 * and the classifier still reads it as TIMEOUT; the callers that must treat it
 * differently test for this class first, which is a narrowing rather than a
 * separate path they could forget to handle.
 */
export class TurnAbandonedError extends TurnTimeoutError {
	/*
	 * `name` is deliberately NOT overridden. The classifier reads `TimeoutError`
	 * and maps it to the TIMEOUT failure class, and an abandoned turn is a
	 * timeout for classification purposes -- renaming it sent it to the UNKNOWN
	 * path and it came back out as NETWORK. Everything that needs to treat this
	 * case differently matches on the class, not on the name or the message.
	 */
	constructor(stage: string, timeoutMs: number, graceMs: number) {
		super(stage, timeoutMs);
		this.message =
			`${stage} turn exceeded ${Math.round(timeoutMs / 1000)}s and did not stop within ` +
			`${Math.round(graceMs / 1000)}s of being aborted; refusing to start an overlapping session`;
	}
}

export function isTurnAbandoned(err: unknown): err is TurnAbandonedError {
	return err instanceof TurnAbandonedError;
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
	// Whether the turn has actually finished, either way. This is the difference
	// between "timed out" and "still running", and the caller must be able to
	// tell them apart before it starts a replacement session.
	let settled = false;
	// Held so the losing side of the race can still be awaited on timeout.
	const running = run().then(
		() => {
			settled = true;
		},
		(err: unknown) => {
			settled = true;
			throw err;
		},
	);
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
			// The grace period expired and the turn is still going. Escalate: the
			// caller must not replace a session that has not stopped.
			if (!settled) throw new TurnAbandonedError(stage, timeoutMs, abortGraceMs);
		}
		throw err;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (graceTimer !== undefined) clearTimeout(graceTimer);
	}
}
