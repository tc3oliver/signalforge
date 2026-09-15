import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCuratorStage } from "../../src/curator/session.ts";
import { runPhase1Day } from "../../src/runtime/orchestrator.ts";
import { ProgrammerError, ToolLoopError } from "../../src/runtime/error-classifier.ts";
import { MODEL_CHAIN } from "../../src/runtime/model-config.ts";
import { RunStateStore } from "../../src/runtime/run-state.ts";
import { JsonStoryRepository } from "../../src/stories/json-repository.ts";
import {
	REPO_ROOT,
	competentCuratorScript,
	competentEditorScript,
	createResolvedDriverFactory,
	makeManifest,
	makeTestPaths,
	walkFiles,
	writeManifest,
	type Script,
} from "../support/fake-agent.ts";

const DATE = "2026-09-13";
const SKILLS_ROOT = join(REPO_ROOT, "agent", "skills");

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "di-integ-lifecycle-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A driver factory that plays a competent curator and a competent editor. */
function competentFactory() {
	return createResolvedDriverFactory((opts) =>
		opts.customTools.some((t) => t.name === "submit_brief")
			? competentEditorScript()
			: competentCuratorScript(),
	);
}

function onlyRunDir(runsDir: string): { runId: string; store: RunStateStore } {
	const runIds = readdirSync(join(runsDir, DATE));
	expect(runIds).toHaveLength(1);
	const runId = runIds[0]!;
	return { runId, store: RunStateStore.open({ root: runsDir, date: DATE, runId }) };
}

describe("run state transitions", () => {
	it("records the full lifecycle for a successful day", async () => {
		const paths = makeTestPaths(root);
		writeManifest(paths, makeManifest({ date: DATE, groups: 10, perGroup: 2 }));

		const result = await runPhase1Day({
			date: DATE,
			paths,
			chain: [MODEL_CHAIN[0]!],
			driverFactory: competentFactory(),
		});

		const store = RunStateStore.open({ root: paths.runsDir, date: DATE, runId: result.runId });
		const state = store.load();
		expect(state.status).toBe("COMPLETED");
		expect(state.totalItems).toBe(20);
		expect(state.processedItems).toBe(20);
		expect(state.storyCount).toBe(10);
		expect(state.failureReason).toBeUndefined();

		const transitions = store
			.readEvents()
			.filter((e) => e.kind === "run.transition")
			.map((e) => e["to"]);
		expect(transitions).toEqual([
			"CURATING",
			"MATERIALS_READY",
			"WRITING",
			"DRAFT_READY",
			"VALIDATING",
			"COMPLETED",
		]);
	});

	it("stops at CURATION_FAILED on a PROGRAMMER_ERROR without trying another model", async () => {
		const paths = makeTestPaths(root);
		writeManifest(paths, makeManifest({ date: DATE, groups: 10, perGroup: 2 }));

		const models: string[] = [];
		const boom: Script = async () => {
			throw new ProgrammerError("curator wiring is broken");
		};
		const driverFactory = createResolvedDriverFactory((opts) => {
			models.push(opts.spec.model);
			return [boom];
		});

		await expect(
			runPhase1Day({ date: DATE, paths, chain: MODEL_CHAIN, driverFactory }),
		).rejects.toThrow(/curator wiring is broken/);

		const { store } = onlyRunDir(paths.runsDir);
		const state = store.load();
		expect(state.status).toBe("CURATION_FAILED");
		expect(state.failureReason).toBe("curator wiring is broken");

		// One attempt, one model: a bug of ours is never blamed on the model.
		const attempts = store.readAttempts();
		expect(attempts).toHaveLength(1);
		expect(attempts[0]!.failureClass).toBe("PROGRAMMER_ERROR");
		// A FAIL is not a fallback: it never reaches a second model, so the counter
		// must not see one. The wording lives in errorMeta instead.
		expect(attempts[0]!.fallbackReason).toBeUndefined();
		expect(attempts[0]!.errorMeta?.["retryReason"]).toMatch(/PROGRAMMER_ERROR; FAIL/);
		expect(models).toEqual(["gemini-3.8-flash"]);

		const transitions = store
			.readEvents()
			.filter((e) => e.kind === "run.transition")
			.map((e) => e["to"]);
		expect(transitions).toEqual(["CURATING", "CURATION_FAILED"]);
	});
});

