import { describe, expect, it } from "vitest";
import { renderTurnHeadroom } from "../src/observation/render.ts";
import type { TurnHeadroomRow } from "../src/observation/queries.ts";

/*
 * Two failures look identical in the attempt counts and call for opposite
 * fixes, and telling them apart is the only reason this report exists.
 *
 * A stage whose successful attempts finish near the limit is mis-sized: the
 * work unit is scoped against the budget rather than inside it, and the next
 * heavy day drops attempts that were always going to be marginal. Raising the
 * limit or shrinking the unit is the lever.
 *
 * A stage with room to spare that still timed out had a provider stall. Raising
 * the limit there only makes the stall cost more before the fallback fires.
 */
function row(over: Partial<TurnHeadroomRow> = {}): TurnHeadroomRow {
	return {
		date: "2026-09-22",
		stage: "CURATOR",
		completed: 10,
		slowestCompletedSecs: 300,
		medianCompletedSecs: 212,
		timedOut: 2,
		timedOutSecs: 600,
		wastedTokens: 262_897,
		totalTokens: 2_489_848,
		...over,
	};
}

describe("renderTurnHeadroom", () => {
	it("reports headroom against the configured limit, not a constant", () => {
		const out = renderTurnHeadroom([row({ slowestCompletedSecs: 150 })], 300);
		expect(out).toContain("limit 300s");
		// 150 of 300 leaves half the budget unused.
		expect(out).toContain("50%");
	});

	it("calls a stage mis-sized when its successes crowd the limit", () => {
		// The production shape on 2026-09-22: the slowest attempt that actually
		// finished used the entire 300s budget.
		const out = renderTurnHeadroom([row()], 300);
		expect(out).toContain("0%");
		expect(out).toMatch(/sized against the limit/);
		expect(out).not.toMatch(/provider stall/);
	});

	it("calls it a provider stall when a timeout happens with room to spare", () => {
		const out = renderTurnHeadroom(
			[row({ slowestCompletedSecs: 120, medianCompletedSecs: 90, timedOut: 1 })],
			300,
		);
		expect(out).toMatch(/provider stall/);
		expect(out).not.toMatch(/sized against the limit/);
	});

	it("says nothing about either when a day ran clean with room", () => {
		// 2026-09-20: slowest curator attempt 174s of 300s, no timeouts.
		const out = renderTurnHeadroom(
			[row({ slowestCompletedSecs: 174, medianCompletedSecs: 144, timedOut: 0, timedOutSecs: 0, wastedTokens: 0 })],
			300,
		);
		expect(out).not.toMatch(/sized against the limit/);
		expect(out).not.toMatch(/provider stall/);
		expect(out).toContain("0 (0%)");
	});

	it("states the wasted share, because a timeout discards everything it produced", () => {
		const out = renderTurnHeadroom(
			[row({ stage: "EDITOR", completed: 2, slowestCompletedSecs: 272, timedOut: 1, timedOutSecs: 300, wastedTokens: 189_848, totalTokens: 377_776 })],
			300,
		);
		expect(out).toContain("189,848 (50%)");
	});

	it("does not divide by zero on a day with no reported tokens", () => {
		const out = renderTurnHeadroom([row({ wastedTokens: 0, totalTokens: 0 })], 300);
		expect(out).toContain("0");
		expect(out).not.toContain("NaN");
	});

	it("says so plainly when there is nothing to report", () => {
		expect(renderTurnHeadroom([], 300)).toContain("No attempts recorded.");
	});
});
