import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCuratorStage } from "../src/curator/session.ts";
import { runEditorStage } from "../src/editor/session.ts";
import { InvalidAgentOutputError, ToolLoopError } from "../src/runtime/error-classifier.ts";
import { MODEL_CHAIN } from "../src/runtime/model-config.ts";
import { JsonStoryRepository } from "../src/stories/json-repository.ts";
import type { DailyManifest, DailyMaterials } from "../src/schemas/index.ts";
import {
	REPO_ROOT,
	competentCuratorScript,
	competentEditorScript,
	createFakeDriverFactory,
	groupOf,
	makeManifest,
	storyIdFor,
	type Script,
	type ScriptApi,
} from "./support/fake-agent.ts";

const DATE = "2026-09-13";
const SKILLS_ROOT = join(REPO_ROOT, "agent", "skills");

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "di-nudge-feedback-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Curator                                                                    */
/* -------------------------------------------------------------------------- */

/** A payload that passes the validator, built from what the scan clustered. */
function goodMaterials(groups: Map<string, string[]>): Record<string, unknown> {
	return {
		stories: [...groups.entries()].map(([group, itemIds], i) => ({
			storyId: storyIdFor(group),
			tier: i < 3 ? "A" : i < 8 ? "B" : "C",
			canonicalTitle: `Event ${group}`,
			whySelected: `Event ${group} is the distinct thing that happened.`,
			changeType: "NEW",
			importance: 0.6,
			novelty: 0.7,
			confidence: 0.9,
			sourceItemIds: itemIds,
			primarySourceIds: [itemIds[0]],
		})),
		curatorNotes: "Scripted curator.",
	};
}

/** The same payload with one invented source item id, which the tool must reject. */
function badMaterials(groups: Map<string, string[]>): Record<string, unknown> {
	const payload = goodMaterials(groups) as { stories: Array<{ sourceItemIds: string[] }> };
	payload.stories[0]!.sourceItemIds = [...payload.stories[0]!.sourceItemIds, "itm-does-not-exist"];
	return payload;
}

/** Swallow the tool rejection: a real model sees it as a correctable tool result. */
async function trySubmitMaterials(api: ScriptApi, payload: unknown): Promise<void> {
	try {
		await api.call("submit_materials", payload);
	} catch {
		/* the session captures it; the model would read it and retry */
	}
}

function curatorStage(opts: { manifest: DailyManifest; scripts: Script[]; maxNudges?: number }) {
	return runCuratorStage({
		date: DATE,
		manifest: opts.manifest,
		repo: new JsonStoryRepository(join(root, "ledger")),
		spec: MODEL_CHAIN[0]!,
		skillsRoot: SKILLS_ROOT,
		cwd: root,
		driverFactory: createFakeDriverFactory(opts.scripts),
		mode: "FRESH",
		maxNudges: opts.maxNudges ?? 4,
	});
}

