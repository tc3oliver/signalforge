import { describe, expect, it } from "vitest";
import { ZodError, z } from "zod";
import { ok, rejectFromZod, ToolRejection } from "../src/agent-tools/shared.ts";
import { createCuratorTools } from "../src/curator/tools.ts";
import { createEditorTools } from "../src/editor/tools.ts";
import type { DailyManifest, DailyMaterials, StructuredFact } from "../src/schemas/index.ts";
import type { StoryHistoryQuery, StoryRepository } from "../src/stories/repository.ts";
import type { StoryLedgerEntry } from "../src/schemas/story.ts";

const DATE = "2026-09-12";

function fact(factId: string, sourceItemId: string, kind: StructuredFact["kind"]): StructuredFact {
	return {
		factId,
		kind,
		label: factId,
		value: 1,
		unit: "USD",
		asOf: `${DATE}T00:00:00.000Z`,
		sourceItemId,
	};
}

function item(id: string) {
	return {
		id,
		sourceType: "rss" as const,
		trust: "UNTRUSTED_EXTERNAL_CONTENT" as const,
		sourceName: "feed",
		title: `title ${id}`,
		summary: "",
		publishedAt: `${DATE}T00:00:00.000Z`,
		metadata: {},
	};
}

function manifest(): DailyManifest {
	return {
		date: DATE,
		generatedAt: `${DATE}T00:00:00.000Z`,
		items: [item("i1"), item("i2")],
		facts: [fact("f1", "i1", "crypto"), fact("f2", "i2", "macro")],
	};
}

function materials(): DailyMaterials {
	return {
		date: DATE,
		producedAt: `${DATE}T02:00:00.000Z`,
		stories: [
			{
				storyId: "s1",
				tier: "A",
				canonicalTitle: "Story 1",
				whySelected: "fixture",
				changeType: "NEW",
				importance: 0.9,
				novelty: 0.9,
				confidence: 0.9,
				sourceItemIds: ["i1"],
				primarySourceIds: ["i1"],
				factRefs: [],
			},
		],
		emergingSignals: [],
		curatorNotes: "",
	};
}

/** Records the query it was asked, so the shared builder's wiring is observable. */
function fakeRepo(): StoryRepository & { queries: StoryHistoryQuery[] } {
	const queries: StoryHistoryQuery[] = [];
	return {
		queries,
		async findHistory(query) {
			queries.push(query);
			return [];
		},
		async getStory() {
			return undefined;
		},
		async listStories(): Promise<StoryLedgerEntry[]> {
			return [];
		},
		async upsertStory() {
			throw new Error("not used");
		},
		async recordDecisions() {},
		async listDecisions() {
			return [];
		},
		async processedItemIds() {
			return new Set<string>();
		},
	} as StoryRepository & { queries: StoryHistoryQuery[] };
}

function toolsFor(repo: StoryRepository) {
	const ctx = { date: DATE, manifest: manifest(), repo, now: () => new Date(DATE) };
	return {
		curator: createCuratorTools(ctx as never),
		editor: createEditorTools({ ...ctx, materials: materials() } as never),
	};
}

function find(tools: ReturnType<typeof toolsFor>["curator"], name: string) {
	const tool = tools.find((t) => t.name === name);
	if (!tool) throw new Error(`no tool named ${name}`);
	return tool;
}

/** Tool `execute` takes a call id, the params, and three runtime arguments the
 * restricted session supplies; the tools under test use none of them. */
function run(tool: ReturnType<typeof find>, params: unknown): Promise<unknown> {
	return tool.execute("call-1", params as never, undefined, undefined, {} as never) as Promise<unknown>;
}

