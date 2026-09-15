import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CollectedItem } from "../src/collectors/types.ts";
import { saveBrief } from "../src/db/briefs.ts";
import { createSql, type Sql } from "../src/db/client.ts";
import { dispositionCounts, explainItem } from "../src/db/decisions.ts";
import { getFacts, upsertFacts } from "../src/db/facts.ts";
import {
	countRawItems,
	getNormalizedItem,
	getNormalizedItems,
	upsertNormalizedItems,
	upsertRawItems,
} from "../src/db/items.ts";
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
		const before = await countRawItems(sql, suffix);

		const first = await upsertRawItems(sql, items);
		expect(first.map((r) => r.inserted)).toEqual([true, true]);
		expect(await countRawItems(sql, suffix)).toBe(before + 2);

		const second = await upsertRawItems(sql, items);
		expect(second.map((r) => r.inserted)).toEqual([false, false]);
		expect(second.map((r) => r.rawItemId)).toEqual(first.map((r) => r.rawItemId));
		expect(await countRawItems(sql, suffix)).toBe(before + 2);
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

	it("writes a batch larger than one chunk and reports what it created", async () => {
		// Each item used to be its own round trip inside the transaction; the
		// batched write has to produce the same refs, in input order.
		const items = Array.from({ length: 1200 }, (_, i) => collected(`${suffix}-b${i}`));
		const before = await countRawItems(sql, suffix);

		const refs = await upsertRawItems(sql, items);
		expect(refs).toHaveLength(1200);
		expect(refs.every((r) => r.inserted)).toBe(true);
		expect(refs.map((r) => r.externalId)).toEqual(items.map((i) => i.raw.externalId));
		expect(new Set(refs.map((r) => r.rawItemId)).size).toBe(1200);
		expect(await countRawItems(sql, suffix)).toBe(before + 1200);

		// A second pass over a batch that spans chunks conflicts on every row.
		const again = await upsertRawItems(sql, items);
		expect(again.some((r) => r.inserted)).toBe(false);
		expect(again.map((r) => r.rawItemId)).toEqual(refs.map((r) => r.rawItemId));
		expect(await countRawItems(sql, suffix)).toBe(before + 1200);
	});

	it("links a batch to its collection run, whose id is text and not a uuid", async () => {
		// collection_runs.collection_run_id is text, and the ids the pipeline mints
		// are not all UUID-shaped. A "::uuid" cast on the way in threw
		// "invalid input syntax for type uuid" on every one of them.
		const collectionRunId = `cr-${suffix}`;
		await sql`
			insert into collection_runs (collection_run_id, collector_id, health, items_fetched,
				started_at, finished_at, latency_ms)
			values (${collectionRunId}, 'fake-collector', 'OK', 1,
				'2026-09-13T06:00:00.000Z'::timestamptz, '2026-09-13T06:00:05.000Z'::timestamptz, 5)
		`;
		try {
			const refs = await upsertRawItems(sql, [collected(`${suffix}-run`)], collectionRunId);
			expect(refs).toHaveLength(1);

			const rows = await sql<{ collection_run_id: string | null }[]>`
				select collection_run_id from raw_items where raw_item_id = ${refs[0]?.rawItemId ?? 0}
			`;
			expect(rows[0]?.collection_run_id).toBe(collectionRunId);
		} finally {
			await sql`delete from raw_items where collection_run_id = ${collectionRunId}`;
			await sql`delete from collection_runs where collection_run_id = ${collectionRunId}`;
		}
	});

	it("returns refs in input order for a chunk whose sorted order is the reverse", async () => {
		// Each batch is sorted by its conflict key before it is written, so two
		// writers overlapping in different input orders take their row locks in
		// one order. The RawItemRef contract is unaffected by that: one ref per
		// input item, in input order, with the right `inserted` flag.
		const ids = Array.from({ length: 40 }, (_, i) => `${suffix}-r${String(i).padStart(3, "0")}`);
		const reversed = ids.slice().reverse();

		const refs = await upsertRawItems(
			sql,
			reversed.map((id) => collected(id)),
		);
		expect(refs.map((r) => r.externalId)).toEqual(reversed);
		expect(refs.every((r) => r.inserted)).toBe(true);
		expect(new Set(refs.map((r) => r.rawItemId)).size).toBe(40);

		// raw_item_id is assigned in the order the rows reached the statement,
		// which is sorted order and not input order — so the ids run downwards
		// across the returned refs. That is the proof the sort took effect while
		// the refs were still rebuilt from the caller's array.
		const byInput = refs.map((r) => r.rawItemId);
		expect(byInput.slice().reverse()).toEqual(byInput.slice().sort((x, y) => x - y));

		// A second pass in the opposite (already sorted) order resolves the same
		// rows, in its own input order, and claims none of them.
		const again = await upsertRawItems(
			sql,
			ids.map((id) => collected(id)),
		);
		expect(again.map((r) => r.externalId)).toEqual(ids);
		expect(again.some((r) => r.inserted)).toBe(false);
		expect(again.map((r) => r.rawItemId)).toEqual(byInput.slice().reverse());
	});

	it("survives two writers upserting overlapping batches in opposite orders", async () => {
		// Without a shared lock order these deadlock on speculative-insertion
		// locks and Postgres kills one of them with "deadlock detected".
		const other = createSql();
		try {
			const shared = Array.from({ length: 150 }, (_, i) =>
				collected(`${suffix}-d${String(i).padStart(3, "0")}`),
			);
			const facts = Array.from({ length: 150 }, (_, i) => ({
				factId: `${suffix}-cf${String(i).padStart(3, "0")}`,
				kind: "crypto" as const,
				label: `Series ${i}`,
				value: i,
				unit: "usd",
				asOf: "2026-09-13T06:00:00.000Z",
				sourceItemId: `${suffix}-src`,
			}));

			await Promise.all([
				upsertRawItems(sql, shared),
				upsertRawItems(other, shared.slice().reverse()),
				upsertFacts(sql, lineage, facts),
				upsertFacts(other, lineage, facts.slice().reverse()),
			]);

			const raw = await sql<{ n: string }[]>`
				select count(*)::text as n from raw_items where external_id like ${`${suffix}-d%`}
			`;
			expect(raw[0]?.n).toBe("150");
			const stored = await getFacts(
				sql,
				lineage,
				facts.map((f) => f.factId),
			);
			expect(stored).toHaveLength(150);
		} finally {
			await other.end({ timeout: 5 });
		}
	});

	it("stores the same record twice in one batch only once", async () => {
		const duplicate = collected(`${suffix}-dup`);
		const refs = await upsertRawItems(sql, [duplicate, duplicate]);
		expect(refs).toHaveLength(2);
		expect(refs[0]?.rawItemId).toBe(refs[1]?.rawItemId);
		// Only the first occurrence may claim to have created the row.
		expect(refs.map((r) => r.inserted)).toEqual([true, false]);
	});

	it("upserts a batch of normalized items, with the last write of an id winning", async () => {
		const base = {
			sourceType: "rss" as const,
			trust: "UNTRUSTED_EXTERNAL_CONTENT" as const,
			sourceName: "Example Feed",
			summary: "normalized summary",
			publishedAt: "2026-09-13T06:00:00.000Z",
			metadata: {},
		};
		const many = Array.from({ length: 600 }, (_, i) => ({
			...base,
			id: `${suffix}-n${i}`,
			title: `Title ${i}`,
		}));
		await upsertNormalizedItems(sql, lineage, [
			...many,
			{ ...base, id: `${suffix}-n0`, title: "Rewritten" },
		]);

		const stored = await getNormalizedItems(
			sql,
			lineage,
			many.map((m) => m.id),
		);
		expect(stored).toHaveLength(600);
		expect(stored.find((i) => i.id === `${suffix}-n0`)?.title).toBe("Rewritten");
		// The timestamp survives the round trip as the exact ISO string it went in as.
		expect(stored[0]?.publishedAt).toBe("2026-09-13T06:00:00.000Z");
	});

	it("upserts a batch of facts, with the last write of a fact id winning", async () => {
		const facts = Array.from({ length: 600 }, (_, i) => ({
			factId: `${suffix}-f${i}`,
			kind: "crypto" as const,
			label: `Series ${i}`,
			value: i,
			unit: "usd",
			asOf: "2026-09-13T06:00:00.000Z",
			sourceItemId: `${suffix}-src`,
		}));
		await upsertFacts(sql, lineage, [
			...facts,
			{ ...facts[0]!, value: 999, previousValue: 1, changePct: 0.5 },
		]);

		const stored = await getFacts(
			sql,
			lineage,
			facts.map((f) => f.factId),
		);
		expect(stored).toHaveLength(600);
		const first = stored.find((f) => f.factId === `${suffix}-f0`);
		expect(first?.value).toBe(999);
		expect(first?.previousValue).toBe(1);
		expect(first?.asOf).toBe("2026-09-13T06:00:00.000Z");
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
