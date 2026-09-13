import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPhase1Day } from "../../src/runtime/orchestrator.ts";
import { RunStateStore } from "../../src/runtime/run-state.ts";
import { FAULT_INJECTION_ENV_VAR } from "../../src/runtime/fault-injection.ts";
import type { ModelSpec } from "../../src/runtime/model-config.ts";
import {
	competentCuratorScript,
	competentEditorScript,
	createResolvedDriverFactory,
	makeManifest,
	makeTestPaths,
	writeManifest,
	type Script,
} from "../support/fake-agent.ts";

/**
 * Drives the SAME orchestrator/router/classifier code path as a live run, with a
 * fake agent runner standing in for the model. The only thing simulated is "what
 * would the model do"; the fault, its classification, the fallback decision, and
 * the persisted state are all the production code.
 */

const DATE = "2026-09-13";

const CHAIN: readonly ModelSpec[] = [
	{ provider: "github-copilot", model: "gemini-3.8-flash" },
	{ provider: "openai-codex", model: "gpt-5.6-sol" },
	{ provider: "opencode-go", model: "deepseek-v4.1-flash" },
];

let root: string;
const originalEnv = process.env[FAULT_INJECTION_ENV_VAR];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "di-integ-fault-injection-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	if (originalEnv === undefined) delete process.env[FAULT_INJECTION_ENV_VAR];
	else process.env[FAULT_INJECTION_ENV_VAR] = originalEnv;
});

