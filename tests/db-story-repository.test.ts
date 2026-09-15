import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSql, type Sql } from "../src/db/client.ts";
import { loadMigrations, migrate } from "../src/db/migrate.ts";
import { listStoryItemRoles } from "../src/db/stories.ts";
import { announceSkip, probeDatabase, purgeLineage, testLineage } from "../src/db/test-support.ts";
import type { ItemDecision } from "../src/schemas/decision.ts";
import type { StoryUpsertInput } from "../src/schemas/story.ts";
import { PostgresStoryRepository } from "../src/stories/postgres-repository.ts";

const probe = await probeDatabase();
announceSkip("db-story-repository", probe);

/*
 * The backfill is exercised as the file that actually ships, not as a copy of
 * its SQL, so a later edit to one cannot quietly diverge from the other. It is
 * safe to re-run here: the statement is `on conflict do nothing`, so once the
 * migration has been applied it inserts nothing outside the rows the test
 * itself just deleted from its own lineage.
 */
const backfillSql = (() => {
	const file = loadMigrations().find((f) => f.name === "006_backfill-story-items.sql");
	if (!file) throw new Error("006_backfill-story-items.sql is missing");
	return file.sql;
})();

function upsertInput(over: Partial<StoryUpsertInput> = {}): StoryUpsertInput {
	return {
		storyId: "story-a",
		canonicalTitle: "OpenAI ships a new model",
		sourceItemIds: ["item-1"],
		primarySourceIds: ["item-1"],
		status: "OPEN",
		changeType: "NEW",
		relevance: 0.5,
		novelty: 0.5,
		importance: 0.5,
		confidence: 0.5,
		reason: "initial",
		factRefs: [],
		topicIds: [],
		...over,
	};
}

function decision(itemId: string, over: Partial<ItemDecision> = {}): ItemDecision {
	return {
		itemId,
		disposition: "CANDIDATE",
		reason: "relevant",
		decidedAt: "2026-09-13T00:00:00.000Z",
		...over,
	};
}