describe("curator nudge feedback", () => {
	it("carries a submit_materials rejection into the next nudge prompt", async () => {
		const manifest = makeManifest({ date: DATE, groups: 10, perGroup: 2 });
		const groups = new Map<string, string[]>();
		const scan = competentCuratorScript({ groups, skipSubmit: true });
		const prompts: string[] = [];

		const opening: Script = async (api) => {
			await scan(api);
			await trySubmitMaterials(api, badMaterials(groups));
		};
		const nudge: Script = async (api) => {
			prompts.push(api.promptText);
			await api.call("submit_materials", goodMaterials(groups));
		};

		const result = await curatorStage({ manifest, scripts: [opening, nudge] });

		expect(result.materials.stories).toHaveLength(10);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toMatch(/Your last submission was rejected/);
		expect(prompts[0]).toMatch(/itm-does-not-exist/);
	});

	it("carries a rejection raised during a nudge turn into the following nudge", async () => {
		const manifest = makeManifest({ date: DATE, groups: 10, perGroup: 2 });
		const groups = new Map<string, string[]>();
		const scan = competentCuratorScript({ groups, skipSubmit: true });
		const prompts: string[] = [];

		// The opening scans but never submits, so the first nudge has nothing to
		// report; the rejection happens inside that nudge turn instead.
		const opening: Script = async (api) => {
			await scan(api);
		};
		const failingNudge: Script = async (api) => {
			prompts.push(api.promptText);
			await trySubmitMaterials(api, badMaterials(groups));
		};
		const recoveringNudge: Script = async (api) => {
			prompts.push(api.promptText);
			await api.call("submit_materials", goodMaterials(groups));
		};

		await curatorStage({ manifest, scripts: [opening, failingNudge, recoveringNudge] });

		expect(prompts).toHaveLength(2);
		expect(prompts[0]).not.toMatch(/rejected/);
		expect(prompts[1]).toMatch(/itm-does-not-exist/);
	});

	it("reports a fully scanned run with a bad payload as invalid output, not a tool loop", async () => {
		const manifest = makeManifest({ date: DATE, groups: 10, perGroup: 2 });
		const groups = new Map<string, string[]>();
		const scan = competentCuratorScript({ groups, skipSubmit: true });

		const opening: Script = async (api) => {
			await scan(api);
			await trySubmitMaterials(api, badMaterials(groups));
		};
		const retry: Script = async (api) => {
			await trySubmitMaterials(api, badMaterials(groups));
		};

		const error = await curatorStage({
			manifest,
			scripts: [opening, retry, retry, retry],
			maxNudges: 6,
		}).then(
			() => new Error("curator unexpectedly succeeded"),
			(err: unknown) => err,
		);

		expect(error).toBeInstanceOf(InvalidAgentOutputError);
		expect(error).not.toBeInstanceOf(ToolLoopError);
		expect((error as Error).message).toMatch(/itm-does-not-exist/);
	});

	it("still reports a genuinely stalled scan as a tool loop", async () => {
		const manifest = makeManifest({ date: DATE, groups: 10, perGroup: 2 });
		const groups = new Map<string, string[]>();
		// Stops halfway through the items and then does nothing at all.
		const opening = competentCuratorScript({ groups, stopAfterItems: 8, pageSize: 8 });
		const idle: Script = async () => {};

		const error = await curatorStage({
			manifest,
			scripts: [opening, idle, idle, idle],
			maxNudges: 6,
		}).then(
			() => new Error("curator unexpectedly succeeded"),
			(err: unknown) => err,
		);

		expect(error).toBeInstanceOf(ToolLoopError);
	});
});

/* -------------------------------------------------------------------------- */
/* Editor                                                                     */
/* -------------------------------------------------------------------------- */

function makeMaterials(manifest: DailyManifest, storyCount: number): DailyMaterials {
	const groups = new Map<string, string[]>();
	for (const item of manifest.items) {
		const g = groupOf(item);
		groups.set(g, [...(groups.get(g) ?? []), item.id]);
	}
	const chosen = [...groups.entries()].slice(0, storyCount);
	return {
		date: DATE,
		producedAt: `${DATE}T10:00:00.000Z`,
		stories: chosen.map(([g, ids], i) => ({
			storyId: storyIdFor(g),
			tier: i < 3 ? "A" : "B",
			canonicalTitle: `Event ${g}`,
			whySelected: `Event ${g} is worth writing about.`,
			changeType: "NEW",
			importance: 0.6,
			novelty: 0.7,
			confidence: 0.9,
			sourceItemIds: ids,
			primarySourceIds: [ids[0]!],
			factRefs: [],
		})),
		emergingSignals: [],
		curatorNotes: "",
	};
}

describe("editor nudge feedback", () => {
	it("carries a rejection raised during a nudge turn into the following nudge", async () => {
		const manifest = makeManifest({ date: DATE, groups: 12, perGroup: 2 });
		const materials = makeMaterials(manifest, 10);
		const prompts: string[] = [];

		// Nothing is submitted in the opening turn, so the rejection can only be
		// produced inside nudge 1 — exactly the case the old code erased.
		const opening: Script = async () => {};
		const tooFewStories = competentEditorScript({ storyCount: 2, tolerateRejection: true });
		const failingNudge: Script = async (api) => {
			prompts.push(api.promptText);
			await tooFewStories(api);
		};
		const valid = competentEditorScript();
		const recoveringNudge: Script = async (api) => {
			prompts.push(api.promptText);
			await valid(api);
		};

		const result = await runEditorStage({
			date: DATE,
			manifest,
			materials,
			repo: new JsonStoryRepository(join(root, "ledger")),
			spec: MODEL_CHAIN[0]!,
			skillsRoot: SKILLS_ROOT,
			cwd: root,
			driverFactory: createFakeDriverFactory([opening, failingNudge, recoveringNudge]),
			mode: "FRESH",
			maxNudges: 3,
		});

		expect(result.rejectedSubmissions).toBe(1);
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toMatch(/You have not called/);
		expect(prompts[1]).toMatch(/Your submission was rejected/);
	});
});
