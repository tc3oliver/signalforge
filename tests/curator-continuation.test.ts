import { describe, expect, it } from "vitest";
import { RouterState, runStageWithFallback, decideAction } from "../src/runtime/model-router.ts";
import { ContinuationLimitError } from "../src/runtime/model-router.ts";
import { ProgressYieldError, TurnBudget } from "../src/runtime/progress-yield.ts";
import { TurnAbandonedError, TurnTimeoutError } from "../src/runtime/turn-timeout.ts";
import type { AgentAttempt } from "../src/schemas/run.ts";
import type { ModelSpec } from "../src/runtime/model-config.ts";

/*
 * The 2026-09-16 regression, pinned.
 *
 * That run had 1626 items against a 300s turn bound. Every one of six attempts
 * committed decisions and every one was recorded FAILED/TIMEOUT, which
 * `decideAction` reads as a transient provider fault: retry once, then fall
 * back. Three models were exhausted in 28 minutes while all three were working
 * correctly, and the run ended CURATION_FAILED at 1050/1626.
 *
 * The distinction these tests defend is between "this model is broken" and
 * "this workload is bigger than one turn". Only the first may consume the chain.
 */

const CHAIN: ModelSpec[] = [
	{ provider: "p1", model: "m1" },
	{ provider: "p2", model: "m2" },
	{ provider: "p3", model: "m3" },
];

function yieldAt(decidedBefore: number, decidedAfter: number, totalItems = 1626): ProgressYieldError {
	return new ProgressYieldError({
		decidedBefore,
		decidedAfter,
		totalItems,
		reason: "WORK_UNIT_COMPLETE",
	});
}

describe("progress yields do not consume the model chain", () => {
	it("finishes a 1626-item backlog on the first model across bounded turns", async () => {
		// The exact shape of the failed run: a work unit of 150, so ~11 turns.
		const TOTAL = 1626;
		const UNIT = 150;
		const attempts: AgentAttempt[] = [];
		const modelsUsed: string[] = [];
		let decided = 0;

		const result = await runStageWithFallback<string>({
			stage: "CURATOR",
			chain: CHAIN,
			routerState: new RouterState(),
			recordAttempt: (a) => attempts.push(a),
			onAttempt: async ({ spec }) => {
				modelsUsed.push(spec.model);
				const before = decided;
				decided = Math.min(TOTAL, decided + UNIT);
				if (decided < TOTAL) throw yieldAt(before, decided, TOTAL);
				return "materials";
			},
		});

		expect(result).toBe("materials");
		expect(decided).toBe(TOTAL);
		// The whole point: one model, never a fallback.
		expect(new Set(modelsUsed)).toEqual(new Set(["m1"]));
		expect(attempts.filter((a) => a.status === "FAILED")).toHaveLength(0);
		expect(attempts.filter((a) => a.status === "YIELDED").length).toBeGreaterThanOrEqual(10);
		expect(attempts.filter((a) => a.status === "SUCCESS")).toHaveLength(1);
	});

	it("records a yield with no failureClass and no fallbackReason", async () => {
		const attempts: AgentAttempt[] = [];
		let n = 0;
		await runStageWithFallback<string>({
			stage: "CURATOR",
			chain: CHAIN,
			routerState: new RouterState(),
			recordAttempt: (a) => attempts.push(a),
			onAttempt: async () => {
				if (n++ === 0) throw yieldAt(0, 150);
				return "ok";
			},
		});
		const yielded = attempts.find((a) => a.status === "YIELDED");
		expect(yielded?.failureClass).toBeUndefined();
		expect(yielded?.fallbackReason).toBeUndefined();
		expect(yielded?.errorMeta?.["decidedThisTurn"]).toBe(150);
	});

	it("does not spend maxAttemptsPerModel on continuations", async () => {
		// maxAttemptsPerModel is 2 here; ten yields must still stay on m1.
		const modelsUsed: string[] = [];
		let n = 0;
		await runStageWithFallback<string>({
			stage: "CURATOR",
			chain: CHAIN,
			routerState: new RouterState(),
			maxAttemptsPerModel: 2,
			recordAttempt: () => {},
			onAttempt: async ({ spec }) => {
				modelsUsed.push(spec.model);
				if (n++ < 10) throw yieldAt(n * 150, (n + 1) * 150);
				return "ok";
			},
		});
		expect(new Set(modelsUsed)).toEqual(new Set(["m1"]));
	});

	it("resumes rather than restarting after a yield", async () => {
		const modes: string[] = [];
		let n = 0;
		await runStageWithFallback<string>({
			stage: "CURATOR",
			chain: CHAIN,
			routerState: new RouterState(),
			recordAttempt: () => {},
			onAttempt: async ({ mode }) => {
				modes.push(mode);
				if (n++ < 2) throw yieldAt(0, 150);
				return "ok";
			},
		});
		// First attempt is fresh; every continuation resumes from durable state, so
		// the next session never re-reads a day it has already half-scanned.
		expect(modes).toEqual(["FRESH", "RESUME", "RESUME"]);
	});

	it("reports per-turn throughput for every continuation", async () => {
		const seen: Array<{ continuation: number; decidedThisTurn: number }> = [];
		let n = 0;
		await runStageWithFallback<string>({
			stage: "CURATOR",
			chain: CHAIN,
			routerState: new RouterState(),
			recordAttempt: () => {},
			onContinue: (info) =>
				seen.push({ continuation: info.continuation, decidedThisTurn: info.decidedThisTurn }),
			onAttempt: async () => {
				if (n++ < 3) throw yieldAt(n * 100, n * 100 + 150);
				return "ok";
			},
		});
		expect(seen.map((s) => s.continuation)).toEqual([1, 2, 3]);
		expect(seen.every((s) => s.decidedThisTurn === 150)).toBe(true);
	});
});