// These assertions deliberately mirror tests/json-repository.test.ts one for
// one: the Postgres repository is only a drop-in if it answers identically.
describe.skipIf(!probe.available)("PostgresStoryRepository", () => {
	let sql: Sql;
	let lineage: string;
	let repo: PostgresStoryRepository;

	beforeAll(async () => {
		sql = createSql();
		await migrate(sql);
	});

	afterAll(async () => {
		if (lineage) await purgeLineage(sql, lineage);
		await sql?.end({ timeout: 5 });
	});

	beforeEach(async () => {
		if (lineage) await purgeLineage(sql, lineage);
		lineage = testLineage("stories");
		repo = new PostgresStoryRepository(sql, lineage);
	});

	describe("upsertStory", () => {
		it("creates a new entry with firstSeenAt === lastSeenAt === now", async () => {
			const now = new Date("2026-09-13T08:00:00.000Z");
			const entry = await repo.upsertStory("2026-09-13", upsertInput(), now);
			expect(entry.firstSeenAt).toBe(now.toISOString());
			expect(entry.lastSeenAt).toBe(now.toISOString());
			expect(entry.date).toBe("2026-09-13");
			expect(await repo.listStories("2026-09-13")).toHaveLength(1);
		});

		it("merges a same-date re-upsert: unions ids, overwrites scores, keeps firstSeenAt", async () => {
			const first = new Date("2026-09-13T08:00:00.000Z");
			const second = new Date("2026-09-13T12:00:00.000Z");
			await repo.upsertStory("2026-09-13", upsertInput({ factRefs: ["fact-1"] }), first);
			const merged = await repo.upsertStory(
				"2026-09-13",
				upsertInput({
					sourceItemIds: ["item-1", "item-2"],
					primarySourceIds: ["item-2"],
					factRefs: ["fact-2"],
					topicIds: [],
					canonicalTitle: "OpenAI ships a new model (updated)",
					changeType: "UPDATE",
					status: "RESOLVED",
					importance: 0.9,
					reason: "follow-up confirmed",
				}),
				second,
			);

			expect(merged.sourceItemIds).toEqual(["item-1", "item-2"]);
			expect(merged.primarySourceIds).toEqual(["item-1", "item-2"]);
			expect(merged.factRefs).toEqual(["fact-1", "fact-2"]);
			expect(merged.canonicalTitle).toBe("OpenAI ships a new model (updated)");
			expect(merged.changeType).toBe("UPDATE");
			expect(merged.status).toBe("RESOLVED");
			expect(merged.importance).toBe(0.9);
			expect(merged.reason).toBe("follow-up confirmed");
			expect(merged.firstSeenAt).toBe(first.toISOString());
			expect(merged.lastSeenAt).toBe(second.toISOString());
			expect(await repo.listStories("2026-09-13")).toHaveLength(1);
		});

		it("inherits firstSeenAt from the earliest prior date", async () => {
			const day1 = new Date("2026-09-11T08:00:00.000Z");
			const day2 = new Date("2026-09-12T08:00:00.000Z");
			const day3 = new Date("2026-09-13T08:00:00.000Z");
			await repo.upsertStory("2026-09-11", upsertInput(), day1);
			await repo.upsertStory("2026-09-12", upsertInput(), day2);
			const latest = await repo.upsertStory("2026-09-13", upsertInput(), day3);

			expect(latest.firstSeenAt).toBe(day1.toISOString());
			expect(latest.lastSeenAt).toBe(day3.toISOString());
			expect(latest.date).toBe("2026-09-13");
		});

		it("persists across repository instances", async () => {
			const now = new Date("2026-09-13T08:00:00.000Z");
			await repo.upsertStory("2026-09-13", upsertInput(), now);
			const reopened = new PostgresStoryRepository(sql, lineage);
			const stories = await reopened.listStories("2026-09-13");
			expect(stories).toHaveLength(1);
			expect(stories[0]?.storyId).toBe("story-a");
			expect(await reopened.getStory("story-a")).toBeDefined();
			expect(await reopened.getStory("nope")).toBeUndefined();
		});

		it("keeps lineages from colliding on the same storyId and date", async () => {
			const other = new PostgresStoryRepository(sql, `${lineage}-other`);
			await repo.upsertStory("2026-09-13", upsertInput({ reason: "mine" }), new Date("2026-09-13T08:00:00.000Z"));
			await other.upsertStory("2026-09-13", upsertInput({ reason: "theirs" }), new Date("2026-09-13T09:00:00.000Z"));
			expect((await repo.getStory("story-a"))?.reason).toBe("mine");
			expect((await other.getStory("story-a"))?.reason).toBe("theirs");
			await purgeLineage(sql, `${lineage}-other`);
		});
	});

	describe("decisions", () => {
		it("is idempotent per itemId and replaces the prior decision", async () => {
			await repo.recordDecisions("2026-09-13", [decision("item-1"), decision("item-2")]);
			await repo.recordDecisions("2026-09-13", [
				decision("item-1", { disposition: "IRRELEVANT", reason: "noise" }),
			]);
			const all = await repo.listDecisions("2026-09-13");
			expect(all).toHaveLength(2);
			expect(all.find((d) => d.itemId === "item-1")?.disposition).toBe("IRRELEVANT");
			expect(all.find((d) => d.itemId === "item-1")?.reason).toBe("noise");
		});

		it("reports processed item ids", async () => {
			expect(await repo.processedItemIds("2026-09-13")).toEqual(new Set());
			await repo.recordDecisions("2026-09-13", [decision("item-1"), decision("item-2")]);
			await repo.recordDecisions("2026-09-13", [decision("item-1")]);
			expect(await repo.processedItemIds("2026-09-13")).toEqual(new Set(["item-1", "item-2"]));
		});

		it("round-trips the optional storyId and decidedAt exactly", async () => {
			await repo.recordDecisions("2026-09-13", [decision("item-3", { storyId: "story-a" })]);
			const [only] = await repo.listDecisions("2026-09-13");
			expect(only?.storyId).toBe("story-a");
			expect(only?.decidedAt).toBe("2026-09-13T00:00:00.000Z");
		});
	});

	describe("findHistory", () => {
		beforeEach(async () => {
			await repo.upsertStory(
				"2026-09-10",
				upsertInput({
					storyId: "story-a",
					canonicalTitle: "OpenAI ships a new model",
					reason: "launch coverage",
				}),
				new Date("2026-09-10T08:00:00.000Z"),
			);
			await repo.upsertStory(
				"2026-09-11",
				upsertInput({
					storyId: "story-b",
					canonicalTitle: "OpenAI pricing change",
					reason: "pricing",
				}),
				new Date("2026-09-11T08:00:00.000Z"),
			);
			await repo.upsertStory(
				"2026-09-12",
				upsertInput({
					storyId: "story-c",
					canonicalTitle: "Rust compiler release",
					reason: "toolchain",
				}),
				new Date("2026-09-12T08:00:00.000Z"),
			);
		});

		it("excludes the beforeDate itself and anything after it", async () => {
			const found = await repo.findHistory({ storyId: "story-c", beforeDate: "2026-09-12" });
			expect(found).toHaveLength(0);
			const included = await repo.findHistory({ storyId: "story-c", beforeDate: "2026-09-13" });
			expect(included.map((e) => e.storyId)).toEqual(["story-c"]);
		});

		it("matches storyId exactly, ignoring text", async () => {
			const found = await repo.findHistory({
				storyId: "story-a",
				text: "rust compiler",
				beforeDate: "2026-09-13",
			});
			expect(found.map((e) => e.storyId)).toEqual(["story-a"]);
		});

		it("ranks by token-overlap score, then by date descending", async () => {
			const found = await repo.findHistory({ text: "openai model", beforeDate: "2026-09-13" });
			// story-a matches both tokens (1.0); story-b matches only "openai" (0.5).
			expect(found.map((e) => e.storyId)).toEqual(["story-a", "story-b"]);
		});

		it("breaks score ties newest-date-first and drops zero-score entries", async () => {
			const found = await repo.findHistory({ text: "openai", beforeDate: "2026-09-13" });
			expect(found.map((e) => e.storyId)).toEqual(["story-b", "story-a"]);
			expect(found.map((e) => e.storyId)).not.toContain("story-c");
		});

		it("honours the limit, defaulting to 10", async () => {
			const limited = await repo.findHistory({
				text: "openai",
				beforeDate: "2026-09-13",
				limit: 1,
			});
			expect(limited.map((e) => e.storyId)).toEqual(["story-b"]);
			const defaulted = await repo.findHistory({ text: "openai", beforeDate: "2026-09-13" });
			expect(defaulted.length).toBeLessThanOrEqual(10);
			expect(defaulted).toHaveLength(2);
		});

		it("returns nothing for an empty query text", async () => {
			expect(await repo.findHistory({ text: "   ", beforeDate: "2026-09-13" })).toEqual([]);
			expect(await repo.findHistory({ text: "openai", beforeDate: "2026-09-13", limit: 0 })).toEqual([]);
		});
	});

	// story_items is what the web story page reads roles from, and for most of
	// this table's life nothing but the dev seeder wrote to it. These pin the
	// relation to the ledger upsert that now maintains it.
	describe("story_items", () => {
		const roles = async (date = "2026-09-13") => listStoryItemRoles(sql, lineage, "story-a", date);

		it("derives PRIMARY from primarySourceIds and SUPPORTING for the rest", async () => {
			await repo.upsertStory(
				"2026-09-13",
				upsertInput({ sourceItemIds: ["item-1", "item-2", "item-3"], primarySourceIds: ["item-2"] }),
				new Date("2026-09-13T08:00:00.000Z"),
			);
			expect(await roles()).toEqual([
				{ itemId: "item-2", role: "PRIMARY" },
				{ itemId: "item-1", role: "SUPPORTING" },
				{ itemId: "item-3", role: "SUPPORTING" },
			]);
		});

		it("gives a primary id its row even when sourceItemIds omits it", async () => {
			await repo.upsertStory(
				"2026-09-13",
				upsertInput({ sourceItemIds: ["item-1"], primarySourceIds: ["item-9"] }),
				new Date("2026-09-13T08:00:00.000Z"),
			);
			expect(await roles()).toEqual([
				{ itemId: "item-9", role: "PRIMARY" },
				{ itemId: "item-1", role: "SUPPORTING" },
			]);
		});

		it("is idempotent: re-running the same pass leaves the same rows", async () => {
			const input = upsertInput({
				sourceItemIds: ["item-1", "item-2"],
				primarySourceIds: ["item-1"],
			});
			await repo.upsertStory("2026-09-13", input, new Date("2026-09-13T08:00:00.000Z"));
			const first = await roles();
			await repo.upsertStory("2026-09-13", input, new Date("2026-09-13T12:00:00.000Z"));
			expect(await roles()).toEqual(first);
			expect(first).toHaveLength(2);
		});

		// The ledger arrays union and so can never drop an item; the relation has
		// to, or a re-curation that discards a source leaves it on the page.
		it("drops an item the next pass no longer cites, and re-roles a demoted one", async () => {
			await repo.upsertStory(
				"2026-09-13",
				upsertInput({ sourceItemIds: ["item-1", "item-2"], primarySourceIds: ["item-1"] }),
				new Date("2026-09-13T08:00:00.000Z"),
			);
			await repo.upsertStory(
				"2026-09-13",
				upsertInput({ sourceItemIds: ["item-2"], primarySourceIds: ["item-2"] }),
				new Date("2026-09-13T12:00:00.000Z"),
			);
			expect(await roles()).toEqual([{ itemId: "item-2", role: "PRIMARY" }]);
		});

		it("keeps a story's rows on one date out of another date's", async () => {
			await repo.upsertStory(
				"2026-09-12",
				upsertInput({ sourceItemIds: ["item-1"], primarySourceIds: ["item-1"] }),
				new Date("2026-09-12T08:00:00.000Z"),
			);
			await repo.upsertStory(
				"2026-09-13",
				upsertInput({ sourceItemIds: ["item-5"], primarySourceIds: [] }),
				new Date("2026-09-13T08:00:00.000Z"),
			);
			expect(await roles("2026-09-12")).toEqual([{ itemId: "item-1", role: "PRIMARY" }]);
			expect(await roles()).toEqual([{ itemId: "item-5", role: "SUPPORTING" }]);
		});

		// 006_backfill-story-items.sql reconstructs the relation from the ledger
		// arrays for every story written before the writer existed. On a story
		// curated in a single pass -- which is every story the backfill has to
		// reach -- it must land on exactly what the writer produces, or the
		// history and the present would show roles by different rules.
		it("matches what 006_backfill-story-items.sql reconstructs from the arrays", async () => {
			const input = upsertInput({
				sourceItemIds: ["item-1", "item-2", "item-3"],
				primarySourceIds: ["item-2", "item-3"],
			});
			await repo.upsertStory("2026-09-13", input, new Date("2026-09-13T08:00:00.000Z"));
			const written = await roles();

			await sql`delete from story_items where lineage = ${lineage}`;
			await sql.unsafe(backfillSql);
			expect(await roles()).toEqual(written);
		});
	});
});