async function payload(result: unknown): Promise<Record<string, unknown>> {
	const content = (result as { content: { text: string }[] }).content;
	return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

/*
 * The curator and editor tool sets now build find_history and
 * get_structured_facts from one place. What the model sees is a contract:
 * `assertRestricted()` matches tool names exactly, the prompts quote the
 * promptSnippets, and rejection strings are what a model corrects itself
 * against. These assertions spell out that surface so a later edit to the
 * shared builder cannot quietly change it.
 */
describe("shared tool scaffolding — the model-visible surface is unchanged", () => {
	const HISTORY_PARAMS = {
		type: "object",
		properties: {
			text: { type: "string" },
			storyId: { type: "string" },
			limit: { type: "integer", minimum: 1, maximum: 25 },
		},
	};
	const KIND = {
		anyOf: [
			{ type: "string", const: "crypto" },
			{ type: "string", const: "macro" },
			{ type: "string", const: "filing" },
		],
	};

	it("keeps both find_history schemas and their differing wording", () => {
		const { curator, editor } = toolsFor(fakeRepo());
		const c = find(curator, "find_history");
		const e = find(editor, "find_history");

		expect(c.parameters).toEqual(HISTORY_PARAMS);
		expect(e.parameters).toEqual(HISTORY_PARAMS);
		expect(c.label).toBe("Find history");
		expect(e.label).toBe("Find history");
		expect(c.promptSnippet).toBe("find_history: look up this story on earlier days");
		expect(e.promptSnippet).toBe("find_history: what this story looked like on earlier days");
		expect(c.description).toContain("Call this before you decide a changeType");
		expect(e.description).toContain("describes an actual delta");
	});

	it("keeps each get_structured_facts parameter name — itemIds for the curator, factIds for the editor", () => {
		const { curator, editor } = toolsFor(fakeRepo());
		expect(find(curator, "get_structured_facts").parameters).toEqual({
			type: "object",
			properties: { kind: KIND, itemIds: { type: "array", items: { type: "string" } } },
		});
		expect(find(editor, "get_structured_facts").parameters).toEqual({
			type: "object",
			properties: { kind: KIND, factIds: { type: "array", items: { type: "string" } } },
		});
	});
});

describe("shared find_history behaviour", () => {
	it("rejects a call that names neither text nor storyId, with the same wording as before", async () => {
		const { curator, editor } = toolsFor(fakeRepo());
		for (const tools of [curator, editor]) {
			const tool = find(tools, "find_history");
			await expect(run(tool, {})).rejects.toThrow(ToolRejection);
			await expect(run(tool, {})).rejects.toThrow("Provide either text or storyId.");
		}
	});

	it("searches strictly before today and defaults the limit to 10", async () => {
		const repo = fakeRepo();
		const { curator } = toolsFor(repo);
		await run(find(curator, "find_history"), { text: "acme" });
		expect(repo.queries).toEqual([
			{ text: "acme", storyId: undefined, beforeDate: DATE, limit: 10 },
		]);
	});

	it("honours an explicit limit", async () => {
		const repo = fakeRepo();
		const { editor } = toolsFor(repo);
		await run(find(editor, "find_history"), { storyId: "s1", limit: 3 });
		expect(repo.queries[0]?.limit).toBe(3);
	});

	it("returns entries under the `entries` key for both stages", async () => {
		const { curator, editor } = toolsFor(fakeRepo());
		for (const tools of [curator, editor]) {
			const result = await run(find(tools, "find_history"), { text: "acme" });
			expect(await payload(result)).toEqual({ entries: [] });
		}
	});
});

describe("shared get_structured_facts behaviour", () => {
	it("filters the curator's facts by the item they came from", async () => {
		const { curator } = toolsFor(fakeRepo());
		const tool = find(curator, "get_structured_facts");
		const all = (await payload(await run(tool, {})))["facts"] as StructuredFact[];
		expect(all.map((f) => f.factId)).toEqual(["f1", "f2"]);

		const byItem = (await payload(await run(tool, { itemIds: ["i2"] })))[
			"facts"
		] as StructuredFact[];
		expect(byItem.map((f) => f.factId)).toEqual(["f2"]);

		const byKind = (await payload(await run(tool, { kind: "crypto" })))[
			"facts"
		] as StructuredFact[];
		expect(byKind.map((f) => f.factId)).toEqual(["f1"]);
	});

	it("filters the editor's facts by factId and hides facts outside the materials", async () => {
		const { editor } = toolsFor(fakeRepo());
		const tool = find(editor, "get_structured_facts");
		// The materials name only i1, so f2 (from i2) must not be citable at all.
		const all = (await payload(await run(tool, {})))["facts"] as StructuredFact[];
		expect(all.map((f) => f.factId)).toEqual(["f1"]);

		const byId = (await payload(await run(tool, { factIds: ["f2"] })))[
			"facts"
		] as StructuredFact[];
		expect(byId).toEqual([]);
	});
});

describe("shared helpers", () => {
	it("ok() wraps a payload as one pretty-printed text block", () => {
		expect(ok({ a: 1 })).toEqual({
			content: [{ type: "text", text: '{\n  "a": 1\n}' }],
			details: {},
		});
	});

	it("rejectFromZod renders issues as `label: path: message; …`", () => {
		const schema = z.object({ storyId: z.string().min(1), count: z.number() });
		const parsed = schema.safeParse({ storyId: "", count: "x" });
		expect(parsed.success).toBe(false);
		const error = (parsed as { error: ZodError }).error;
		const rejection = rejectFromZod('decision for "i1" rejected', error);
		expect(rejection).toBeInstanceOf(ToolRejection);
		expect(rejection.message.startsWith('decision for "i1" rejected: ')).toBe(true);
		expect(rejection.message).toContain("storyId: ");
		expect(rejection.message).toContain("count: ");
		expect(rejection.message).toContain("; ");
	});
});