describe("real failures still consume the chain", () => {
	it("falls back on a timeout that made no progress", async () => {
		const modelsUsed: string[] = [];
		const attempts: AgentAttempt[] = [];
		await expect(
			runStageWithFallback<string>({
				stage: "CURATOR",
				chain: CHAIN,
				routerState: new RouterState(),
				recordAttempt: (a) => attempts.push(a),
				onAttempt: async ({ spec }) => {
					modelsUsed.push(spec.model);
					throw new TurnTimeoutError("curator", 300_000);
				},
			}),
		).rejects.toThrow(/exceeded/);
		// One retry then fallback, per model: the pre-existing policy, unchanged.
		expect(modelsUsed).toEqual(["m1", "m1", "m2", "m2", "m3", "m3"]);
		expect(attempts.every((a) => a.status === "FAILED")).toBe(true);
		expect(attempts.every((a) => a.failureClass === "TIMEOUT")).toBe(true);
	});

	it("still falls back on a real provider failure between continuations", async () => {
		const modelsUsed: string[] = [];
		let n = 0;
		await runStageWithFallback<string>({
			stage: "CURATOR",
			chain: CHAIN,
			routerState: new RouterState(),
			recordAttempt: () => {},
			onAttempt: async ({ spec }) => {
				modelsUsed.push(spec.model);
				n++;
				if (n <= 2) throw yieldAt(n * 150, (n + 1) * 150);
				if (spec.model === "m1") throw new Error("503 Service Unavailable");
				return "ok";
			},
		});
		// Two clean continuations on m1, then a genuine failure moves off it.
		expect(modelsUsed.filter((m) => m === "m1").length).toBeGreaterThanOrEqual(3);
		expect(modelsUsed).toContain("m2");
	});

	it("leaves decideAction's existing policy untouched", () => {
		expect(decideAction("TIMEOUT", 1)).toEqual({ kind: "RETRY_SAME" });
		expect(decideAction("TIMEOUT", 2)).toEqual({ kind: "FALLBACK" });
		expect(decideAction("AUTH", 1)).toEqual({ kind: "FALLBACK" });
	});
});

