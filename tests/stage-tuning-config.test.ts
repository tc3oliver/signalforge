import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_STAGE_TUNING, loadStageTuning } from "../src/config/stage-tuning.ts";
import { DEFAULT_SOFT_DEADLINE_FRACTION } from "../src/runtime/progress-yield.ts";
import { REPO_ROOT } from "./support/fake-agent.ts";

/*
 * `DEFAULT_STAGE_TUNING` is what runs when `config/agent.yaml` cannot be read.
 * That makes a silent divergence between the two the worst kind of drift: the
 * pipeline keeps running, on values nobody chose, and only the telemetry six
 * hours later says anything. The timeout was raised from 300s to 420s on
 * 2026-09-22 in both places, and these pin them together.
 */
describe("shipped config and in-code defaults agree", () => {
	const tuning = loadStageTuning();

	it("loads the same turn timeouts the fallback would use", () => {
		expect(tuning.CURATOR.timeoutMs).toBe(DEFAULT_STAGE_TUNING.CURATOR.timeoutMs);
		expect(tuning.EDITOR.timeoutMs).toBe(DEFAULT_STAGE_TUNING.EDITOR.timeoutMs);
	});

	it("loads the same work-unit size", () => {
		expect(tuning.CURATOR.maxDecisionsPerTurn).toBe(
			DEFAULT_STAGE_TUNING.CURATOR.maxDecisionsPerTurn,
		);
	});

	it("leaves a work unit room to finish inside the turn it runs in", () => {
		/*
		 * The 2026-09-22 failure: the slowest curator attempt that finished used
		 * the entire 300s budget, and two more were cut off at it. Measured
		 * attempts have run to 300s, so a budget at or below that is one the work
		 * unit is known to be able to exhaust.
		 */
		expect(tuning.CURATOR.timeoutMs).toBeGreaterThan(300_000);
		// The soft deadline is where a unit is asked to stop; the timeout is the
		// hard floor under it. They must not collapse onto each other.
		const softDeadlineMs = tuning.CURATOR.timeoutMs * DEFAULT_SOFT_DEADLINE_FRACTION;
		expect(softDeadlineMs).toBeLessThan(tuning.CURATOR.timeoutMs);
		expect(tuning.CURATOR.timeoutMs - softDeadlineMs).toBeGreaterThanOrEqual(120_000);
	});

	it("documents the value it ships, so the comment cannot outlive the number", () => {
		const yaml = readFileSync(join(REPO_ROOT, "config", "agent.yaml"), "utf8");
		const seconds = Math.round(tuning.CURATOR.timeoutMs / 1000);
		const soft = Math.round((tuning.CURATOR.timeoutMs * DEFAULT_SOFT_DEADLINE_FRACTION) / 1000);
		expect(yaml).toContain(`${seconds}s`);
		expect(yaml).toContain(`${soft}s`);
	});
});
