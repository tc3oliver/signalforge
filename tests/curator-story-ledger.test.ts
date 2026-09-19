import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCuratorTools, type CuratorContext } from "../src/curator/tools.ts";
import { JsonStoryRepository } from "../src/stories/json-repository.ts";
import type { DailyManifest, NormalizedItem } from "../src/schemas/index.ts";

/*
 * The story ledger, as the Curator pays for it.
 *
 * `list_today_stories` is called about once per work unit and its result is
 * re-sent on every later turn of that unit. On 2026-09-19 nine calls returned
 * 28 stories and then 153, 103,557 characters, of which 45 rows were ever
 * re-used -- and the day still shipped `openai-astra-for-law` beside
 * `openai-astra-law`, one event under two slugs, written with the whole list in
 * context both times.
 *
 * So these pin both halves of the answer: the default result names every story
 * and nothing else, and a near-duplicate is reported at the moment it is
 * written rather than left to be noticed in a list.
 */

const DATE = "2026-09-19";
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "di-ledger-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function item(id: string, title: string): NormalizedItem {
	return {
		id,
		sourceType: "rss",
		sourceName: "Example",
		title,
		summary: title,
		content: title,
		publishedAt: "2026-09-19T00:00:00.000Z",
		metadata: {},
		trust: "UNTRUSTED_EXTERNAL_CONTENT",
	} as NormalizedItem;
}

const ITEMS = [
	item("rss-1", "OpenAI ships Astra for Law"),
	item("rss-2", "OpenAI Astra for Law confirmed by a second outlet"),
	item("rss-3", "jemalloc 5.4.0 released"),
];

function tools() {
	const manifest: DailyManifest = { date: DATE, generatedAt: DATE, items: ITEMS, facts: [] };
	const ctx: CuratorContext = {
		date: DATE,
		manifest,
		repo: new JsonStoryRepository(join(root, "ledger")),
		now: () => new Date("2026-09-19T12:00:00Z"),
	};
	return createCuratorTools(ctx);
}

type Tool = { name: string; execute: unknown };

/** One story through the single writer, shaped like the old single-story call. */
async function upsert(all: readonly unknown[], payload: Record<string, unknown>): Promise<Record<string, unknown>> {
	const out = await run(all, "commit_curation_batch", { stories: [payload] });
	const stories = out["stories"] as Record<string, unknown>;
	const accepted = (stories["accepted"] as Array<Record<string, unknown>>)[0];
	const rejected = stories["rejected"] as Array<{ error: string }> | undefined;
	if (!accepted) throw new Error(rejected?.[0]?.error ?? "no story accepted");
	return { story: accepted, ...(accepted["note"] ? { note: accepted["note"] } : {}) };
}