describe("the continuation ceiling", () => {
	it("stops the stage rather than walking the chain", async () => {
		const modelsUsed: string[] = [];
		await expect(
			runStageWithFallback<string>({
				stage: "CURATOR",
				chain: CHAIN,
				routerState: new RouterState(),
				continuationBounds: { maxContinuations: 3 },
				recordAttempt: () => {},
				onAttempt: async ({ spec }) => {
					modelsUsed.push(spec.model);
					throw yieldAt(0, 150);
				},
			}),
		).rejects.toBeInstanceOf(ContinuationLimitError);
		// The same oversized workload would yield on every model, so trying the
		// others would burn the chain to learn nothing.
		expect(new Set(modelsUsed)).toEqual(new Set(["m1"]));
	});

	it("stops on the wall-clock ceiling", async () => {
		let t = 0;
		await expect(
			runStageWithFallback<string>({
				stage: "CURATOR",
				chain: CHAIN,
				routerState: new RouterState(),
				continuationBounds: { maxStageWallClockMs: 1_000 },
				now: () => new Date((t += 400)),
				recordAttempt: () => {},
				onAttempt: async () => {
					throw yieldAt(0, 150);
				},
			}),
		).rejects.toBeInstanceOf(ContinuationLimitError);
	});

	it("names how far it got, so the ceiling is diagnosable", async () => {
		const err = (await runStageWithFallback<string>({
			stage: "CURATOR",
			chain: CHAIN,
			routerState: new RouterState(),
			continuationBounds: { maxContinuations: 2 },
			recordAttempt: () => {},
			onAttempt: async () => {
				throw yieldAt(600, 750, 1626);
			},
		}).catch((e: unknown) => e)) as Error;
		expect(err.message).toContain("750/1626");
		expect(err.message).toContain("2 continuations");
	});

	it("does not bind before the manifest cap on any manifest the pipeline builds", async () => {
		/*
		 * The shipped bound is a runaway guard, not a budget, and it scales with
		 * the work unit rather than standing on its own. Halving the unit from 100
		 * to 50 left the old ceiling at exactly 2000 -- the manifest cap -- so a
		 * full-sized day would have failed the stage for being large rather than
		 * stuck, especially since a turn can decide fewer than its full budget.
		 *
		 * Two times the cap, so retuning either number keeps the headroom.
		 */
		const MANIFEST_CAP = 2000;
		const { DEFAULT_CONTINUATION_BOUNDS } = await import("../src/runtime/model-router.ts");
		const { DEFAULT_STAGE_TUNING } = await import("../src/config/stage-tuning.ts");
		const unit = DEFAULT_STAGE_TUNING.CURATOR.maxDecisionsPerTurn ?? 0;
		expect(DEFAULT_CONTINUATION_BOUNDS.maxContinuations * unit).toBeGreaterThanOrEqual(2 * MANIFEST_CAP);
	});
});

describe("TurnBudget", () => {
	it("is exhausted only once the limit is reached", () => {
		const budget = new TurnBudget(150);
		budget.spend(50);
		expect(budget.exhausted).toBe(false);
		expect(budget.remaining).toBe(100);
		budget.spend(100);
		expect(budget.exhausted).toBe(true);
	});

	it("stays exhausted when overspent by a full page", () => {
		const budget = new TurnBudget(150);
		budget.spend(200);
		expect(budget.exhausted).toBe(true);
		expect(budget.remaining).toBe(0);
	});
});

describe("ProgressYieldError", () => {
	it("reports what the turn actually committed", () => {
		const err = yieldAt(600, 750, 1626);
		expect(err.decidedThisTurn).toBe(150);
		expect(err.message).toContain("750/1626");
	});

	it("is not matched by message text", async () => {
		// The router matches on the class. A provider error that happens to mention
		// yielding must still be classified and must still consume the chain.
		const modelsUsed: string[] = [];
		await expect(
			runStageWithFallback<string>({
				stage: "CURATOR",
				chain: CHAIN,
				routerState: new RouterState(),
				recordAttempt: () => {},
				onAttempt: async ({ spec }) => {
					modelsUsed.push(spec.model);
					throw new Error("upstream asked the turn to yield");
				},
			}),
		).rejects.toThrow();
		expect(new Set(modelsUsed)).toEqual(new Set(["m1", "m2", "m3"]));
	});
});

