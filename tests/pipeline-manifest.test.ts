import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql, type Sql } from "../src/db/client.ts";
import { upsertNormalizedItems } from "../src/db/items.ts";
import { migrate } from "../src/db/migrate.ts";
import { upsertDecisions } from "../src/db/stories.ts";
import { announceSkip, probeDatabase, purgeLineage, testLineage } from "../src/db/test-support.ts";
import { buildManifestFromDb, dayWindow } from "../src/pipeline/manifest.ts";
import type { NormalizedItem } from "../src/schemas/item.ts";

/*
 * The manifest is the only thing the curator can see, so what it leaves out is
 * never judged at all -- not rejected, invisible. These tests pin the two
 * clocks it has to reconcile: the source's publish time and our once-a-day
 * collection.
 */

const probe = await probeDatabase();
announceSkip("pipeline-manifest", probe);

const DATE = "2026-09-13";

function item(id: string, publishedAt: string): NormalizedItem {
	return {
		id,
		trust: "UNTRUSTED_EXTERNAL_CONTENT",
		sourceType: "rss",
		sourceName: "Example Feed",
		title: `Title ${id}`,
		summary: "summary",
		publishedAt,
		metadata: {},
	};
}

describe.skipIf(!probe.available)("daily manifest item window", () => {
	let sql: Sql;
	const lineage = testLineage("manifest");

	beforeAll(async () => {
		sql = createSql();
		await migrate(sql);
		await upsertNormalizedItems(sql, lineage, [
			item("today-early", `${DATE}T02:00:00.000Z`),
			item("today-late", `${DATE}T23:50:00.000Z`),
			// Published yesterday, collected today: the crossing that a strict day
			// window loses on every day.
			item("yesterday-unjudged", "2026-09-12T23:40:00.000Z"),
			item("yesterday-judged", "2026-09-12T10:00:00.000Z"),
			// Older than the sweep: a stale archive entry must not come back.
			item("ancient-unjudged", "2026-09-01T10:00:00.000Z"),
		]);
		await upsertDecisions(sql, lineage, "2026-09-12", [
			{
				itemId: "yesterday-judged",
				disposition: "IRRELEVANT",
				reason: "already judged on its own day",
				decidedAt: "2026-09-12T06:10:00.000Z",
			},
		]);
	});

	afterAll(async () => {
		await purgeLineage(sql, lineage);
		await sql.end({ timeout: 5 });
	});

	async function ids(over: { catchUpHours?: number; maxItems?: number } = {}): Promise<string[]> {
		const manifest = await buildManifestFromDb({ sql, lineage, date: DATE, ...over });
		return manifest.items.map((i) => i.id);
	}

	it("sweeps up an item published before the window that was never judged", async () => {
		expect(await ids()).toContain("yesterday-unjudged");
	});

	it("never offers an item that already has a decision on any date", async () => {
		expect(await ids()).not.toContain("yesterday-judged");
	});

	it("does not reach past the catch-up horizon", async () => {
		expect(await ids()).not.toContain("ancient-unjudged");
	});

	it("still contains the day's own items, oldest first", async () => {
		const out = await ids();
		expect(out).toEqual(["yesterday-unjudged", "today-early", "today-late"]);
	});

	it("restores a strict day window when the sweep is switched off", async () => {
		expect(await ids({ catchUpHours: 0 })).toEqual(["today-early", "today-late"]);
	});

	it("drops the oldest, not the freshest, when the cap bites", async () => {
		const out = await ids({ maxItems: 2 });
		expect(out).toEqual(["today-early", "today-late"]);
	});

	it("keeps the day window itself unchanged", () => {
		const window = dayWindow(DATE);
		expect(window.from.toISOString()).toBe("2026-09-13T00:00:00.000Z");
		expect(window.to.toISOString()).toBe("2026-09-14T00:00:00.000Z");
	});
});
