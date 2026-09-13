import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPhase1Day } from "../../src/runtime/orchestrator.ts";
import { RunStateStore } from "../../src/runtime/run-state.ts";
import type { ModelSpec } from "../../src/runtime/model-config.ts";
import {
	competentCuratorScript,
	competentEditorScript,
	createResolvedDriverFactory,
	makeManifest,
	makeTestPaths,
	providerError,
	writeManifest,
	type Script,
} from "../support/fake-agent.ts";

const DATE = "2026-09-13";

const CHAIN: readonly ModelSpec[] = [
	{ provider: "github-copilot", model: "gemini-3.8-flash" },
	{ provider: "openai-codex", model: "gpt-5.6-sol" },
	{ provider: "opencode-go", model: "deepseek-v4.1-flash" },
];

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "di-integ-fallback-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("model failure then fallback", () => {
	it("falls back on a quota error and resumes from the failed model's decisions", async () => {
		const manifest = makeManifest({ date: DATE, groups: 12, perGroup: 2 });
		const paths = makeTestPaths(root);
		writeManifest(paths, manifest);

		// Shared across the two curator scripts: what the first model clustered, so
		// the second can submit materials for the whole day rather than half of it.
		const groups = new Map<string, string[]>();
		const pagesSeen: Array<{ model: string; ids: string[] }> = [];

		const quotaThenNothing: Script = async (api) => {
			await competentCuratorScript({
				stopAfterItems: 10,
				groups,
				onPage: (ids) => pagesSeen.push({ model: "gemini-3.8-flash", ids }),
			})(api);
			throw providerError("You exceeded your current quota for this model", 429);
		};

		const driverFactory = createResolvedDriverFactory((opts) => {
			const isEditor = opts.customTools.some((t) => t.name === "submit_brief");
			if (isEditor) return competentEditorScript();
			if (opts.spec.model === "gemini-3.8-flash") return [quotaThenNothing];
			return [
				competentCuratorScript({
					groups,
					onPage: (ids) => pagesSeen.push({ model: opts.spec.model, ids }),
				}),
			];
		});

		const result = await runPhase1Day({ date: DATE, paths, chain: CHAIN, driverFactory });

		const store = RunStateStore.open({ root: paths.runsDir, date: DATE, runId: result.runId });
		const attempts = store.readAttempts();
		const curatorAttempts = attempts.filter((a) => a.stage === "CURATOR");

		expect(
			curatorAttempts.map((a) => [a.model, a.status, a.failureClass ?? null]),
		).toEqual([
			["gemini-3.8-flash", "FAILED", "QUOTA"],
			["gpt-5.6-sol", "SUCCESS", null],
		]);
		expect(curatorAttempts[0]!.fallbackReason).toMatch(/QUOTA; falling back/);
		expect(result.fallbackOccurred).toBe(true);
		expect(store.load().status).toBe("COMPLETED");

		// The point of the whole exercise: model 2 continued the day rather than
		// re-scanning it. It was shown 14 unseen items, not 24.
		const geminiPages = pagesSeen.filter((p) => p.model === "gemini-3.8-flash");
		const gptPages = pagesSeen.filter((p) => p.model === "gpt-5.6-sol");
		expect(geminiPages[0]!.ids).toHaveLength(24);
		expect(gptPages[0]!.ids).toHaveLength(14);
		expect(gptPages[0]!.ids).toEqual(manifest.items.slice(10).map((i) => i.id));

		// And all 24 items are decided exactly once, with model 1's work intact.
		expect(result.materials.stories).toHaveLength(12);
		expect(result.brief).toBeDefined();
	});
});