describe("a session that will not stop is never replaced", () => {
	/*
	 * Correctness, not resilience. `withTurnTimeout` aborts an overrunning turn
	 * and waits a grace period for it to stop. If it has not stopped, the old
	 * session is still able to write -- an in-flight `record_item_decisions`
	 * landing after a replacement has taken its unseen snapshot, so the
	 * replacement works from a set that was stale when it was read. Both
	 * repositories upsert by item id, so the visible cost is a stale row rather
	 * than corruption; two curator sessions writing one day concurrently is still
	 * not an acceptable execution semantic.
	 */
	function abandoned(): TurnAbandonedError {
		return new TurnAbandonedError("curator", 300_000, 5_000);
	}

	it("does not retry, continue or fall back", async () => {
		const modelsUsed: string[] = [];
		await expect(
			runStageWithFallback<string>({
				stage: "CURATOR",
				chain: CHAIN,
				routerState: new RouterState(),
				recordAttempt: () => {},
				onAttempt: async ({ spec }) => {
					modelsUsed.push(spec.model);
					throw abandoned();
				},
			}),
		).rejects.toBeInstanceOf(TurnAbandonedError);
		// Exactly one attempt. Anything more would be the overlapping session.
		expect(modelsUsed).toEqual(["m1"]);
	});

	it("outranks a progress yield", async () => {
		// "It was making progress" is not a reason to run two of it.
		const modelsUsed: string[] = [];
		await expect(
			runStageWithFallback<string>({
				stage: "CURATOR",
				chain: CHAIN,
				routerState: new RouterState(),
				recordAttempt: () => {},
				onAttempt: async ({ spec }) => {
					modelsUsed.push(spec.model);
					throw abandoned();
				},
			}),
		).rejects.toThrow(/refusing to start an overlapping session/);
		expect(modelsUsed).toHaveLength(1);
	});

	it("records the attempt as failed and says why it is terminal", async () => {
		const attempts: AgentAttempt[] = [];
		await runStageWithFallback<string>({
			stage: "CURATOR",
			chain: CHAIN,
			routerState: new RouterState(),
			recordAttempt: (a) => attempts.push(a),
			onAttempt: async () => {
				throw abandoned();
			},
		}).catch(() => {});
		expect(attempts).toHaveLength(1);
		expect(attempts[0]?.status).toBe("FAILED");
		expect(String(attempts[0]?.errorMeta?.["terminal"])).toContain("no replacement started");
	});

	it("is still a timeout, so anything asking that question gets the right answer", () => {
		expect(abandoned()).toBeInstanceOf(TurnTimeoutError);
	});
});

describe("continuation telemetry is measured, never estimated", () => {
	it("reports seconds per decision from the clock and durable counts", async () => {
		let t = 0;
		let n = 0;
		const seen: Array<number | null> = [];
		await runStageWithFallback<string>({
			stage: "CURATOR",
			chain: CHAIN,
			routerState: new RouterState(),
			now: () => new Date((t += 7_500)),
			recordAttempt: () => {},
			onContinue: (info) => seen.push(info.secondsPerDecision),
			onAttempt: async () => {
				if (n++ === 0) throw yieldAt(0, 100);
				return "ok";
			},
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]).toBeGreaterThan(0);
	});

	it("marks token usage unavailable rather than estimating it", async () => {
		// The Pi SDK exposes only estimated context-window occupancy, not per-turn
		// input/output/cached tokens. Storing a derived number next to measured
		// ones would make a guess indistinguishable from a measurement.
		const attempts: AgentAttempt[] = [];
		let n = 0;
		await runStageWithFallback<string>({
			stage: "CURATOR",
			chain: CHAIN,
			routerState: new RouterState(),
			recordAttempt: (a) => attempts.push(a),
			onAttempt: async () => {
				if (n++ === 0) throw yieldAt(0, 100);
				return "ok";
			},
		});
		const yielded = attempts.find((a) => a.status === "YIELDED");
		expect(yielded?.errorMeta?.["tokenUsage"]).toBe("unavailable");
		expect(Object.keys(yielded?.errorMeta ?? {})).not.toContain("inputTokens");
	});

	it("reports null seconds-per-decision rather than dividing by zero", async () => {
		const seen: Array<number | null> = [];
		let n = 0;
		await runStageWithFallback<string>({
			stage: "CURATOR",
			chain: CHAIN,
			routerState: new RouterState(),
			recordAttempt: () => {},
			onContinue: (info) => seen.push(info.secondsPerDecision),
			onAttempt: async () => {
				if (n++ === 0) throw yieldAt(500, 500);
				return "ok";
			},
		});
		expect(seen[0]).toBeNull();
	});
});
