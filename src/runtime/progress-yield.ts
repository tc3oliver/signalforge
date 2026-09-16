/*
 * A turn that stopped because it ran out of budget, not because anything broke.
 *
 * The curator used to try to scan a whole day inside one model turn. On a
 * normal ~600-item day that fits inside the 300s turn bound; on 2026-09-16 the
 * manifest was 1626 items -- the morning run had died on a suspended database
 * and the 48h catch-up sweep re-offered everything it missed -- and it did not.
 * Measured from that run: 50 items per ~75s, so 1626 items needs ~41 minutes of
 * model time against a ceiling of six attempts x 5 minutes.
 *
 * What made that fatal rather than slow is the classification. Every one of the
 * six attempts was making steady progress and every one was recorded as FAILED
 * with failureClass TIMEOUT, which `decideAction` treats as a transient fault:
 * retry the model once, then fall back. Three models x two attempts burned the
 * whole chain in 28 minutes while decisions were being committed the entire
 * time. The run ended CURATION_FAILED with 1050 of 1626 items decided and no
 * model that had actually misbehaved.
 *
 * So "the work did not fit in one turn" is given its own signal. It is not a
 * FailureClass and deliberately does not live in that enum: a yield is the
 * expected end of a bounded work unit, it does not consume the model chain, and
 * the thing that bounds it is a stage-level ceiling rather than a provider
 * failure counter. The router answers it by starting a fresh session on the
 * same model, which resumes from durable state.
 */

/** Progress made by the turn that is yielding, as durable counts. */
export interface ProgressYieldInfo {
	/** Items with a recorded decision when the turn started. */
	decidedBefore: number;
	/** Items with a recorded decision when the turn yielded. */
	decidedAfter: number;
	/** Items in the manifest. */
	totalItems: number;
	/** Why the turn stopped: the work-unit ceiling, or the turn clock. */
	reason: "WORK_UNIT_COMPLETE" | "TURN_TIMEOUT_WITH_PROGRESS";
}

/**
 * Thrown by a stage when its turn ended with durable progress and work left.
 *
 * Not an Error subclass by convention only -- the router matches on the class,
 * never on the message, so a provider error whose text happens to mention
 * "yield" can never be mistaken for one of these.
 */
export class ProgressYieldError extends Error {
	override name = "ProgressYieldError";
	readonly info: ProgressYieldInfo;

	constructor(info: ProgressYieldInfo) {
		super(
			`turn yielded after ${info.decidedAfter - info.decidedBefore} decision(s) ` +
				`(${info.decidedAfter}/${info.totalItems} decided, ${info.reason})`,
		);
		this.info = info;
	}

	get decidedThisTurn(): number {
		return this.info.decidedAfter - this.info.decidedBefore;
	}
}

export function isProgressYield(err: unknown): err is ProgressYieldError {
	return err instanceof ProgressYieldError;
}

/**
 * The per-turn work ceiling.
 *
 * Deliberately an explicit counter rather than "however much fits before the
 * clock runs out". Using the timeout as the yield mechanism would mean every
 * normal turn ends by being aborted mid-flight, which is both slower (the abort
 * grace period, every turn) and less safe: a turn killed at an arbitrary point
 * can have a `record_item_decisions` in flight, whereas a turn that stops
 * because the tools stopped offering it work ends at a tool boundary with the
 * durable state consistent by construction.
 */
export class TurnBudget {
	readonly limit: number;
	#spent = 0;

	constructor(limit: number) {
		this.limit = limit;
	}

	get spent(): number {
		return this.#spent;
	}

	get exhausted(): boolean {
		return this.#spent >= this.limit;
	}

	get remaining(): number {
		return Math.max(0, this.limit - this.#spent);
	}

	spend(n: number): void {
		this.#spent += n;
	}

	reset(): void {
		this.#spent = 0;
	}
}
