import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { announceMissingFixtures } from "../../src/db/test-support.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPhase1Day } from "../../src/runtime/orchestrator.ts";
import { MODEL_CHAIN } from "../../src/runtime/model-config.ts";
import { loadProjectSkills } from "../../src/runtime/pi-runtime.ts";
import { createSkillReferenceTool, loadSkillBundle } from "../../src/runtime/skill-access.ts";
import { DailyManifest as DailyManifestSchema } from "../../src/schemas/index.ts";
import {
	REPO_ROOT,
	competentCuratorScript,
	competentEditorScript,
	createResolvedDriverFactory,
	makeTestPaths,
	writeManifest,
	type Script,
} from "../support/fake-agent.ts";

const DATE = "2026-09-10";
const SKILLS_ROOT = join(REPO_ROOT, "agent", "skills");
const FIXTURE = join(REPO_ROOT, "fixtures", "generated", DATE, "manifest.json");
const GOLD = join(REPO_ROOT, "eval", "gold", `${DATE}.json`);

const haveFixtures = existsSync(FIXTURE) && existsSync(GOLD);
// This suite is the sandbox's security assertion, so its absence must be said
// out loud under `pnpm test` and must fail outright under `pnpm verify`.
announceMissingFixtures("gold-isolation", haveFixtures, `${FIXTURE} or ${GOLD} missing`);

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "di-integ-gold-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Tool names that would give an agent a way out of the sandbox. */
const ESCAPE_TOOLS = [
	"read",
	"write",
	"edit",
	"bash",
	"powershell",
	"ls",
	"grep",
	"find",
	"fetch",
	"web_search",
	"webfetch",
	"http",
	"glob",
];

describe.skipIf(!haveFixtures)("gold truth is unreachable from inside the agent sandbox", () => {
	it("never surfaces a gold event id through any tool, on a full real-fixture run", async () => {
		const manifest = DailyManifestSchema.parse(JSON.parse(readFileSync(FIXTURE, "utf8")));
		const gold = JSON.parse(readFileSync(GOLD, "utf8")) as {
			events: Array<{ eventId: string }>;
			noiseItemIds: string[];
		};
		const goldIds = gold.events.map((e) => e.eventId);
		expect(goldIds.length).toBeGreaterThan(0);

		const paths = makeTestPaths(root);
		writeManifest(paths, manifest);

		const bundle = loadSkillBundle(loadProjectSkills(SKILLS_ROOT)[0]!);
		const toolLog: Array<{ name: string; args: unknown; result?: unknown; error?: unknown }> = [];
		const toolNamesSeen = new Set<string>();

		/** Touch every read-only tool so the scan covers real tool output, not just submits. */
		const probe: Script = async ({ call, toolNames }) => {
			for (const n of toolNames) toolNamesSeen.add(n);
			const ids = manifest.items.slice(0, 3).map((i) => i.id);
			await call("get_daily_inventory", {});
			await call("list_unseen_items", { limit: 50 });
			await call("get_item_detail", { itemIds: ids });
			await call("read_item_body", { itemId: ids[0], find: "the" }).catch(() => undefined);
			await call("search_items", { query: "model release quantum" });
			await call("find_history", { text: "model" }).catch(() => undefined);
			await call("get_structured_facts", {});
			await call("get_story", { storyId: "story-that-does-not-exist" });
			for (const ref of bundle.referenceNames) {
				await call("read_skill_reference", { name: ref });
			}
		};

		const editorProbe: Script = async ({ call, toolNames }) => {
			for (const n of toolNames) toolNamesSeen.add(n);
			const materials = await call<{ stories: Array<{ storyId: string; sourceItemIds: string[] }> }>(
				"get_materials",
				{},
			);
			await call("get_story_detail", { storyIds: materials.stories.slice(0, 5).map((s) => s.storyId) });
			await call("get_source_items", { itemIds: materials.stories[0]!.sourceItemIds.slice(0, 5) });
			await call("get_structured_facts", {});
			await call("find_history", { text: "model" }).catch(() => undefined);
			for (const ref of bundle.referenceNames) {
				await call("read_skill_reference", { name: ref });
			}
		};

		const driverFactory = createResolvedDriverFactory(
			(opts) =>
				opts.customTools.some((t) => t.name === "submit_brief")
					? [
							async (api) => {
								await editorProbe(api);
								await competentEditorScript()(api);
							},
						]
					: [
							async (api) => {
								await probe(api);
								await competentCuratorScript()(api);
							},
						],
			{ toolLog },
		);

		const result = await runPhase1Day({
			date: DATE,
			paths,
			chain: [MODEL_CHAIN[0]!],
			driverFactory,
		});
		expect(result.brief).toBeDefined();

		// Everything the agents got BACK from a tool, concatenated. Arguments are the
		// agents' own input and prove nothing about what the sandbox hands out.
		expect(toolLog.length).toBeGreaterThan(20);
		const seen = JSON.stringify(
			toolLog.map((e) => ({ name: e.name, result: e.result, error: String(e.error ?? "") })),
		);
		for (const eventId of goldIds) {
			expect(seen).not.toContain(eventId);
		}
		// Nor do the gold-only judgement fields leak through the manifest.
		for (const key of ["goldEventId", "expectedImportance", "expectedImportant", "isNoise", "noiseItemIds"]) {
			expect(seen).not.toContain(key);
		}

		// Neither agent has a filesystem or network tool.
		const names = [...toolNamesSeen].map((n) => n.toLowerCase());
		for (const escape of ESCAPE_TOOLS) {
			expect(names).not.toContain(escape);
		}
		expect(names.sort()).toEqual(
			[
				"find_history",
				"get_daily_inventory",
				"get_item_detail",
				"get_materials",
				"get_source_items",
				"get_story",
				"get_story_detail",
				"get_structured_facts",
				"list_today_stories",
				"list_unseen_items",
				"read_item_body",
				"read_skill_reference",
				"read_source_body",
				"commit_curation_batch",
				"record_item_decisions",
				"search_items",
				"submit_brief",
				"submit_materials",
				"upsert_stories",
				"upsert_story",
			].sort(),
		);
	});

	it("read_skill_reference refuses traversal and absolute paths", async () => {
		const bundle = loadSkillBundle(loadProjectSkills(SKILLS_ROOT)[0]!);
		const tool = createSkillReferenceTool(bundle);
		const call = (name: string) =>
			tool.execute("call-1", { name } as never, undefined, undefined, {} as never);

		await expect(call("../../../eval/gold/2026-09-10.json")).rejects.toThrow(/Unknown reference/);
		await expect(call(GOLD)).rejects.toThrow(/Unknown reference/);
		await expect(call("../../../package.json")).rejects.toThrow(/Unknown reference/);
		await expect(call("references/../../../eval/gold/2026-09-10.json")).rejects.toThrow(
			/Unknown reference/,
		);

		// A legitimate reference still resolves, so the guard is not just "everything fails".
		const good = await call(bundle.referenceNames[0]!);
		expect((good.content[0] as { text: string }).text.length).toBeGreaterThan(0);
	});
});
