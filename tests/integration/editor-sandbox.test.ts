import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runEditorStage } from "../../src/editor/session.ts";
import { InvalidAgentOutputError } from "../../src/runtime/error-classifier.ts";
import { MODEL_CHAIN } from "../../src/runtime/model-config.ts";
import { JsonStoryRepository } from "../../src/stories/json-repository.ts";
import type { DailyManifest, DailyMaterials } from "../../src/schemas/index.ts";
import {
	REPO_ROOT,
	competentEditorScript,
	createFakeDriverFactory,
	groupOf,
	makeManifest,
	storyIdFor,
	type Script,
} from "../support/fake-agent.ts";

const DATE = "2026-09-13";
const SKILLS_ROOT = join(REPO_ROOT, "agent", "skills");

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "di-integ-editor-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/**
 * Materials covering the first `storyCount` groups only, so the manifest keeps
 * items the editor must not be able to reach.
 */
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

function editorStage(opts: {
	manifest: DailyManifest;
	materials: DailyMaterials;
	scripts: Script[];
	maxNudges?: number;
}) {
	return runEditorStage({
		date: DATE,
		manifest: opts.manifest,
		materials: opts.materials,
		repo: new JsonStoryRepository(join(root, "ledger")),
		spec: MODEL_CHAIN[0]!,
		skillsRoot: SKILLS_ROOT,
		cwd: root,
		driverFactory: createFakeDriverFactory(opts.scripts),
		mode: "FRESH",
		maxNudges: opts.maxNudges ?? 2,
	});
}

describe("editor submission validation", () => {
	it("rejects a 6-story brief, then accepts the corrected one", async () => {
		const manifest = makeManifest({ date: DATE, groups: 12, perGroup: 2 });
		const materials = makeMaterials(manifest, 10);

		const result = await editorStage({
			manifest,
			materials,
			scripts: [
				competentEditorScript({ storyCount: 6, tolerateRejection: true }),
				competentEditorScript(),
			],
		});

		expect(result.rejectedSubmissions).toBe(1);
		expect(result.brief.stories).toHaveLength(10);
		expect(result.brief.stories.filter((s) => s.mustKnow)).toHaveLength(3);
		expect(result.brief.date).toBe(DATE);
	});

	it("reports the minimum-story violation back to the editor, against the material count", async () => {
		const manifest = makeManifest({ date: DATE, groups: 12, perGroup: 2 });
		const materials = makeMaterials(manifest, 10);
		let rejection: unknown;

		const script: Script = async (api) => {
			await competentEditorScript({
				storyCount: 6,
				tolerateRejection: false,
			})(api).catch((err) => {
				rejection = err;
			});
		};

		await expect(
			editorStage({ manifest, materials, scripts: [script], maxNudges: 0 }),
		).rejects.toThrow(InvalidAgentOutputError);
		// The floor is not a constant any more: it is whatever the curator supplied,
		// capped at eight. Ten materials means eight, and the message says why.
		expect((rejection as Error).message).toMatch(
			/must have between 8 and 10, because the curator supplied 10/,
		);
	});

	it("rejects a sourceItemId that exists in the manifest but not in that story's materials", async () => {
		const manifest = makeManifest({ date: DATE, groups: 12, perGroup: 2 });
		const materials = makeMaterials(manifest, 10);
		// Belongs to a different material story, so it is real but out of scope.
		const strayId = materials.stories[5]!.sourceItemIds[0]!;
		let rejection: unknown;

		const script: Script = async (api) => {
			await competentEditorScript({
				mutate: (payload) => {
					payload.stories[0].sourceItemIds = [...payload.stories[0].sourceItemIds, strayId];
				},
			})(api).catch((err) => {
				rejection = err;
			});
		};

		await expect(
			editorStage({ manifest, materials, scripts: [script], maxNudges: 0 }),
		).rejects.toThrow(InvalidAgentOutputError);
		expect((rejection as Error).message).toMatch(
			new RegExp(`not among that story's material sources: ${strayId}`),
		);
	});

	it("rejects an unknown factRef", async () => {
		const manifest = makeManifest({ date: DATE, groups: 12, perGroup: 2, facts: 2 });
		const materials = makeMaterials(manifest, 10);
		let rejection: unknown;

		const script: Script = async (api) => {
			await competentEditorScript({
				mutate: (payload) => {
					payload.stories[0].factRefs = ["fct-invented-999"];
				},
			})(api).catch((err) => {
				rejection = err;
			});
		};

		await expect(
			editorStage({ manifest, materials, scripts: [script], maxNudges: 0 }),
		).rejects.toThrow(InvalidAgentOutputError);
		expect((rejection as Error).message).toMatch(/Unknown factRefs.*fct-invented-999/s);
	});
});

describe("editor sandbox", () => {
	it("cannot read a manifest item that no material story carries, and has no inventory tool", async () => {
		const manifest = makeManifest({ date: DATE, groups: 12, perGroup: 2 });
		const materials = makeMaterials(manifest, 10);
		const reachable = new Set(materials.stories.flatMap((s) => s.sourceItemIds));
		const unreachable = manifest.items.map((i) => i.id).filter((id) => !reachable.has(id));
		expect(unreachable.length).toBeGreaterThan(0);

		let toolNames: string[] = [];
		let rejection: unknown;
		let allowed: unknown;

		const script: Script = async ({ call, toolNames: names }) => {
			toolNames = names;
			rejection = await call("get_source_items", { itemIds: [unreachable[0]] }).then(
				() => new Error("get_source_items unexpectedly succeeded"),
				(err) => err,
			);
			// The in-scope item is still readable, so the rejection is scoping and not breakage.
			allowed = await call("get_source_items", { itemIds: [[...reachable][0]] });
		};

		await expect(
			editorStage({ manifest, materials, scripts: [script], maxNudges: 0 }),
		).rejects.toThrow(InvalidAgentOutputError);

		expect((rejection as Error).message).toMatch(
			new RegExp(`Not available: ${unreachable[0]}.*only read source items that belong to a story`, "s"),
		);
		expect((allowed as { items: unknown[] }).items).toHaveLength(1);

		// No tool hands the editor the raw daily inventory.
		expect(toolNames.sort()).toEqual([
			"find_history",
			"get_materials",
			"get_source_items",
			"get_story_detail",
			"get_structured_facts",
			"read_skill_reference",
			"read_source_body",
			"submit_brief",
		]);
		for (const curatorOnly of ["get_daily_inventory", "list_unseen_items", "search_items", "get_item_detail"]) {
			expect(toolNames).not.toContain(curatorOnly);
		}
	});
});
