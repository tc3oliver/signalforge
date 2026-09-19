import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCuratorTools, type CuratorContext } from "../src/curator/tools.ts";
import { JsonStoryRepository } from "../src/stories/json-repository.ts";
import type { DailyManifest, NormalizedItem } from "../src/schemas/index.ts";

/*
 * The 2026-09-19 production run put 228,130 characters of raw item body into
 * the Curator's session across four calls, the largest 96,703. A tool result is
 * re-sent on every later turn of its work unit -- six times, for those calls --
 * so that one habit cost an estimated 156,000 tokens of the day's curation.
 *
 * These tests pin the two properties that fix it: no call can return a whole
 * long body, and the body the Curator reads is prose rather than markup, so a
 * window and an offset mean what they appear to mean.
 */

const DATE = "2026-09-19";
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "di-item-body-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function item(over: Partial<NormalizedItem> & { id: string }): NormalizedItem {
	return {
		sourceType: "rss",
		sourceName: "Example",
		title: "A title",
		summary: "A summary",
		publishedAt: "2026-09-19T00:00:00.000Z",
		metadata: {},
		trust: "UNTRUSTED_EXTERNAL_CONTENT",
		...over,
	} as NormalizedItem;
}

function tools(items: NormalizedItem[]) {
	const manifest: DailyManifest = { date: DATE, generatedAt: DATE, items, facts: [] };
	const ctx: CuratorContext = {
		date: DATE,
		manifest,
		repo: new JsonStoryRepository(join(root, "ledger")),
		now: () => new Date("2026-09-19T12:00:00Z"),
	};
	return createCuratorTools(ctx);
}

async function run(tool: { execute: unknown }, params: unknown): Promise<Record<string, unknown>> {
	const execute = tool.execute as (a: string, b: unknown, c: unknown, d: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }>;
	const result = await execute("call", params, undefined, undefined, {});
	return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("get_item_detail is bounded", () => {
	it("never returns a whole long body, and says how much there is", async () => {
		const body = `<p>${"alpha ".repeat(12_000)}</p>`;
		const set = tools([item({ id: "i1", content: body })]);
		const out = await run(set.find((t) => t.name === "get_item_detail")!, { itemIds: ["i1"] });
		const items = out["items"] as Array<Record<string, unknown>>;
		expect((items[0]!["body"] as string).length).toBe(1500);
		expect(items[0]!["truncated"]).toBe(true);
		expect(items[0]!["bodyChars"]).toBeGreaterThan(50_000);
		// The whole result stays far below the 20k-character results that caused this.
		expect(JSON.stringify(out).length).toBeLessThan(2_500);
		expect(out["note"]).toMatch(/read_item_body/);
	});

	it("returns a short body whole, with no truncation marker", async () => {
		const set = tools([item({ id: "i1", content: "<p>Short and complete.</p>" })]);
		const out = await run(set.find((t) => t.name === "get_item_detail")!, { itemIds: ["i1"] });
		const items = out["items"] as Array<Record<string, unknown>>;
		expect(items[0]!["body"]).toBe("Short and complete.");
		expect(items[0]!["truncated"]).toBeUndefined();
		expect(out["note"]).toBeUndefined();
	});
});

describe("read_item_body", () => {
	/*
	 * The case that motivated `find`: on the real 2026-09-19 item behind a Must
	 * Know story, the decisive phrase sat at 55% of the body. A head read misses
	 * it; a search for a term the Curator can guess from the headline does not.
	 */
	const longBody = `<p>${"lead in. ".repeat(300)}</p><p>The correct answer is no more than 30 words.</p><p>${"tail. ".repeat(300)}</p>`;

	it("centres the window on a match and reports where the others are", async () => {
		const set = tools([item({ id: "i1", content: longBody })]);
		const out = await run(set.find((t) => t.name === "read_item_body")!, { itemId: "i1", find: "30 words" });
		expect(out["text"]).toContain("no more than 30 words");
		expect(out["matchOffsets"]).toEqual([expect.any(Number)]);
		expect(out["hasMoreBefore"]).toBe(true);
		expect(out["hasMoreAfter"]).toBe(true);
		expect((out["text"] as string).length).toBeLessThanOrEqual(3000);
	});

	it("caps the window even when more is asked for", async () => {
		const set = tools([item({ id: "i1", content: longBody })]);
		const out = await run(set.find((t) => t.name === "read_item_body")!, { itemId: "i1", start: 0, length: 3000 });
		expect(out["returnedChars"]).toBe(3000);
		expect(out["nextStart"]).toBe(3000);
	});

	it("answers 'not in this document' instead of refusing, because a refusal costs a turn", async () => {
		const set = tools([item({ id: "i1", content: longBody })]);
		const out = await run(set.find((t) => t.name === "read_item_body")!, { itemId: "i1", find: "helicopter" });
		expect(out["matches"]).toBe(0);
		expect(out["note"]).toMatch(/does not appear/);
	});

	it("reads prose, not markup, so offsets and windows mean something", async () => {
		// The real failure this prevents: a sentence a reader sees whole is split
		// by tags in the raw bytes, and a window over raw HTML spends its budget
		// on attributes nobody can use.
		const set = tools([item({ id: "i1", content: '<p>My proof has <em>not</em> been verified.</p><script>var x=1;</script>' })]);
		const out = await run(set.find((t) => t.name === "read_item_body")!, { itemId: "i1", find: "not been verified" });
		expect(out["text"]).toContain("My proof has not been verified.");
		expect(out["text"]).not.toContain("script");
	});

	it("says so plainly when an item has no body at all", async () => {
		// No content AND no summary: 6,276 of 11,038 stored items have no content
		// and carry their whole body in summary, so "no content" alone is not an
		// empty item.
		const set = tools([item({ id: "i1", content: "", summary: "" })]);
		const out = await run(set.find((t) => t.name === "read_item_body")!, { itemId: "i1" });
		expect(out["bodyChars"]).toBe(0);
		expect(out["note"]).toMatch(/no body text/);
	});

	it("refuses an item id that is not in the manifest", async () => {
		const set = tools([item({ id: "i1", content: "x" })]);
		const tool = set.find((t) => t.name === "read_item_body")!;
		await expect(run(tool, { itemId: "nope" })).rejects.toThrow(/Unknown item id/);
	});
});
