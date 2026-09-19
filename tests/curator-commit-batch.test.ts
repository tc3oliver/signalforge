import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCuratorTools, type CuratorContext } from "../src/curator/tools.ts";
import { TurnBudget } from "../src/runtime/progress-yield.ts";
import { JsonStoryRepository } from "../src/stories/json-repository.ts";
import type { DailyManifest, NormalizedItem } from "../src/schemas/index.ts";

/*
 * `commit_curation_batch`: one durable commit for one page of items.
 *
 * It replaces a pair of calls that were always sent one model turn apart --
 * `upsert_stories` then `record_item_decisions` for the same fifty items -- and
 * that pairing is what these pin. The model's half is the judgement; everything
 * about persistence, validation and work-unit bookkeeping is this side of the
 * boundary, and the one thing that must never happen is a decision recorded
 * against a story that is not there.
 */

const DATE = "2026-09-19";
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "di-commit-"));
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
	item("rss-1", "Acme ships a thing"),
	item("rss-2", "Acme ships a thing, confirmed elsewhere"),
	item("rss-3", "An unrelated crypto price move"),
	item("rss-4", "Noise"),
];

function build(over: Partial<CuratorContext> = {}) {
	const manifest: DailyManifest = { date: DATE, generatedAt: DATE, items: ITEMS, facts: [] };
	const repo = new JsonStoryRepository(join(root, "ledger"));
	const ctx: CuratorContext = {
		date: DATE,
		manifest,
		repo,
		now: () => new Date("2026-09-19T12:00:00Z"),
		topicIds: new Set(["ai-infra"]),
		...over,
	};
	return { tools: createCuratorTools(ctx), repo, ctx };
}

type Tool = { name: string; execute: unknown };

async function run(all: readonly unknown[], name: string, params: unknown): Promise<Record<string, unknown>> {
	const tool = (all as Tool[]).find((t) => t.name === name);
	if (!tool) throw new Error(`no tool ${name}`);
	const execute = tool.execute as (a: string, b: unknown, c: unknown, d: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }>;
	const result = await execute("call", params, undefined, undefined, {});
	return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function story(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		storyId: "acme-ships-a-thing",
		canonicalTitle: "Acme ships a thing",
		sourceItemIds: ["rss-1"],
		primarySourceIds: ["rss-1"],
		status: "OPEN",
		changeType: "NEW",
		relevance: 0.6,
		novelty: 0.6,
		importance: 0.6,
		confidence: 0.6,
		reason: "it happened",
		...over,
	};
}

const irrelevant = (itemId: string) => ({ itemId, disposition: "IRRELEVANT", reason: "noise" });

describe("commit_curation_batch writes both halves", () => {
	it("records a page that is entirely IRRELEVANT, with no stories at all", async () => {
		const { tools, repo } = build();
		const out = await run(tools, "commit_curation_batch", {
			decisions: [irrelevant("rss-3"), irrelevant("rss-4")],
		});
		expect((out["decisions"] as Record<string, unknown>)["recorded"]).toBe(2);
		expect((out["stories"] as Record<string, unknown>)["accepted"]).toEqual([]);
		expect(out["unseenItems"]).toBe(2);
		expect((await repo.listDecisions(DATE)).length).toBe(2);
	});

	it("creates a story and attaches its items in one call", async () => {
		const { tools, repo } = build();
		const out = await run(tools, "commit_curation_batch", {
			stories: [story({ sourceItemIds: ["rss-1", "rss-2"], primarySourceIds: ["rss-1"] })],
			decisions: [
				{ itemId: "rss-1", disposition: "CANDIDATE", storyId: "acme-ships-a-thing", reason: "primary" },
				{ itemId: "rss-2", disposition: "DUPLICATE", storyId: "acme-ships-a-thing", reason: "same event" },
			],
		});
		expect(((out["stories"] as Record<string, unknown>)["accepted"] as unknown[]).length).toBe(1);
		expect((out["decisions"] as Record<string, unknown>)["recorded"]).toBe(2);
		expect((await repo.getStory("acme-ships-a-thing"))?.sourceItemIds).toEqual(["rss-1", "rss-2"]);
	});

	it("merges into a story an earlier commit created", async () => {
		const { tools, repo } = build();
		await run(tools, "commit_curation_batch", {
			stories: [story()],
			decisions: [{ itemId: "rss-1", disposition: "CANDIDATE", storyId: "acme-ships-a-thing", reason: "primary" }],
		});
		await run(tools, "commit_curation_batch", {
			// Still NEW: a non-NEW changeType asserts a PREVIOUS day's entry, which
			// this story has none of. Same-day merging is the storyId, not the type.
			stories: [story({ sourceItemIds: ["rss-1", "rss-2"] })],
			decisions: [{ itemId: "rss-2", disposition: "DUPLICATE", storyId: "acme-ships-a-thing", reason: "same event" }],
		});
		const entry = await repo.getStory("acme-ships-a-thing");
		expect(entry?.sourceItemIds).toEqual(["rss-1", "rss-2"]);
		expect((await repo.listStories(DATE)).length).toBe(1);
	});

	it("drops an unknown topic id and keeps the story, as the upsert path does", async () => {
		const { tools, repo } = build();
		const out = await run(tools, "commit_curation_batch", {
			stories: [story({ topicIds: ["ai-infra", "not-a-topic"] })],
			decisions: [{ itemId: "rss-1", disposition: "CANDIDATE", storyId: "acme-ships-a-thing", reason: "primary" }],
		});
		const accepted = (out["stories"] as Record<string, unknown>)["accepted"] as Array<Record<string, unknown>>;
		expect(accepted.length).toBe(1);
		expect(String(accepted[0]!["note"])).toContain("not-a-topic");
		expect((await repo.getStory("acme-ships-a-thing"))?.topicIds).toEqual(["ai-infra"]);
	});
});

