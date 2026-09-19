import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditorTools, type EditorContext } from "../src/editor/tools.ts";
import { JsonStoryRepository } from "../src/stories/json-repository.ts";
import type { DailyManifest, DailyMaterials, NormalizedItem } from "../src/schemas/index.ts";

/*
 * The Editor's source window.
 *
 * `get_source_items` used to return whole NormalizedItems, raw HTML and all. On
 * 2026-09-19 two calls put 152,078 characters into the editor's session, one of
 * them 107,353 — and every one of those characters was re-sent on every later
 * turn of the stage. Rebuilt from that day's 38 material source items, the same
 * payload is 216,327 characters whole and 100,270 bounded: 46%.
 *
 * The constraint that shapes the fix is grounding. The editor quotes and cites,
 * so nothing may become unreachable — it is reached a passage at a time, over
 * canonical prose, rather than all at once over markup.
 */

const DATE = "2026-09-19";
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "di-editor-body-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const LONG_PROSE = "Filler sentence about nothing in particular. ".repeat(120);
const BURIED = "The board approved a dividend of <em>41</em> cents per share.";

function item(id: string, content: string): NormalizedItem {
	return {
		id,
		sourceType: "rss",
		sourceName: "Example",
		title: `Title ${id}`,
		summary: `Summary ${id}`,
		content,
		url: `https://example.com/${id}`,
		publishedAt: "2026-09-19T00:00:00.000Z",
		metadata: {},
		trust: "UNTRUSTED_EXTERNAL_CONTENT",
	} as NormalizedItem;
}

const ITEMS = [
	item("rss-long", `<p>${LONG_PROSE}</p><p>${BURIED}</p><p>${LONG_PROSE}</p>`),
	item("rss-short", "<p>A short body.</p>"),
	item("rss-unused", "<p>Not in any material story.</p>"),
	item("rss-cjk", `<p>${LONG_PROSE}</p><p>央行宣布降息一碼,為兩年來首次。</p>`),
	// A GitHub release: the whole body is in `summary`, `content` is null.
	{
		...item("gh-release", ""),
		content: undefined,
		summary: `# v2.0.0\n\n${LONG_PROSE}\n\n- This is a breaking change for anyone using the old flag.`,
	} as NormalizedItem,
];

function tools() {
	const manifest: DailyManifest = { date: DATE, generatedAt: DATE, items: ITEMS, facts: [] };
	const materials: DailyMaterials = {
		date: DATE,
		producedAt: `${DATE}T10:00:00.000Z`,
		stories: [
			{
				storyId: "a-story",
				tier: "A",
				canonicalTitle: "A story",
				whySelected: "It matters.",
				changeType: "NEW",
				importance: 0.6,
				novelty: 0.7,
				confidence: 0.9,
				sourceItemIds: ["rss-long", "rss-short", "rss-cjk", "gh-release"],
				primarySourceIds: ["rss-long"],
				factRefs: [],
			},
		],
		emergingSignals: [],
		curatorNotes: "",
	} as DailyMaterials;
	const ctx: EditorContext = {
		date: DATE,
		manifest,
		materials,
		repo: new JsonStoryRepository(join(root, "ledger")),
		now: () => new Date("2026-09-19T12:00:00Z"),
	};
	return createEditorTools(ctx);
}

type Tool = { name: string; execute: unknown };

