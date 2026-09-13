import { describe, expect, it } from "vitest";
import {
	type HealthOutcome,
	type HealthState,
	isSuccessfulRun,
	nextHealthState,
} from "../src/db/collector-health.ts";

const T1 = "2026-09-10T06:00:00.000Z";
const T2 = "2026-09-11T06:00:00.000Z";
const T3 = "2026-09-12T06:00:00.000Z";

const fresh: HealthState = {
	lastHealth: undefined,
	lastRunAt: undefined,
	lastSuccessAt: undefined,
	lastFailureAt: undefined,
	consecutiveFailures: 0,
	lastError: undefined,
};

function run(health: HealthOutcome["health"], finishedAt: string, error?: string): HealthOutcome {
	return { health, finishedAt, ...(error === undefined ? {} : { error }) };
}

describe("isSuccessfulRun", () => {
	it("counts a healthy run that fetched nothing as a success", () => {
		// FRED on a day with no new observations is doing its job, not failing.
		expect(isSuccessfulRun(run("OK", T1))).toBe(true);
	});

	it("does not count DEGRADED as a success", () => {
		expect(isSuccessfulRun(run("DEGRADED", T1))).toBe(false);
	});
});

describe("nextHealthState", () => {
	it("records the success and keeps the counter at zero", () => {
		const next = nextHealthState(fresh, run("OK", T1));
		expect(next).toEqual({
			lastHealth: "OK", lastRunAt: T1, lastSuccessAt: T1,
			lastFailureAt: undefined, consecutiveFailures: 0, lastError: undefined,
		});
	});

	it("increments and records the reason on FAILED", () => {
		const next = nextHealthState(fresh, run("FAILED", T1, "429 from upstream"));
		expect(next.consecutiveFailures).toBe(1);
		expect(next.lastFailureAt).toBe(T1);
		expect(next.lastSuccessAt).toBeUndefined();
		expect(next.lastError).toBe("429 from upstream");
	});

	it("escalates a permanently DEGRADED collector instead of resetting it", () => {
		let state = fresh;
		for (const at of [T1, T2, T3]) state = nextHealthState(state, run("DEGRADED", at, "partial"));
		expect(state.consecutiveFailures).toBe(3);
		expect(state.lastFailureAt).toBe(T3);
	});

	it("does not let a DEGRADED run wipe a failure streak", () => {
		const failed = nextHealthState(nextHealthState(fresh, run("FAILED", T1)), run("FAILED", T2));
		expect(failed.consecutiveFailures).toBe(2);
		expect(nextHealthState(failed, run("DEGRADED", T3)).consecutiveFailures).toBe(3);
	});

	it("resets only on a genuine success and clears the stale error", () => {
		let state = fresh;
		for (const at of [T1, T2]) state = nextHealthState(state, run("FAILED", at, "timeout"));
		const recovered = nextHealthState(state, run("OK", T3));
		expect(recovered.consecutiveFailures).toBe(0);
		expect(recovered.lastError).toBeUndefined();
		expect(recovered.lastSuccessAt).toBe(T3);
		// The failure history survives the recovery; it is not washed away.
		expect(recovered.lastFailureAt).toBe(T2);
	});

	it("keeps the previous reason when a failing run reports no text", () => {
		const first = nextHealthState(fresh, run("FAILED", T1, "connection refused"));
		expect(nextHealthState(first, run("FAILED", T2)).lastError).toBe("connection refused");
	});

	it("treats DISABLED as neither success nor failure", () => {
		const failed = nextHealthState(fresh, run("FAILED", T1, "boom"));
		const disabled = nextHealthState(failed, run("DISABLED", T2));
		expect(disabled.consecutiveFailures).toBe(1);
		expect(disabled.lastHealth).toBe("DISABLED");
		expect(disabled.lastRunAt).toBe(T2);
		expect(disabled.lastFailureAt).toBe(T1);
		expect(disabled.lastError).toBe("boom");
	});

	it("moves last_run_at on every run, success or not", () => {
		const ok = nextHealthState(fresh, run("OK", T1));
		expect(nextHealthState(ok, run("FAILED", T2, "x")).lastRunAt).toBe(T2);
	});
});