describe("nothing recorded here dangles", () => {
	it("refuses a decision naming a story that was refused in the same call", async () => {
		const { tools, repo } = build();
		const out = await run(tools, "commit_curation_batch", {
			// changeType with no history anywhere: a genuine refusal.
			stories: [story({ changeType: "UPDATE" })],
			decisions: [
				{ itemId: "rss-1", disposition: "CANDIDATE", storyId: "acme-ships-a-thing", reason: "primary" },
				irrelevant("rss-3"),
			],
		});
		const rejectedDecisions = (out["decisions"] as Record<string, unknown>)["rejected"] as Array<Record<string, unknown>>;
		expect(rejectedDecisions.length).toBe(1);
		expect(String(rejectedDecisions[0]!["error"])).toContain("refused above");
		// The sound half of the page survived; the dangling half did not.
		expect((out["decisions"] as Record<string, unknown>)["recorded"]).toBe(1);
		const recorded = await repo.listDecisions(DATE);
		expect(recorded.map((d) => d.itemId)).toEqual(["rss-3"]);
	});

	it("refuses a decision naming a story that does not exist anywhere", async () => {
		const { tools, repo } = build();
		const out = await run(tools, "commit_curation_batch", {
			decisions: [{ itemId: "rss-1", disposition: "CANDIDATE", storyId: "never-written", reason: "primary" }],
		});
		expect((out["decisions"] as Record<string, unknown>)["recorded"]).toBe(0);
		expect(await repo.listDecisions(DATE)).toEqual([]);
	});

	it("refuses an unknown item id without touching the rest of the page", async () => {
		const { tools, repo } = build();
		const out = await run(tools, "commit_curation_batch", {
			decisions: [irrelevant("rss-3"), irrelevant("no-such-item")],
		});
		const rejected = (out["decisions"] as Record<string, unknown>)["rejected"] as Array<Record<string, unknown>>;
		expect(rejected.map((r) => r["itemId"])).toEqual(["no-such-item"]);
		expect((await repo.listDecisions(DATE)).map((d) => d.itemId)).toEqual(["rss-3"]);
	});

	it("keeps sound stories when one entry in the batch has a genuine error", async () => {
		const { tools, repo } = build();
		const out = await run(tools, "commit_curation_batch", {
			stories: [
				story(),
				story({ storyId: "bad-story", canonicalTitle: "Bad", sourceItemIds: ["no-such-item"], primarySourceIds: ["no-such-item"] }),
			],
			decisions: [irrelevant("rss-3")],
		});
		const s = out["stories"] as Record<string, unknown>;
		expect((s["accepted"] as unknown[]).length).toBe(1);
		expect((s["rejected"] as Array<Record<string, unknown>>)[0]!["storyId"]).toBe("bad-story");
		expect(await repo.getStory("acme-ships-a-thing")).toBeDefined();
		expect(await repo.getStory("bad-story")).toBeUndefined();
	});

	it("is idempotent, so a resend after a provider failure does not double-write", async () => {
		const { tools, repo } = build();
		const payload = {
			stories: [story()],
			decisions: [{ itemId: "rss-1", disposition: "CANDIDATE", storyId: "acme-ships-a-thing", reason: "primary" }],
		};
		await run(tools, "commit_curation_batch", payload);
		await run(tools, "commit_curation_batch", payload);
		expect((await repo.listStories(DATE)).length).toBe(1);
		expect((await repo.listDecisions(DATE)).length).toBe(1);
	});
});

describe("the work unit closes on the commit", () => {
	it("answers turnComplete once the commit spends the budget and work remains", async () => {
		const turnBudget = new TurnBudget(2);
		const { tools } = build({ turnBudget });
		const out = await run(tools, "commit_curation_batch", {
			decisions: [irrelevant("rss-3"), irrelevant("rss-4")],
		});
		expect(out["turnComplete"]).toBe(true);
		expect(String(out["note"])).toContain("Stop now");
	});

	it("does not say turnComplete while the budget is unspent", async () => {
		const turnBudget = new TurnBudget(10);
		const { tools } = build({ turnBudget });
		const out = await run(tools, "commit_curation_batch", { decisions: [irrelevant("rss-3")] });
		expect(out["turnComplete"]).toBeUndefined();
	});

	it("does not say turnComplete when the page finished the day, so the model can submit", async () => {
		const turnBudget = new TurnBudget(4);
		const { tools } = build({ turnBudget });
		const out = await run(tools, "commit_curation_batch", {
			decisions: ITEMS.map((i) => irrelevant(i.id)),
		});
		expect(out["unseenItems"]).toBe(0);
		expect(out["turnComplete"]).toBeUndefined();
	});

	it("does not charge the budget for a refused decision", async () => {
		const turnBudget = new TurnBudget(10);
		const { tools } = build({ turnBudget });
		await run(tools, "commit_curation_batch", {
			decisions: [irrelevant("rss-3"), irrelevant("no-such-item")],
		});
		expect(turnBudget.spent).toBe(1);
	});
});