describe("tool loop detection", () => {
	it("throws ToolLoopError when the curator circles without recording decisions", async () => {
		const manifest = makeManifest({ date: DATE, groups: 5, perGroup: 2 });
		const spinning: Script = async ({ call }) => {
			await call("get_daily_inventory", {});
			await call("get_daily_inventory", {});
			await call("get_daily_inventory", {});
		};

		await expect(
			runCuratorStage({
				date: DATE,
				manifest,
				repo: new JsonStoryRepository(join(root, "ledger")),
				spec: MODEL_CHAIN[0]!,
				skillsRoot: SKILLS_ROOT,
				cwd: root,
				driverFactory: createResolvedDriverFactory(() => spinning),
				mode: "FRESH",
			}),
		).rejects.toThrow(ToolLoopError);
	});

	it("names the stalled progress in the ToolLoopError", async () => {
		const manifest = makeManifest({ date: DATE, groups: 5, perGroup: 2 });
		const spinning: Script = async ({ call }) => {
			await call("get_daily_inventory", {});
		};
		await expect(
			runCuratorStage({
				date: DATE,
				manifest,
				repo: new JsonStoryRepository(join(root, "ledger")),
				spec: MODEL_CHAIN[0]!,
				skillsRoot: SKILLS_ROOT,
				cwd: root,
				driverFactory: createResolvedDriverFactory(() => spinning),
				mode: "FRESH",
			}),
		).rejects.toThrow(/no progress across 3 turns at 0\/10 items decided/);
	});
});

describe("resuming an existing run", () => {
	/*
	 * The fixture lifecycle allows CURATING from CREATED and from CURATING only,
	 * and `runPhase1Day` transitions to CURATING unconditionally — so reopening a
	 * run that had already finished curating died on a bare "Illegal run
	 * transition" naming two states and no run. Rejected up front instead, with
	 * the run's actual state in the message. Skipping ahead to the editor is the
	 * larger change: nothing reads `materials.json` back, and the editor stage
	 * needs the curator result, not just the package.
	 */
	it("rejects a run that is already past curation, naming its state", async () => {
		const paths = makeTestPaths(root);
		writeManifest(paths, makeManifest({ date: DATE, groups: 10, perGroup: 2 }));

		const first = await runPhase1Day({
			date: DATE,
			paths,
			chain: [MODEL_CHAIN[0]!],
			driverFactory: competentFactory(),
		});
		expect(RunStateStore.open({ root: paths.runsDir, date: DATE, runId: first.runId }).load().status)
			.toBe("COMPLETED");

		await expect(
			runPhase1Day({
				date: DATE,
				paths,
				runId: first.runId,
				chain: [MODEL_CHAIN[0]!],
				driverFactory: competentFactory(),
			}),
		).rejects.toThrow(`Run ${first.runId} is at COMPLETED`);

		// The finished run is left exactly as it was.
		const after = RunStateStore.open({ root: paths.runsDir, date: DATE, runId: first.runId }).load();
		expect(after.status).toBe("COMPLETED");
	});

	/*
	 * The case --resume exists for: the process died mid-curation, so the run
	 * directory is still at CURATING and nothing has been decided about it. That
	 * is the one state the gate above must let through.
	 */
	it("continues a run that was interrupted mid-curation", async () => {
		const paths = makeTestPaths(root);
		writeManifest(paths, makeManifest({ date: DATE, groups: 10, perGroup: 2 }));

		const store = RunStateStore.create({ root: paths.runsDir, date: DATE });
		store.transition("CURATING");

		const resumed = await runPhase1Day({
			date: DATE,
			paths,
			runId: store.runId,
			chain: [MODEL_CHAIN[0]!],
			driverFactory: competentFactory(),
		});

		expect(resumed.runId).toBe(store.runId);
		expect(resumed.brief).toBeDefined();
		expect(store.load().status).toBe("COMPLETED");
	});
});

describe("run artifacts", () => {
	it("writes every expected file and leaves no temp file behind", async () => {
		const paths = makeTestPaths(root);
		writeManifest(paths, makeManifest({ date: DATE, groups: 10, perGroup: 2, facts: 3 }));

		const result = await runPhase1Day({
			date: DATE,
			paths,
			chain: [MODEL_CHAIN[0]!],
			driverFactory: competentFactory(),
		});

		const files = walkFiles(result.runDir);
		expect(files.sort()).toEqual(
			[
				"attempts.json",
				"brief.json",
				"brief.md",
				"events.jsonl",
				"item-decisions.json",
				"manifest.json",
				"materials.json",
				"restricted-runtime.json",
				"run-state.json",
				"story-ledger.json",
				"validation.json",
			].sort(),
		);
		expect(files.filter((f) => f.includes(".tmp-"))).toEqual([]);
		// Nothing half-written anywhere under the runs tree, ledger included.
		expect(walkFiles(paths.runsDir).filter((f) => f.includes(".tmp-"))).toEqual([]);
	});
});
