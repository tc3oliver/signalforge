import { describe, expect, it, vi } from "vitest";
import type { AgentDriver } from "../src/runtime/agent-driver.ts";
import { TurnTimeoutError, withTurnTimeout } from "../src/runtime/turn-timeout.ts";
import { classifyError } from "../src/runtime/error-classifier.ts";
import { decideAction } from "../src/runtime/model-router.ts";

/*
 * The bound that was missing on 2026-09-13, when the editor spent 114 minutes
 * across six turns of 14 to 21 minutes each. The run never entered a failed
 * state — it was slow, not broken — so no fallback ever triggered and the
 * configured five-minute limit, which nothing read, changed nothing.
 */

function driver(over: Partial<AgentDriver> = {}): AgentDriver {
	return {
		prompt: async () => {},
		getActiveToolNames: () => [],
		dispose: () => {},
		...over,
	};
}

describe("withTurnTimeout", () => {
	it("returns a turn that finishes in time, untouched", async () => {
		const abort = vi.fn(async () => {});
		await expect(
			withTurnTimeout(driver({ abort }), "editor", 1000, async () => {}),
		).resolves.toBeUndefined();
		expect(abort).not.toHaveBeenCalled();
	});

	it("aborts the session and throws once a turn overruns", async () => {
		const abort = vi.fn(async () => {});
		const never = () => new Promise<void>(() => {});
		await expect(withTurnTimeout(driver({ abort }), "editor", 20, never, 5)).rejects.toThrow(
			/editor turn exceeded/,
		);
		expect(abort).toHaveBeenCalledTimes(1);
	});

	it("still reports the timeout when the abort itself fails", async () => {
		// Losing the abort is bad; reporting success because of it would be worse.
		const abort = vi.fn(async () => {
			throw new Error("session already gone");
		});
		const never = () => new Promise<void>(() => {});
		await expect(withTurnTimeout(driver({ abort }), "curator", 20, never, 5)).rejects.toThrow(
			TurnTimeoutError,
		);
	});

	it("tolerates a driver with no abort, rather than masking the timeout", async () => {
		const never = () => new Promise<void>(() => {});
		await expect(withTurnTimeout(driver(), "curator", 20, never, 5)).rejects.toThrow(
			TurnTimeoutError,
		);
	});

	it("passes a turn's own failure through unchanged and does not abort", async () => {
		const abort = vi.fn(async () => {});
		await expect(
			withTurnTimeout(driver({ abort }), "editor", 1000, async () => {
				throw new Error("model rejected the request");
			}),
		).rejects.toThrow(/model rejected/);
		expect(abort).not.toHaveBeenCalled();
	});

	it("imposes no bound when the stage has none configured", async () => {
		let ran = false;
		await withTurnTimeout(driver(), "editor", undefined, async () => {
			ran = true;
		});
		expect(ran).toBe(true);
		await withTurnTimeout(driver(), "editor", 0, async () => {});
	});
});

describe("a timed-out turn reaches the router as a retryable failure", () => {
	it("classifies as TIMEOUT", () => {
		const { failureClass } = classifyError(new TurnTimeoutError("editor", 300_000));
		expect(failureClass).toBe("TIMEOUT");
	});

	it("retries the same model once, then falls back", () => {
		expect(decideAction("TIMEOUT", 1)).toEqual({ kind: "RETRY_SAME" });
		expect(decideAction("TIMEOUT", 2)).toEqual({ kind: "FALLBACK" });
	});
});

/*
 * `Promise.race` abandons the losing promise but does not stop it. The timed-out
 * turn therefore kept running while the router opened its replacement, so a tool
 * call still in flight could write after the new session had read the decided
 * set. Awaiting the aborted turn, with a deadline, is what makes "the previous
 * turn has finished" something the code knows rather than assumes.
 */
describe("withTurnTimeout waits for an aborted turn", () => {
	it("does not return until the aborted turn has actually settled", async () => {
		let settled = false;
		let release: (() => void) | undefined;
		const turn = () =>
			new Promise<void>((resolve) => {
				release = () => {
					settled = true;
					resolve();
				};
			});
		/*
		 * The abort returns straight away and the turn winds down afterwards,
		 * which is the shape that matters: a tool call already in flight settles
		 * on a later tick, after the session has acknowledged the abort. Resolving
		 * the turn inside abort would pass whether or not the turn is awaited and
		 * would prove nothing.
		 */
		const abort = vi.fn(async () => {
			setTimeout(() => release?.(), 40);
		});

		await expect(withTurnTimeout(driver({ abort }), "editor", 20, turn, 1000)).rejects.toThrow(
			TurnTimeoutError,
		);
		expect(abort).toHaveBeenCalledTimes(1);
		expect(settled).toBe(true);
	});

	it("gives up on a turn that ignores the abort, rather than hanging the run", async () => {
		const abort = vi.fn(async () => {});
		const never = () => new Promise<void>(() => {});
		const startedAt = Date.now();

		await expect(withTurnTimeout(driver({ abort }), "editor", 20, never, 50)).rejects.toThrow(
			TurnTimeoutError,
		);
		// Bounded: the deadline applies even when the session never stops.
		expect(Date.now() - startedAt).toBeLessThan(3000);
	});
});
