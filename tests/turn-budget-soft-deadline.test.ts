import { describe, expect, it } from "vitest";
import {
	DEFAULT_SOFT_DEADLINE_FRACTION,
	TurnBudget,
} from "../src/runtime/progress-yield.ts";

/*
 * The 2026-09-18 tuning, pinned.
 *
 * That run sized its work unit by decision count alone. Measured over its 26
 * bounded turns: p50 2.50 s/decision, p90 3.96, max 6.00. A unit of 50 therefore
 * took 125s at p50 against a 300s clock -- 24 of 26 turns left more than half the
 * clock unused -- while two turns still ran past it and ended on the timeout,
 * which costs the abort grace period and a fresh session's context.
 *
 * No fixed count holds a time budget across a 2.4x rate spread. These tests fix
 * the property that makes both ends safe: the count bounds the fast case, the
 * clock bounds the slow one, and NEITHER aborts a turn -- both only make the
 * budget report exhausted, so the yield still happens at a tool boundary.
 */

/** A clock the test drives by hand; no timers, no sleeping. */
function fakeClock(start = 1_000) {
	let t = start;
	return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("TurnBudget soft deadline", () => {
	it("closes the unit on the count when decisions are fast", () => {
		const clock = fakeClock();
		const budget = new TurnBudget(50, { softDeadlineMs: 180_000, now: clock.now });

		// 50 decisions in 100s: the fast case, well inside the clock.
		budget.spend(50);
		clock.advance(100_000);

		expect(budget.exhausted).toBe(true);
		expect(budget.closedBy).toBe("COUNT");
	});

	it("closes the unit on the clock when decisions are slow", () => {
		const clock = fakeClock();
		const budget = new TurnBudget(50, { softDeadlineMs: 180_000, now: clock.now });

		// 30 of 50 decisions at the observed maximum of 6.00 s/decision. Under the
		// old count-only bound this turn ran on to the 300s timeout and was
		// aborted; now it stops with 20 decisions of budget left.
		budget.spend(30);
		clock.advance(180_000);

		expect(budget.exhausted).toBe(true);
		expect(budget.closedBy).toBe("TIME");
		expect(budget.remaining).toBe(20);
	});

	it("reports the count in preference to the clock when both are spent", () => {
		const clock = fakeClock();
		const budget = new TurnBudget(50, { softDeadlineMs: 180_000, now: clock.now });
		budget.spend(50);
		clock.advance(180_000);

		// The count is the bound an operator set directly, so it is the one named.
		expect(budget.closedBy).toBe("COUNT");
	});

	it("is not exhausted while both bounds have room", () => {
		const clock = fakeClock();
		const budget = new TurnBudget(50, { softDeadlineMs: 180_000, now: clock.now });
		budget.spend(49);
		clock.advance(179_999);

		expect(budget.exhausted).toBe(false);
		expect(budget.closedBy).toBeUndefined();
	});

	it("keeps the pre-2026-09-18 count-only behaviour when no deadline is given", () => {
		// Every eval, gold and fixture run constructs the budget without a deadline
		// (and most without a budget at all). Time must not close their units, or a
		// slow CI machine would change the shape of a fixture's output.
		const clock = fakeClock();
		const budget = new TurnBudget(50, { now: clock.now });

		clock.advance(86_400_000);
		expect(budget.timeExhausted).toBe(false);
		expect(budget.exhausted).toBe(false);

		budget.spend(50);
		expect(budget.closedBy).toBe("COUNT");
	});

	it("derives 180s from the shipped 300s turn timeout", () => {
		// Pinned because the soft deadline is only safe while it is strictly
		// shorter than the hard timeout: a deadline at or past it would never fire
		// and the slow case would go back to being aborted.
		const timeoutMs = 300_000;
		const soft = Math.floor(timeoutMs * DEFAULT_SOFT_DEADLINE_FRACTION);

		expect(soft).toBe(180_000);
		expect(soft).toBeLessThan(timeoutMs);
	});

	it("counts elapsed time from construction, not from first spend", () => {
		// The unit's clock is the turn's clock. A model that spends its first 60s
		// reading history before recording anything has spent 60s of the unit.
		const clock = fakeClock();
		const budget = new TurnBudget(50, { softDeadlineMs: 180_000, now: clock.now });

		clock.advance(180_000);
		expect(budget.spent).toBe(0);
		expect(budget.exhausted).toBe(true);
		expect(budget.closedBy).toBe("TIME");
	});
});
