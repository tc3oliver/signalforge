import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCuratorStage } from "../../src/curator/session.ts";
import { classifyError } from "../../src/runtime/error-classifier.ts";
import { MODEL_CHAIN } from "../../src/runtime/model-config.ts";
import { ProgressYieldError } from "../../src/runtime/progress-yield.ts";
import { JsonStoryRepository } from "../../src/stories/json-repository.ts";
import { REPO_ROOT, createFakeDriverFactory, makeManifest, type Script } from "../support/fake-agent.ts";
import type { TokenUsage } from "../../src/schemas/run.ts";

/*
 * The silent-provider check, through a real stage rather than as a pure
 * function.
 *
 * No fake driver used to implement `getUsage`, so `providerSpoke(undefined)`
 * short-circuited to true and the wiring in `runCuratorStage` was never
 * executed by any test -- including its interaction with the errors fault
 * injection synthesises, which are real ToolLoopError and InvalidAgentOutputError
 * instances and would be reclassified by a zero-usage driver.
 */

const DATE = "2026-09-16";
const SKILLS_ROOT = join(REPO_ROOT, "agent", "skills");

const SILENT: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reportedBy: 1 };
const SPOKE: TokenUsage = { input: 400, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 420, reportedBy: 2 };
const CACHED: TokenUsage = { input: 0, output: 0, cacheRead: 9000, cacheWrite: 0, totalTokens: 0, reportedBy: 2 };

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "di-silent-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A model that is handed the turn and does nothing with it. */
const doesNothing: Script = async () => {};

function run(usage: TokenUsage | undefined, script: Script = doesNothing) {
	return runCuratorStage({
		date: DATE,
		manifest: makeManifest({ date: DATE, groups: 4, perGroup: 2 }),
		repo: new JsonStoryRepository(join(root, "ledger")),
		spec: MODEL_CHAIN[0]!,
		skillsRoot: SKILLS_ROOT,
		cwd: root,
		driverFactory: createFakeDriverFactory(script, usage ? { usage } : {}),
		mode: "FRESH",
		maxNudges: 0,
	});
}

describe("a stage whose provider said nothing", () => {
	it("reports MODEL_UNAVAILABLE, so the router falls back instead of nudging", async () => {
		const err = await run(SILENT).catch((e: unknown) => e);
		expect(classifyError(err).failureClass).toBe("MODEL_UNAVAILABLE");
		expect(String((err as Error).message)).toContain("never ran");
	});

	it("keeps the model's own failure when the provider did speak", async () => {
		const err = await run(SPOKE).catch((e: unknown) => e);
		expect(classifyError(err).failureClass).toBe("INVALID_AGENT_OUTPUT");
	});

	it("counts a turn served from cache as having spoken", async () => {
		// input and output are both zero here and the provider still ran.
		const err = await run(CACHED).catch((e: unknown) => e);
		expect(classifyError(err).failureClass).toBe("INVALID_AGENT_OUTPUT");
	});

	it("behaves as it always did when the driver reports no usage at all", async () => {
		const err = await run(undefined).catch((e: unknown) => e);
		expect(classifyError(err).failureClass).toBe("INVALID_AGENT_OUTPUT");
	});

	it("never re-labels a progress yield, even from a driver reporting zero", async () => {
		const decideEverything: Script = async ({ call, promptText }) => {
			const match = promptText.match(/\{"items":.*?"nextCursor":(?:null|"[^"]*")\}/s);
			const page = JSON.parse(match![0]) as { items: Array<{ id: string }> };
			await call("commit_curation_batch", {
				decisions: page.items.slice(0, 4).map((i) => ({
					itemId: i.id,
					disposition: "IRRELEVANT",
					reason: "noise",
				})),
			});
		};
		const err = await runCuratorStage({
			date: DATE,
			manifest: makeManifest({ date: DATE, groups: 4, perGroup: 2 }),
			repo: new JsonStoryRepository(join(root, "ledger")),
			spec: MODEL_CHAIN[0]!,
			skillsRoot: SKILLS_ROOT,
			cwd: root,
			driverFactory: createFakeDriverFactory(decideEverything, { usage: SILENT }),
			mode: "FRESH",
			maxNudges: 0,
			maxDecisionsPerTurn: 4,
		}).catch((e: unknown) => e);
		// A yield is not a failure and is never reclassified, whatever usage says.
		expect(err).toBeInstanceOf(ProgressYieldError);
	});
});
