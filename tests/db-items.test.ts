import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CollectedItem } from "../src/collectors/types.ts";
import { saveBrief } from "../src/db/briefs.ts";
import { createSql, type Sql } from "../src/db/client.ts";
import { dispositionCounts, explainItem } from "../src/db/decisions.ts";
import { countRawItems, getNormalizedItem, upsertNormalizedItems, upsertRawItems } from "../src/db/items.ts";
import { migrate } from "../src/db/migrate.ts";
import { observeSignal } from "../src/db/signals.ts";
import { announceSkip, probeDatabase, purgeLineage, testLineage } from "../src/db/test-support.ts";
import type { DailyBrief } from "../src/schemas/brief.ts";
import { PostgresStoryRepository } from "../src/stories/postgres-repository.ts";

const probe = await probeDatabase();
announceSkip("db-items", probe);

function collected(externalId: string, over: Partial<CollectedItem> = {}): CollectedItem {
	return {
		sourceType: "rss",
		sourceName: "Example Feed",
		externalId,
		title: `Item ${externalId}`,
		summary: "summary",
		publishedAt: "2026-09-13T06:00:00.000Z",
		metadata: {},
		trust: "UNTRUSTED_EXTERNAL_CONTENT",
		raw: { externalId, body: { id: externalId, payload: "verbatim" }, fetchedAt: "2026-09-13T06:05:00.000Z" },
		...over,
	};
}

describe.skipIf(!probe.available)("raw + normalized items", () => {
	let sql: Sql;
	let lineage: string;
	let suffix: string;

	beforeAll(async () => {
		sql = createSql();
		await migrate(sql);
	});

	afterAll(async () => {
		if (lineage) {
			await purgeLineage(sql, lineage);
			// raw_items is keyed globally, not per lineage, so its test rows are
			// cleaned by their synthetic external ids.
			await sql`delete from raw_items where external_id like ${`${suffix}%`}`;
		}
		await sql?.end({ timeout: 5 });
	});

	beforeEach(async () => {
		if (lineage) await purgeLineage(sql, lineage);
		lineage = testLineage("items");
		suffix = lineage;
	});

	it("re-collecting the same provider record does not duplicate it", async () => {
		const items = [collected(`${suffix}-1`), collected(`${suffix}-2`)];
		const before = await countRawItems(sql);

		const first = await upsertRawItems(sql, items);
		expect(first.map((r) => r.inserted)).toEqual([true, true]);
		expect(await countRawItems(sql)).toBe(before + 2);

		const second = await upsertRawItems(sql, items);
		expect(second.map((r) => r.inserted)).toEqual([false, false]);
		expect(second.map((r) => r.rawItemId)).toEqual(first.map((r) => r.rawItemId));
		expect(await countRawItems(sql)).toBe(before + 2);
	});

	it("keeps the provider payload verbatim and links the normalized row to it", async () => {
		const [ref] = await upsertRawItems(sql, [collected(`${suffix}-3`)]);
		expect(ref).toBeDefined();
		await upsertNormalizedItems(sql, lineage, [
			{
				id: `${suffix}-3`,
				sourceType: "rss",
				trust: "UNTRUSTED_EXTERNAL_CONTENT" as const,
				sourceName: "Example Feed",
				title: "A normalized title",
				summary: "normalized summary",
				publishedAt: "2026-09-13T06:00:00.000Z",
				metadata: { feed: "example" },
				rawItemId: ref?.rawItemId,
			},
		]);

		const stored = await getNormalizedItem(sql, lineage, `${suffix}-3`);
		expect(stored?.title).toBe("A normalized title");
		expect(stored?.metadata).toEqual({ feed: "example" });

		const raw = await sql<{ body: { payload: string } }[]>`
			select body from raw_items where raw_item_id = ${ref?.rawItemId ?? 0}
		`;
		expect(raw[0]?.body.payload).toBe("verbatim");
	});

	it("tracks an emerging signal's age across sightings", async () => {
		const first = await observeSignal(sql, lineage, {
			signalId: "sig-1", label: "agent tooling", rationale: "three independent items",
			state: "emerging", confidence: 0.3, storyIds: ["story-a"], observedAt: "2026-09-11T08:00:00.000Z",
		});
		const second = await observeSignal(sql, lineage, {
			signalId: "sig-1", label: "agent tooling", rationale: "more coverage",
			state: "strengthening", confidence: 0.6, storyIds: ["story-b"], observedAt: "2026-09-13T08:00:00.000Z",
		});
		expect(second.firstSeenAt).toBe(first.firstSeenAt);
		expect(second.lastSeenAt).toBe("2026-09-13T08:00:00.000Z");
		expect(second.state).toBe("strengthening");
		expect(second.storyIds).toEqual(["story-a", "story-b"]);
	});
});