describe("fault injection drives a real fallback", () => {
	// QUOTA (rather than the README example's RATE_LIMIT) is used here because
	// decideAction retries RATE_LIMIT once on the SAME model before falling back
	// (see model-router.ts), and the fault fires only once by design — so a
	// RATE_LIMIT injection would be absorbed by that retry instead of exercising
	// the fallback path this test is for. QUOTA falls back immediately.
	it("fires a QUOTA fault after N processed items on the primary curator model, then the secondary resumes and completes 100% of items", async () => {
		process.env[FAULT_INJECTION_ENV_VAR] = JSON.stringify({
			stage: "curator",
			model: "primary",
			afterProcessedItems: 10,
			failureClass: "QUOTA",
		});

		const manifest = makeManifest({ date: DATE, groups: 12, perGroup: 2 }); // 24 items
		const paths = makeTestPaths(root);
		writeManifest(paths, manifest);

		const groups = new Map<string, string[]>();
		const pagesSeen: Array<{ model: string; ids: string[] }> = [];

		const driverFactory = createResolvedDriverFactory((opts) => {
			const isEditor = opts.customTools.some((t) => t.name === "submit_brief");
			if (isEditor) return competentEditorScript();
			const script: Script = competentCuratorScript({
				groups,
				onPage: (ids) => pagesSeen.push({ model: opts.spec.model, ids }),
			});
			return [script];
		});

		const result = await runPhase1Day({ date: DATE, paths, chain: CHAIN, driverFactory });

		const store = RunStateStore.open({ root: paths.runsDir, date: DATE, runId: result.runId });
		const attempts = store.readAttempts();
		const curatorAttempts = attempts.filter((a) => a.stage === "CURATOR");

		expect(curatorAttempts).toHaveLength(2);
		const [failed, succeeded] = curatorAttempts;

		// The failure is real classification of a synthetic error, not a special case.
		expect(failed!.model).toBe("gemini-3.8-flash");
		expect(failed!.status).toBe("FAILED");
		expect(failed!.failureClass).toBe("QUOTA");
		expect(failed!.fallbackReason).toMatch(/QUOTA; falling back/);

		// The artifact can never be mistaken for a spontaneous fallback.
		expect(failed!.faultInjected).toEqual({
			stage: "CURATOR",
			model: "github-copilot/gemini-3.8-flash",
			failureClass: "QUOTA",
			afterProcessedItems: 10,
			firedAtProcessedItems: expect.any(Number),
		});
		expect(failed!.faultInjected!.firedAtProcessedItems).toBeGreaterThanOrEqual(10);

		expect(succeeded!.model).toBe("gpt-5.6-sol");
		expect(succeeded!.status).toBe("SUCCESS");
		expect(succeeded!.faultInjected).toBeUndefined();

		expect(result.fallbackOccurred).toBe(true);
		expect(store.load().status).toBe("COMPLETED");

		// The fallback model resumed from persisted state: it was not shown items
		// the first model had already decided.
		const secondaryPages = pagesSeen.filter((p) => p.model === "gpt-5.6-sol");
		const totalSeenBySecondary = secondaryPages.reduce((n, p) => n + p.ids.length, 0);
		expect(totalSeenBySecondary).toBeLessThan(manifest.items.length);

		// And the run produced materials covering every item, exactly once.
		const allSourceItemIds = result.materials.stories.flatMap((s) => s.sourceItemIds);
		expect(new Set(allSourceItemIds).size).toBe(manifest.items.length);
		expect(result.brief).toBeDefined();
	});

	it("ends the attempt mid-scan, without waiting for the model to yield the turn", async () => {
		// A real model does the whole day in one uninterrupted turn: scan, cluster,
		// decide, submit. If the only place a fault can land is after that turn
		// returns, then by the time it fires there is nothing left to resume and
		// the "fallback continues the remaining items" path is never exercised --
		// which is also wrong about production, where a provider error lands
		// between two tool calls, not between two turns.
		process.env[FAULT_INJECTION_ENV_VAR] = JSON.stringify({
			stage: "curator",
			model: "primary",
			afterProcessedItems: 6,
			failureClass: "QUOTA",
		});

		const manifest = makeManifest({ date: DATE, groups: 15, perGroup: 2 }); // 30 items
		const paths = makeTestPaths(root);
		writeManifest(paths, manifest);

		const submitsByModel: string[] = [];
		const groups = new Map<string, string[]>();
		const driverFactory = createResolvedDriverFactory((opts) => {
			const isEditor = opts.customTools.some((t) => t.name === "submit_brief");
			if (isEditor) return competentEditorScript();
			// A page size below the item count makes the decisions arrive in
			// batches, so "processed" crosses the threshold part way through a turn.
			return [
				competentCuratorScript({
					groups,
					pageSize: 5,
					onSubmit: () => submitsByModel.push(opts.spec.model),
				}),
			];
		});

		const result = await runPhase1Day({ date: DATE, paths, chain: CHAIN, driverFactory });

		const store = RunStateStore.open({ root: paths.runsDir, date: DATE, runId: result.runId });
		const curatorAttempts = store.readAttempts().filter((a) => a.stage === "CURATOR");
		expect(curatorAttempts).toHaveLength(2);

		const failed = curatorAttempts[0]!;
		expect(failed.status).toBe("FAILED");
		expect(failed.failureClass).toBe("QUOTA");
		// The whole point: it fired while work remained, not after the day was done.
		expect(failed.faultInjected!.firedAtProcessedItems).toBeGreaterThanOrEqual(6);
		expect(failed.faultInjected!.firedAtProcessedItems).toBeLessThan(manifest.items.length);

		// The primary never got to submit; only the fallback model did.
		expect(submitsByModel).toEqual(["gpt-5.6-sol"]);
		expect(curatorAttempts[1]!.status).toBe("SUCCESS");
		expect(store.load().status).toBe("COMPLETED");

		// And no item was lost or decided twice across the two sessions.
		const allSourceItemIds = result.materials.stories.flatMap((s) => s.sourceItemIds);
		expect(allSourceItemIds).toHaveLength(manifest.items.length);
		expect(new Set(allSourceItemIds).size).toBe(manifest.items.length);
	});

	it("does nothing when the env var is unset (off by default)", async () => {
		delete process.env[FAULT_INJECTION_ENV_VAR];

		const manifest = makeManifest({ date: DATE, groups: 8, perGroup: 2 });
		const paths = makeTestPaths(root);
		writeManifest(paths, manifest);

		const driverFactory = createResolvedDriverFactory((opts) => {
			const isEditor = opts.customTools.some((t) => t.name === "submit_brief");
			return isEditor ? competentEditorScript() : competentCuratorScript();
		});

		const result = await runPhase1Day({ date: DATE, paths, chain: CHAIN, driverFactory });

		const store = RunStateStore.open({ root: paths.runsDir, date: DATE, runId: result.runId });
		const attempts = store.readAttempts();
		expect(attempts.every((a) => a.status === "SUCCESS")).toBe(true);
		expect(attempts.every((a) => a.faultInjected === undefined)).toBe(true);
		expect(result.fallbackOccurred).toBe(false);
	});

	it("rejects an invalid spec at startup rather than running as if disabled", async () => {
		process.env[FAULT_INJECTION_ENV_VAR] = "{this is not json";

		const manifest = makeManifest({ date: DATE, groups: 2, perGroup: 2 });
		const paths = makeTestPaths(root);
		writeManifest(paths, manifest);

		const driverFactory = createResolvedDriverFactory((opts) => {
			const isEditor = opts.customTools.some((t) => t.name === "submit_brief");
			return isEditor ? competentEditorScript() : competentCuratorScript();
		});

		await expect(runPhase1Day({ date: DATE, paths, chain: CHAIN, driverFactory })).rejects.toThrow(
			/not valid JSON/,
		);
	});
});
