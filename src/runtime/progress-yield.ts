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
	/**
	 * Which bound closed a WORK_UNIT_COMPLETE: the decision count or the soft
	 * time budget. Absent on a TURN_TIMEOUT_WITH_PROGRESS, which by definition
	 * was closed by neither.
	 *
	 * Recorded because the two are tuned against each other and a yield that
	 * does not say which one fired makes that untunable: a day where every unit
	 * closes on TIME wants a larger count, and one where every unit closes on
	 * COUNT well inside the clock wants a larger unit.
	 */
	closedBy?: "COUNT" | "TIME";
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
 * How much of the turn clock a work unit may occupy before it stops asking for
 * more work. Expressed as a fraction of `timeoutMs` rather than a duration so
 * the two cannot drift apart when the timeout is retuned.
 *
 * 0.6 leaves 40% of the clock for the model to wind down after the tools stop
 * offering work -- which is not instantaneous, and is why a unit sized to fit
 * "on average" still ran to the clock on 2026-09-16.
 */
export const DEFAULT_SOFT_DEADLINE_FRACTION = 0.6;

export interface TurnBudgetOptions {
	/**
	 * Wall-clock budget for the unit, from construction. Once elapsed, the budget
	 * reports exhausted even with decisions left, so the unit closes at the next
	 * tool boundary instead of being aborted mid-flight by the turn timeout.
	 */
	softDeadlineMs?: number;
	/** Injectable clock; defaults to `Date.now`. */
	now?: () => number;
}

/**
 * The per-turn work ceiling: a decision count, and optionally a soft time budget.
 *
 * Deliberately NOT the turn timeout. Using the timeout as the yield mechanism
 * would mean every normal turn ends by being aborted mid-flight, which is both
 * slower (the abort grace period, every turn) and less safe: a turn killed at an
 * arbitrary point can have a `record_item_decisions` in flight, whereas a turn
 * that stops because the tools stopped offering it work ends at a tool boundary
 * with the durable state consistent by construction.
 *
 * The soft deadline preserves exactly that property. It does not abort anything;
 * it only makes `exhausted` true early, and the yield still happens where it
 * always did -- when `list_unseen_items` declines to hand out more work.
 *
 * It exists because no fixed count can hold a time budget across the observed
 * rate spread. On 2026-09-18 the curator ran 2.50 s/decision at p50 and 6.00 at
 * the maximum: a unit of 50 took 125s at p50 (42% of a 300s clock, so 24 of 26
 * units left more than half the clock unused) and still ran past it twice. The
 * count now bounds the fast case and the clock bounds the slow one.
 */
export class TurnBudget {
	readonly limit: number;
	readonly softDeadlineMs: number | undefined;
	readonly #now: () => number;
	readonly #startedAt: number;
	#spent = 0;

	constructor(limit: number, options: TurnBudgetOptions = {}) {
		this.limit = limit;
		this.softDeadlineMs = options.softDeadlineMs;
		this.#now = options.now ?? (() => Date.now());
		this.#startedAt = this.#now();
	}

	get spent(): number {
		return this.#spent;
	}

	get elapsedMs(): number {
		return this.#now() - this.#startedAt;
	}

	/** True once the count is spent. Kept separate so a yield can say which bound fired. */
	get countExhausted(): boolean {
		return this.#spent >= this.limit;
	}

	/** True once the soft deadline has passed. Always false when none is configured. */
	get timeExhausted(): boolean {
		return this.softDeadlineMs !== undefined && this.elapsedMs >= this.softDeadlineMs;
	}

	get exhausted(): boolean {
		return this.countExhausted || this.timeExhausted;
	}

	/**
	 * Which bound closed the unit, or undefined if neither has. The count is
	 * reported in preference to the clock when both are spent: it is the bound
	 * the operator set directly.
	 */
	get closedBy(): "COUNT" | "TIME" | undefined {
		if (this.countExhausted) return "COUNT";
		if (this.timeExhausted) return "TIME";
		return undefined;
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
