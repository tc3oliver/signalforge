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
		// Nothing else in the call succeeded either, so the commit is refused
		// outright rather than returned as a success that recorded nothing.
		await expect(
			run(tools, "commit_curation_batch", {
				decisions: [{ itemId: "rss-1", disposition: "CANDIDATE", storyId: "never-written", reason: "primary" }],
			}),
		).rejects.toThrow(/does not exist/);
		expect(await repo.listDecisions(DATE)).toEqual([]);
	});

	it("keeps a page whose sound half survives, even when a decision is refused", async () => {
		const { tools, repo } = build();
		const out = await run(tools, "commit_curation_batch", {
			decisions: [
				irrelevant("rss-3"),
				{ itemId: "rss-1", disposition: "CANDIDATE", storyId: "never-written", reason: "primary" },
			],
		});
		expect((out["decisions"] as Record<string, unknown>)["recorded"]).toBe(1);
		expect((await repo.listDecisions(DATE)).map((d) => d.itemId)).toEqual(["rss-3"]);
	});

	it("refuses a decision for a story this commit tried and failed to update, even though an older row exists", async () => {
		/*
		 * The two guards differ exactly here. An earlier work unit wrote the
		 * story, so the ledger holds its id; this commit re-writes it with a bad
		 * factRef and is refused. Recording the items against the stale row would
		 * mark them decided for good, never offer them again, and silently discard
		 * the updated judgement -- with accounting balanced and no dangling
		 * reference for anything downstream to catch.
		 */
		const { tools, repo } = build();
		await run(tools, "commit_curation_batch", {
			stories: [story()],
			decisions: [{ itemId: "rss-1", disposition: "CANDIDATE", storyId: "acme-ships-a-thing", reason: "primary" }],
		});
		const out = await run(tools, "commit_curation_batch", {
			stories: [story({ factRefs: ["no-such-fact"], sourceItemIds: ["rss-1", "rss-2"] })],
			decisions: [
				{ itemId: "rss-2", disposition: "DUPLICATE", storyId: "acme-ships-a-thing", reason: "same event" },
				irrelevant("rss-3"),
			],
		});
		const rejected = (out["decisions"] as Record<string, unknown>)["rejected"] as Array<Record<string, unknown>>;
		expect(rejected.map((r) => r["itemId"])).toEqual(["rss-2"]);
		expect(String(rejected[0]!["error"])).toContain("refused above");
		// rss-2 stays unseen, so the next session is offered it again.
		expect((await repo.listDecisions(DATE)).map((d) => d.itemId).sort()).toEqual(["rss-1", "rss-3"]);
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

describe("the budget counts decisions, not restatements", () => {
	/*
	 * A resend is the documented recovery from a partially refused commit --
	 * "fix that story and resend both" -- so it is a normal path. `recordDecisions`
	 * is an upsert keyed by item, so a resent decision writes nothing; charging
	 * the budget for it anyway closes the work unit against items the database
	 * already held, and the note the model is shown ("N decisions recorded")
	 * contradicts `processedItems` in the same payload.
	 */
	it("does not charge a second time for a decision that was already recorded", async () => {
		const turnBudget = new TurnBudget(2);
		const { tools } = build({ turnBudget });
		const payload = { decisions: [irrelevant("rss-3")] };
		await run(tools, "commit_curation_batch", payload);
		const second = await run(tools, "commit_curation_batch", payload);
		expect(turnBudget.spent).toBe(1);
		expect(turnBudget.exhausted).toBe(false);
		expect(second["turnComplete"]).toBeUndefined();
		expect(second["processedItems"]).toBe(1);
	});

	it("still charges for the new decisions in a resend that also adds one", async () => {
		const turnBudget = new TurnBudget(10);
		const { tools } = build({ turnBudget });
		await run(tools, "commit_curation_batch", { decisions: [irrelevant("rss-3")] });
		await run(tools, "commit_curation_batch", {
			decisions: [irrelevant("rss-3"), irrelevant("rss-4")],
		});
		expect(turnBudget.spent).toBe(2);
	});

	it("keeps the model's count and the database's count in agreement", async () => {
		const turnBudget = new TurnBudget(4);
		const { tools, repo } = build({ turnBudget });
		const payload = { decisions: [irrelevant("rss-3"), irrelevant("rss-4")] };
		await run(tools, "commit_curation_batch", payload);
		const second = await run(tools, "commit_curation_batch", payload);
		expect(second["processedItems"]).toBe((await repo.listDecisions(DATE)).length);
		expect(turnBudget.spent).toBe(second["processedItems"]);
	});
});

describe("a near-duplicate reaches the trace, not only the model", () => {
	/*
	 * The receipt note warns the model in-band; `pnpm observe` needs the same
	 * fact as telemetry to report fires, acceptances and declines. Batch entries
	 * do not emit their own tool calls, so if the commit does not aggregate this
	 * the whole measurement reads zero whether the check works or is deleted.
	 */
	it("reports the fire, its top candidate and its score on the commit's note", async () => {
		const seen: Array<{ name: string; summary: Record<string, unknown> }> = [];
		const { tools } = build({ onToolCall: (name, summary) => seen.push({ name, summary }) });
		await run(tools, "commit_curation_batch", {
			stories: [story({ storyId: "acme-ships-a-thing", canonicalTitle: "Acme ships a thing" })],
			decisions: [{ itemId: "rss-1", disposition: "CANDIDATE", storyId: "acme-ships-a-thing", reason: "primary" }],
		});
		await run(tools, "commit_curation_batch", {
			stories: [
				story({
					storyId: "acme-ships-the-thing",
					canonicalTitle: "Acme ships a thing, confirmed",
					sourceItemIds: ["rss-2"],
					primarySourceIds: ["rss-2"],
				}),
			],
			decisions: [{ itemId: "rss-2", disposition: "CANDIDATE", storyId: "acme-ships-the-thing", reason: "primary" }],
		});
		const near = seen.at(-1)!.summary["near"] as Array<Record<string, unknown>>;
		expect(near).toHaveLength(1);
		expect(near[0]).toMatchObject({
			storyId: "acme-ships-the-thing",
			top: "acme-ships-a-thing",
			candidates: ["acme-ships-a-thing"],
		});
		expect(Number(near[0]!["score"])).toBeGreaterThanOrEqual(0.5);
	});

	it("says nothing in the trace when nothing fired", async () => {
		const seen: Array<{ name: string; summary: Record<string, unknown> }> = [];
		const { tools } = build({ onToolCall: (name, summary) => seen.push({ name, summary }) });
		await run(tools, "commit_curation_batch", {
			stories: [story()],
			decisions: [{ itemId: "rss-1", disposition: "CANDIDATE", storyId: "acme-ships-a-thing", reason: "primary" }],
		});
		expect(seen.at(-1)!.summary["near"]).toBeUndefined();
	});
});
