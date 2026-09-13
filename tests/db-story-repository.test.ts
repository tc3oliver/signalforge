import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSql, type Sql } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import { announceSkip, probeDatabase, purgeLineage, testLineage } from "../src/db/test-support.ts";
import type { ItemDecision } from "../src/schemas/decision.ts";
import type { StoryUpsertInput } from "../src/schemas/story.ts";
import { PostgresStoryRepository } from "../src/stories/postgres-repository.ts";

const probe = await probeDatabase();
announceSkip("db-story-repository", probe);

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
});