describe.skipIf(!probe.available)("explainability", () => {
	let sql: Sql;
	let lineage: string;
	const date = "2026-09-13";

	beforeAll(async () => {
		sql = createSql();
		await migrate(sql);
		lineage = testLineage("explain");
		const repo = new PostgresStoryRepository(sql, lineage);

		await upsertNormalizedItems(sql, lineage, [
			{
				id: "item-scanned", sourceType: "rss", sourceName: "Example Feed",
				trust: "UNTRUSTED_EXTERNAL_CONTENT" as const,
				title: "A minor version bump", summary: "patch release",
				publishedAt: "2026-09-13T06:00:00.000Z", metadata: {},
			},
			{
				id: "item-published", sourceType: "rss", sourceName: "Example Feed",
				trust: "UNTRUSTED_EXTERNAL_CONTENT" as const,
				title: "A major platform change", summary: "big news",
				publishedAt: "2026-09-13T06:00:00.000Z", metadata: {},
			},
		]);

		await repo.upsertStory(
			date,
			{
				storyId: "story-published", canonicalTitle: "A major platform change",
				sourceItemIds: ["item-published"], primarySourceIds: ["item-published"],
				status: "OPEN", changeType: "NEW", relevance: 0.9, novelty: 0.9,
				importance: 0.9, confidence: 0.9, reason: "material change", factRefs: [],
			},
			new Date("2026-09-13T08:00:00.000Z"),
		);

		await repo.recordDecisions(date, [
			{
				itemId: "item-scanned", disposition: "IRRELEVANT",
				reason: "patch release with no material change", decidedAt: "2026-09-13T08:00:00.000Z",
			},
			{
				itemId: "item-published", disposition: "CANDIDATE", storyId: "story-published",
				reason: "primary source for the platform change", decidedAt: "2026-09-13T08:00:00.000Z",
			},
		]);

		const brief: DailyBrief = {
			date,
			producedAt: "2026-09-13T09:00:00.000Z",
			dailyAnalysis: "one thing mattered today",
			watchNext: ["follow-up pricing note"],
			emergingSignals: [],
			stories: [
				{
					storyId: "story-published", section: "MUST_KNOW", mustKnow: true,
					title: "A major platform change", whatHappened: "it shipped",
					whyItMatters: "it changes integration work", whatChanged: "the API contract",
					impact: "teams must migrate", confidence: "HIGH",
					sourceItemIds: ["item-published"], factRefs: [],
				},
			],
		};
		await saveBrief(sql, lineage, brief);
	});

	afterAll(async () => {
		if (lineage) await purgeLineage(sql, lineage);
		await sql?.end({ timeout: 5 });
	});

	it("explains why a scanned item never reached the brief", async () => {
		const why = await explainItem(sql, lineage, date, "item-scanned");
		expect(why.title).toBe("A minor version bump");
		expect(why.disposition).toBe("IRRELEVANT");
		expect(why.reason).toBe("patch release with no material change");
		expect(why.storyId).toBeUndefined();
		expect(why.reachedBrief).toBe(false);
	});

	it("shows the path an item took all the way into the brief", async () => {
		const why = await explainItem(sql, lineage, date, "item-published");
		expect(why.disposition).toBe("CANDIDATE");
		expect(why.storyId).toBe("story-published");
		expect(why.reachedBrief).toBe(true);
		expect(why.briefSection).toBe("MUST_KNOW");
	});

	it("distinguishes an unscanned item from a rejected one", async () => {
		const why = await explainItem(sql, lineage, date, "item-never-seen");
		expect(why.disposition).toBeUndefined();
		expect(why.reachedBrief).toBe(false);
	});

	it("counts dispositions for the scan-coverage report", async () => {
		expect(await dispositionCounts(sql, lineage, date)).toEqual({ IRRELEVANT: 1, CANDIDATE: 1 });
	});
});
