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
		await expect(withTurnTimeout(driver({ abort }), "editor", 20, never)).rejects.toThrow(
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
		await expect(withTurnTimeout(driver({ abort }), "curator", 20, never)).rejects.toThrow(
			TurnTimeoutError,
		);
	});

	it("tolerates a driver with no abort, rather than masking the timeout", async () => {
		const never = () => new Promise<void>(() => {});
		await expect(withTurnTimeout(driver(), "curator", 20, never)).rejects.toThrow(
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
