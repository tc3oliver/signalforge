import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildWorkUnitBrief, renderWorkUnitBrief } from "../src/curator/work-unit.ts";
import { JsonStoryRepository } from "../src/stories/json-repository.ts";
import type { DailyManifest, NormalizedItem } from "../src/schemas/index.ts";

/*
 * The state a work unit is handed instead of fetching.
 *
 * On 2026-09-19 each of the twelve units opened with `get_daily_inventory`,
 * `list_unseen_items` and `list_today_stories` -- three model turns per unit,
 * thirty-three of the day's 112, for values TypeScript had already computed.
 * These pin that the brief carries them faithfully, because a brief that is
 * merely approximately right is worse than the fetch it replaces: the model
 * would act on it without knowing to check.
 */

const DATE = "2026-09-19";
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "di-work-unit-"));
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
		summary: `${title} summary`,
		content: title,
		publishedAt: "2026-09-19T00:00:00.000Z",
		metadata: {},
		trust: "UNTRUSTED_EXTERNAL_CONTENT",
	} as NormalizedItem;
}

const ITEMS = Array.from({ length: 8 }, (_, i) => item(`rss-${i}`, `Item ${i}`));
const manifest: DailyManifest = { date: DATE, generatedAt: DATE, items: ITEMS, facts: [] };

function repo() {
	return new JsonStoryRepository(join(root, "ledger"));
}

async function seedStory(r: JsonStoryRepository, storyId: string): Promise<void> {
	await r.upsertStory(
		DATE,
		{
			storyId,
			canonicalTitle: `Title for ${storyId}`,
			sourceItemIds: ["rss-0"],
			primarySourceIds: ["rss-0"],
			factRefs: [],
			topicIds: [],
			status: "OPEN",
			changeType: "NEW",
			relevance: 0.5,
			novelty: 0.5,
			importance: 0.5,
			confidence: 0.5,
			reason: "seeded",
		},
		new Date("2026-09-19T00:00:00Z"),
	);
}

describe("the brief reports the day as it is", () => {
	it("counts what is offered, decided and unseen", async () => {
		const r = repo();
		await r.recordDecisions(DATE, [
			{ itemId: "rss-0", disposition: "IRRELEVANT", reason: "noise", decidedAt: "2026-09-19T00:00:00.000Z" },
		]);
		const brief = await buildWorkUnitBrief({
			date: DATE,
			manifest,
			repo: r,
			screenedOutItemIds: new Set(["rss-7"]),
		});
		expect(brief.manifestItems).toBe(8);
		expect(brief.screenedOut).toBe(1);
		expect(brief.totalItems).toBe(7);
		expect(brief.decided).toBe(1);
		expect(brief.unseen).toBe(6);
	});

	it("seeds the next undecided items in publication order, never a decided one", async () => {
		const r = repo();
		await r.recordDecisions(DATE, [
			{ itemId: "rss-0", disposition: "IRRELEVANT", reason: "noise", decidedAt: "2026-09-19T00:00:00.000Z" },
			{ itemId: "rss-1", disposition: "IRRELEVANT", reason: "noise", decidedAt: "2026-09-19T00:00:00.000Z" },
		]);
		const brief = await buildWorkUnitBrief({ date: DATE, manifest, repo: r, screenedOutItemIds: new Set() });
		expect(brief.page.map((p) => p.id)).toEqual(["rss-2", "rss-3", "rss-4", "rss-5", "rss-6", "rss-7"]);
	});

	it("never seeds a screened-out item", async () => {
		const brief = await buildWorkUnitBrief({
			date: DATE,
			manifest,
			repo: repo(),
			screenedOutItemIds: new Set(["rss-2", "rss-3"]),
		});
		expect(brief.page.map((p) => p.id)).not.toContain("rss-2");
		expect(brief.page.map((p) => p.id)).not.toContain("rss-3");
	});

	it("names every story today holds, so nothing to merge into is hidden", async () => {
		const r = repo();
		await seedStory(r, "story-a");
		await seedStory(r, "story-b");
		const brief = await buildWorkUnitBrief({ date: DATE, manifest, repo: r, screenedOutItemIds: new Set() });
		expect(brief.storyIds).toEqual(["story-a", "story-b"]);
	});

	it("seeds no more than the unit is allowed to decide, and says what is left", async () => {
		const brief = await buildWorkUnitBrief({
			date: DATE,
			manifest,
			repo: repo(),
			screenedOutItemIds: new Set(),
			decisionBudget: 3,
		});
		expect(brief.page.length).toBe(3);
		expect(brief.remainingAfterPage).toBe(5);
		expect(brief.nextCursor).toBe("rss-3");
	});

	it("seeds an empty page, not a stale one, once everything is decided", async () => {
		const r = repo();
		await r.recordDecisions(
			DATE,
			ITEMS.map((i) => ({ itemId: i.id, disposition: "IRRELEVANT" as const, reason: "noise", decidedAt: "2026-09-19T00:00:00.000Z" })),
		);
		const brief = await buildWorkUnitBrief({ date: DATE, manifest, repo: r, screenedOutItemIds: new Set() });
		expect(brief.page).toEqual([]);
		expect(brief.unseen).toBe(0);
	});
});

describe("what the model is shown", () => {
	it("carries the ids, the items and the counts, and tells it not to refetch the page", async () => {
		const r = repo();
		await seedStory(r, "story-a");
		const text = renderWorkUnitBrief(
			await buildWorkUnitBrief({ date: DATE, manifest, repo: r, screenedOutItemIds: new Set(), decisionBudget: 4 }),
		);
		expect(text).toContain("story-a");
		expect(text).toContain("rss-0");
		expect(text).toContain("do not call `list_unseen_items` to fetch this page");
		expect(text).toContain("commit_curation_batch");
		expect(text).toContain("turnComplete");
	});

	it("sends a finished day to submit_materials instead of to a batch", async () => {
		const r = repo();
		await r.recordDecisions(
			DATE,
			ITEMS.map((i) => ({ itemId: i.id, disposition: "IRRELEVANT" as const, reason: "noise", decidedAt: "2026-09-19T00:00:00.000Z" })),
		);
		const text = renderWorkUnitBrief(
			await buildWorkUnitBrief({ date: DATE, manifest, repo: r, screenedOutItemIds: new Set() }),
		);
		expect(text).toContain("submit_materials");
		expect(text).toContain("No items are waiting");
	});

	it("is honest about an empty ledger rather than silent", async () => {
		const text = renderWorkUnitBrief(
			await buildWorkUnitBrief({ date: DATE, manifest, repo: repo(), screenedOutItemIds: new Set() }),
		);
		expect(text).toContain("No stories exist for today yet");
	});
});