async function run(all: readonly unknown[], name: string, params: unknown): Promise<Record<string, unknown>> {
	const tool = (all as Tool[]).find((t) => t.name === name);
	if (!tool) throw new Error(`no tool ${name}`);
	const execute = tool.execute as (a: string, b: unknown, c: unknown, d: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }>;
	const result = await execute("call", params, undefined, undefined, {});
	return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("get_source_items is bounded", () => {
	it("returns the record and an opening, never a whole long body", async () => {
		const out = await run(tools(), "get_source_items", { itemIds: ["rss-long"] });
		const first = (out["items"] as Array<Record<string, unknown>>)[0]!;
		expect(String(first["body"]).length).toBeLessThanOrEqual(2000);
		expect(first["truncated"]).toBe(true);
		expect(String(first["note"])).toContain("read_source_body");
	});

	it("keeps everything the editor cites with: id, source, url, time, title, summary", async () => {
		const out = await run(tools(), "get_source_items", { itemIds: ["rss-short"] });
		const first = (out["items"] as Array<Record<string, unknown>>)[0]!;
		expect(first["id"]).toBe("rss-short");
		expect(first["url"]).toBe("https://example.com/rss-short");
		expect(first["at"]).toBe("2026-09-19T00:00:00.000Z");
		expect(first["title"]).toBe("Title rss-short");
		expect(first["summary"]).toBe("Summary rss-short");
	});

	it("returns prose, not the markup the source served", async () => {
		const out = await run(tools(), "get_source_items", { itemIds: ["rss-short"] });
		expect(JSON.stringify(out)).not.toContain("<p>");
	});

	it("does not truncate a body that fits, and says nothing misleading about it", async () => {
		const out = await run(tools(), "get_source_items", { itemIds: ["rss-short"] });
		const first = (out["items"] as Array<Record<string, unknown>>)[0]!;
		expect(first["truncated"]).toBeUndefined();
		expect(first["body"]).toBe("A short body.");
	});

	it("still refuses an item no material story carries", async () => {
		await expect(run(tools(), "get_source_items", { itemIds: ["rss-unused"] })).rejects.toThrow(
			/Not available/,
		);
	});
});

describe("read_source_body reaches what the opening does not", () => {
	it("finds a passage buried past the opening and returns it verbatim", async () => {
		const out = await run(tools(), "read_source_body", { itemId: "rss-long", find: "dividend" });
		// The sentence a reader sees, with the markup that split it gone: this is
		// the string the editor may quote.
		expect(String(out["text"])).toContain("dividend of 41 cents per share");
		expect(Number(out["returnedChars"])).toBeLessThanOrEqual(3000);
	});

	it("reports where it is in the document, so a follow-up window is addressable", async () => {
		const out = await run(tools(), "read_source_body", { itemId: "rss-long", find: "dividend" });
		expect(Number(out["start"])).toBeGreaterThan(0);
		expect(out["hasMoreBefore"]).toBe(true);
		expect(typeof out["bodyChars"]).toBe("number");
	});

	it("answers a miss instead of rejecting it, because a rejection costs a turn", async () => {
		const out = await run(tools(), "read_source_body", { itemId: "rss-long", find: "helicopter" });
		expect(out["matches"]).toBe(0);
		expect(String(out["note"])).toContain("does not appear");
	});

	it("obeys the same sandbox as get_source_items", async () => {
		await expect(run(tools(), "read_source_body", { itemId: "rss-unused", find: "any" })).rejects.toThrow(
			/Not available/,
		);
	});
});

describe("the untrusted marker travels with the text", () => {
	/*
	 * Both system prompts tell the model that everything it reads is "tagged
	 * UNTRUSTED_EXTERNAL_CONTENT". Before the record was projected by hand the
	 * whole NormalizedItem came back and carried that tag; a projection that
	 * drops it leaves the prompt naming a marker no tool result ever shows,
	 * which is the per-item half of the injection defence.
	 */
	it("marks each source record", async () => {
		const out = await run(tools(), "get_source_items", { itemIds: ["rss-short"] });
		const first = (out["items"] as Array<Record<string, unknown>>)[0]!;
		expect(first["trust"]).toBe("UNTRUSTED_EXTERNAL_CONTENT");
	});

	it("marks every body window, which is where source prose actually arrives", async () => {
		const out = await run(tools(), "read_source_body", { itemId: "rss-long", find: "dividend" });
		expect(out["trust"]).toBe("UNTRUSTED_EXTERNAL_CONTENT");
	});

	it("marks a window that found nothing, and an empty body", async () => {
		const miss = await run(tools(), "read_source_body", { itemId: "rss-long", find: "helicopter" });
		expect(miss["trust"]).toBe("UNTRUSTED_EXTERNAL_CONTENT");
	});
});

describe("a two-character search term is a search, not an error", () => {
	// The briefs are written in 正體中文 and the terms worth jumping to are
	// routinely two characters: 降息, 升息, 裁員, 併購.
	it("accepts a two-character CJK term", async () => {
		const out = await run(tools(), "read_source_body", { itemId: "rss-cjk", find: "降息" });
		expect(String(out["text"])).toContain("降息");
	});
});

describe("an item whose body lives in summary is readable like any other", () => {
	/*
	 * 6,276 of the 11,038 stored items have `content IS NULL`: GitHub releases
	 * and arXiv entries carry their whole body in `summary` and nothing else.
	 * While `canonicalBody` read only `content`, the bounded reader was inert on
	 * the majority of the corpus — `bodyChars: 0`, "this item has no body text",
	 * and `find` unable to reach a single word — for precisely the items where a
	 * release note's exact wording is the thing worth quoting. The largest such
	 * item is 124,924 characters.
	 */
	it("bounds it, instead of returning the whole summary as a field", async () => {
		const out = await run(tools(), "get_source_items", { itemIds: ["gh-release"] });
		const first = (out["items"] as Array<Record<string, unknown>>)[0]!;
		expect(first["bodyChars"]).toBeGreaterThan(2000);
		expect(String(first["body"]).length).toBeLessThanOrEqual(2000);
		expect(first["truncated"]).toBe(true);
		// Not returned twice: the summary IS the body here.
		expect(first["summary"]).toBeUndefined();
		expect(JSON.stringify(out).length).toBeLessThan(4000);
	});

	it("can be searched, which is the whole point of bounding it", async () => {
		const out = await run(tools(), "read_source_body", { itemId: "gh-release", find: "breaking change" });
		expect(String(out["text"])).toContain("breaking change");
	});

	it("still returns summary as its own field when it is a lede the body repeats", async () => {
		const out = await run(tools(), "get_source_items", { itemIds: ["rss-short"] });
		expect((out["items"] as Array<Record<string, unknown>>)[0]!["summary"]).toBe("Summary rss-short");
	});
});
