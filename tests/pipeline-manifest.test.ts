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

	// An explicit UTC window keeps these assertions independent of the machine's
	// zone; the zone-to-window conversion is tested separately.
	async function ids(over: { catchUpHours?: number; maxItems?: number } = {}): Promise<string[]> {
		const manifest = await buildManifestFromDb({
			sql,
			lineage,
			date: DATE,
			window: dayWindow(DATE, "UTC"),
			...over,
		});
		return manifest.items.map((i) => i.id);
	}

	it("sweeps up an item published before the window that was never judged", async () => {
		expect(await ids()).toContain("yesterday-unjudged");
	});

	it("never offers an item that was judged on an earlier day", async () => {
		expect(await ids()).not.toContain("yesterday-judged");
	});

	it("keeps an item in the manifest once TODAY has decided it", async () => {
		/*
		 * The manifest is two things at once: the work to be done, and the set of
		 * item ids a story may cite. Excluding everything already decided conflated
		 * them, and the catch-up half of the manifest then shrank as the day
		 * progressed.
		 *
		 * The 2026-09-16 recovery is what exposed it: the manifest fell from 1626
		 * to 537 to 263 while the run was working, and `submit_materials` rejected
		 * the day's own stories for citing ids that had silently left it -- 122 of
		 * 157 stories had no citable source item remaining. Any second run of a day
		 * whose work came from the catch-up window hits this.
		 *
		 * Deciding an item today must therefore leave it in today's manifest. The
		 * sweep stays idempotent where that matters: `list_unseen_items` filters by
		 * recorded decisions, so a decided item is never handed out as work again.
		 */
		const before = await ids();
		expect(before).toContain("yesterday-unjudged");

		await upsertDecisions(sql, lineage, DATE, [
			{
				itemId: "yesterday-unjudged",
				disposition: "CANDIDATE",
				reason: "decided by this very day",
				decidedAt: `${DATE}T09:00:00.000Z`,
			},
		]);

		const after = await ids();
		expect(after).toContain("yesterday-unjudged");
		// Stable, not merely non-empty: the citable set must not move under a
		// story that has already been written against it.
		expect(after).toEqual(before);
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

	it("says so when the cap drops items, rather than dropping them in silence", async () => {
		/*
		 * Scan coverage cannot catch this. It is measured against the manifest, so
		 * a truncated manifest is 100% covered by definition -- the guarantee the
		 * whole system rests on reports green while items nobody looked at were
		 * discarded one level above it. The only defence is that truncation is
		 * loud.
		 */
		const seen: { candidates: number; kept: number; dropped: number }[] = [];
		await buildManifestFromDb({
			sql,
			lineage,
			date: DATE,
			window: dayWindow(DATE, "UTC"),
			maxItems: 2,
			onTruncated: (info) => seen.push(info),
		});
		expect(seen).toEqual([{ candidates: 3, kept: 2, dropped: 1 }]);
	});

	it("stays quiet when the cap is merely reached exactly", async () => {
		// Exactly at the limit nothing was lost, and a false alarm every day is
		// how an operator learns to ignore the real one.
		const seen: unknown[] = [];
		await buildManifestFromDb({
			sql,
			lineage,
			date: DATE,
			window: dayWindow(DATE, "UTC"),
			maxItems: 3,
			onTruncated: (info) => seen.push(info),
		});
		expect(seen).toEqual([]);
	});

	it("bounds the day by the reader's zone, not by UTC", () => {
		expect(dayWindow(DATE, "UTC").from.toISOString()).toBe("2026-09-13T00:00:00.000Z");
		expect(dayWindow(DATE, "Asia/Taipei").from.toISOString()).toBe("2026-09-12T16:00:00.000Z");
	});
});