async function run(all: readonly unknown[], name: string, params: unknown): Promise<Record<string, unknown>> {
	const tool = (all as Tool[]).find((t) => t.name === name);
	if (!tool) throw new Error(`no tool ${name}`);
	const execute = tool.execute as (a: string, b: unknown, c: unknown, d: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }>;
	const result = await execute("call", params, undefined, undefined, {});
	return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function story(over: Record<string, unknown>): Record<string, unknown> {
	return {
		storyId: "a-story",
		canonicalTitle: "A story",
		sourceItemIds: ["rss-1"],
		primarySourceIds: ["rss-1"],
		status: "OPEN",
		changeType: "NEW",
		relevance: 0.5,
		novelty: 0.5,
		importance: 0.5,
		confidence: 0.5,
		reason: "because",
		...over,
	};
}

describe("list_today_stories default result", () => {
	it("names every story and carries no other field", async () => {
		const all = tools();
		await upsert(all, story({ storyId: "openai-astra-for-law", canonicalTitle: "OpenAI ships Astra for Law" }));
		await upsert(all, story({ storyId: "jemalloc-5-4-0", canonicalTitle: "jemalloc 5.4.0 released", sourceItemIds: ["rss-3"], primarySourceIds: ["rss-3"] }));

		const out = await run(all, "list_today_stories", {});
		expect(out["total"]).toBe(2);
		expect(out["storyIds"]).toEqual(["openai-astra-for-law", "jemalloc-5-4-0"]);
		// No titles, changeTypes or counts: those were 73% of what the day paid for.
		expect(JSON.stringify(out)).not.toContain("jemalloc 5.4.0 released");
	});

	it("is complete, so nothing a later session could merge into is invisible", async () => {
		const all = tools();
		for (let i = 0; i < 40; i += 1) {
			await upsert(all, story({ storyId: `story-${i}`, canonicalTitle: `Story number ${i}` }));
		}
		const out = await run(all, "list_today_stories", {});
		expect(out["total"]).toBe(40);
		expect((out["storyIds"] as string[]).length).toBe(40);
	});
});

describe("list_today_stories match", () => {
	it("ranks by title overlap and returns the fields a slug does not carry", async () => {
		const all = tools();
		await upsert(all, story({ storyId: "openai-astra-for-law", canonicalTitle: "OpenAI ships Astra for Law" }));
		await upsert(all, story({ storyId: "jemalloc-5-4-0", canonicalTitle: "jemalloc 5.4.0 released", sourceItemIds: ["rss-3"], primarySourceIds: ["rss-3"] }));

		const out = await run(all, "list_today_stories", { match: "OpenAI Astra for Law confirmed by a second outlet" });
		const matches = out["matches"] as Array<Record<string, unknown>>;
		expect(matches[0]!["storyId"]).toBe("openai-astra-for-law");
		expect(matches[0]!["title"]).toBe("OpenAI ships Astra for Law");
		expect(matches.some((m) => m["storyId"] === "jemalloc-5-4-0")).toBe(false);
		expect(out["total"]).toBe(2);
	});

	it("honours limit", async () => {
		const all = tools();
		for (let i = 0; i < 12; i += 1) {
			await upsert(all, story({ storyId: `openai-story-${i}`, canonicalTitle: `OpenAI ships thing ${i}` }));
		}
		const out = await run(all, "list_today_stories", { match: "OpenAI ships thing", limit: 3 });
		expect((out["matches"] as unknown[]).length).toBe(3);
	});

	it("returns no matches rather than failing when nothing overlaps", async () => {
		const all = tools();
		await upsert(all, story({ storyId: "jemalloc-5-4-0", canonicalTitle: "jemalloc 5.4.0 released", sourceItemIds: ["rss-3"], primarySourceIds: ["rss-3"] }));
		const out = await run(all, "list_today_stories", { match: "quantum tunnelling in beetles" });
		expect(out["matches"]).toEqual([]);
	});
});

describe("a near-duplicate is reported when it is written", () => {
	it("names today's similar story in the receipt note", async () => {
		const all = tools();
		await upsert(all, story({ storyId: "openai-astra-for-law", canonicalTitle: "OpenAI ships Astra for Law" }));
		const out = await upsert(all, story({
				storyId: "openai-astra-law",
				canonicalTitle: "OpenAI ships Astra for Law, confirmed",
				sourceItemIds: ["rss-2"],
				primarySourceIds: ["rss-2"],
			}));
		expect(String(out["note"])).toContain("openai-astra-for-law");
		// Advisory only: the story was still written.
		expect((out["story"] as Record<string, unknown>)["storyId"]).toBe("openai-astra-law");
	});

	it("says nothing when the story is unlike anything today", async () => {
		const all = tools();
		await upsert(all, story({ storyId: "openai-astra-for-law", canonicalTitle: "OpenAI ships Astra for Law" }));
		const out = await upsert(all, story({ storyId: "jemalloc-5-4-0", canonicalTitle: "jemalloc 5.4.0 released", sourceItemIds: ["rss-3"], primarySourceIds: ["rss-3"] }));
		expect(out["note"]).toBeUndefined();
	});

	it("says nothing when merging into the story it resembles", async () => {
		const all = tools();
		await upsert(all, story({ storyId: "openai-astra-for-law", canonicalTitle: "OpenAI ships Astra for Law" }));
		const out = await upsert(all, story({
				storyId: "openai-astra-for-law",
				canonicalTitle: "OpenAI ships Astra for Law",
				sourceItemIds: ["rss-1", "rss-2"],
				primarySourceIds: ["rss-1"],
			}));
		expect(out["note"]).toBeUndefined();
	});

	it("catches a duplicate written inside one batch", async () => {
		const all = tools();
		const out = await run(all, "commit_curation_batch", {
			stories: [
				story({ storyId: "openai-astra-for-law", canonicalTitle: "OpenAI ships Astra for Law" }),
				story({
					storyId: "openai-astra-law",
					canonicalTitle: "OpenAI ships Astra for Law, confirmed",
					sourceItemIds: ["rss-2"],
					primarySourceIds: ["rss-2"],
				}),
			],
		});
		expect(JSON.stringify(out)).toContain("openai-astra-for-law");
		expect(JSON.stringify(out)).toContain("may be the same event");
	});
});
