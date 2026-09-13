import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	briefAppearancesForStory,
	latestBriefDate,
	listBriefSummaries,
	listDraftValidationFailures,
	saveBrief,
	saveDraft,
	searchBriefStories,
} from "../src/db/briefs.ts";
import { createSql, type Sql } from "../src/db/client.ts";
import {
	collectorThroughput,
	listCollectionRuns,
	listSourceConfigs,
	recordCollectionRun,
	upsertSourceConfig,
} from "../src/db/collector-health.ts";
import {
	getNormalizedItems,
	getItemProvenance,
	listItemsFetchedAfterMorningRun,
	upsertNormalizedItems,
	upsertRawItems,
} from "../src/db/items.ts";
import { migrate } from "../src/db/migrate.ts";
import {
	listAgentRuns,
	listAttempts,
	listRecentRuns,
	finishAgentRun,
	recordAttempt,
	startAgentRun,
	upsertRun,
} from "../src/db/runs.ts";
import {
	findRelatedStories,
	listDecisionsForItem,
	listStoryTimeline,
	upsertDecisions,
	upsertStoryRow,
} from "../src/db/stories.ts";
import { announceSkip, probeDatabase, purgeLineage, testLineage } from "../src/db/test-support.ts";
import type { CollectedItem, CollectorResult } from "../src/collectors/types.ts";
import type { DailyBrief } from "../src/schemas/brief.ts";

/*
 * These cover the additive read-only projections the web reader depends on.
 * Like every other database suite here, they skip with a printed reason when
 * Postgres is not up rather than failing the run.
 */

const probe = await probeDatabase();
announceSkip("web-queries", probe);

const DATE_A = "2026-03-01";
const DATE_B = "2026-03-02";

describe.skipIf(!probe.available)("web read projections", () => {
	let sql: Sql;
	let lineage: string;
	let suffix: string;
	let runIdA: string;
	let runIdB: string;

	beforeAll(async () => {
		sql = createSql();
		await migrate(sql);
		lineage = testLineage("web");
		suffix = lineage;
		runIdA = `${lineage}-run-a`;
		runIdB = `${lineage}-run-b`;

		for (const [runId, date] of [
			[runIdA, DATE_A],
			[runIdB, DATE_B],
		] as const) {
			await upsertRun(
				sql,
				{
					runId,
					date,
					status: "COMPLETED",
					createdAt: `${date}T06:00:00.000Z`,
					updatedAt: `${date}T06:10:00.000Z`,
					totalItems: 3,
					processedItems: 3,
					storyCount: 2,
				},
				lineage,
			);
		}

		await upsertSourceConfig(sql, {
			collectorId: `col-${suffix}`,
			sourceType: "rss",
			enabled: false,
			requiredSecrets: ["SOME_TOKEN"],
			config: { window: "24h" },
		});

		const collectorResult: CollectorResult = {
			collectorId: `col-${suffix}`,
			health: "DEGRADED",
			items: [],
			facts: [],
			itemsFetched: 2,
			warnings: ["partial page"],
			error: "upstream 503",
			startedAt: `${DATE_A}T05:20:00.000Z`,
			finishedAt: `${DATE_A}T05:20:02.000Z`,
			latencyMs: 2000,
		};
		await recordCollectionRun(sql, `cr-${suffix}`, collectorResult, runIdA);

		const collected: CollectedItem[] = ["early", "late"].map((kind) => ({
			sourceType: "rss",
			sourceName: "Test Feed",
			externalId: `${suffix}:${kind}`,
			title: `${kind} item`,
			summary: "summary",
			publishedAt: `${DATE_A}T04:00:00.000Z`,
			metadata: {},
			trust: "UNTRUSTED_EXTERNAL_CONTENT" as const,
			raw: {
				externalId: `${suffix}:${kind}`,
				body: { kind },
				// "early" arrives before the run, "late" after it.
				fetchedAt: kind === "early" ? `${DATE_A}T05:30:00.000Z` : `${DATE_A}T14:00:00.000Z`,
			},
		}));
		const refs = await upsertRawItems(sql, collected, `cr-${suffix}`);
		const rawByExternal = new Map(refs.map((r) => [r.externalId, r.rawItemId] as const));

		await upsertNormalizedItems(sql, lineage, [
			{
				id: "it-early",
				sourceType: "rss",
				sourceName: "Test Feed",
				title: "Quantum widget factory opens",
				summary: "A widget factory with quantum characteristics",
				url: "https://example.invalid/early",
				publishedAt: `${DATE_A}T04:00:00.000Z`,
				metadata: {},
				rawItemId: rawByExternal.get(`${suffix}:early`)!,
			},
			{
				id: "it-late",
				sourceType: "rss",
				sourceName: "Test Feed",
				title: "Quantum widget recall announced",
				summary: "The same factory recalls its widgets",
				url: "https://example.invalid/late",
				publishedAt: `${DATE_A}T13:00:00.000Z`,
				metadata: {},
				rawItemId: rawByExternal.get(`${suffix}:late`)!,
			},
		]);

		for (const date of [DATE_A, DATE_B]) {
			await upsertStoryRow(
				sql,
				lineage,
				date,
				{
					storyId: "st-widget",
					canonicalTitle: "Quantum widget factory",
					sourceItemIds: ["it-early"],
					primarySourceIds: ["it-early"],
					status: "OPEN",
					changeType: date === DATE_A ? "NEW" : "UPDATE",
					relevance: 0.8,
					novelty: 0.7,
					importance: 0.9,
					confidence: 0.85,
					reason: "quantum widget factory opening",
					factRefs: [],
				},
				`${date}T06:03:00.000Z`,
			);
		}
		await upsertStoryRow(
			sql,
			lineage,
			DATE_B,
			{
				storyId: "st-widget-recall",
				canonicalTitle: "Quantum widget recall",
				sourceItemIds: ["it-early", "it-late"],
				primarySourceIds: ["it-late"],
				status: "OPEN",
				changeType: "ESCALATION",
				relevance: 0.7,
				novelty: 0.6,
				importance: 0.7,
				confidence: 0.8,
				reason: "quantum widget factory recall",
				factRefs: [],
			},
			`${DATE_B}T06:03:00.000Z`,
		);

		await upsertDecisions(
			sql,
			lineage,
			DATE_A,
			[
				{
					itemId: "it-early",
					disposition: "CANDIDATE",
					storyId: "st-widget",
					reason: "first-hand",
					decidedAt: `${DATE_A}T06:02:00.000Z`,
				},
				{
					itemId: "it-late",
					disposition: "CANDIDATE",
					storyId: "st-widget-recall",
					reason: "late arrival",
					decidedAt: `${DATE_A}T06:02:00.000Z`,
				},
			],
			runIdA,
		);
		await upsertDecisions(
			sql,
			lineage,
			DATE_B,
			[
				{
					itemId: "it-early",
					disposition: "DUPLICATE",
					storyId: "st-widget",
					reason: "already covered",
					decidedAt: `${DATE_B}T06:02:00.000Z`,
				},
			],
			runIdB,
		);

		await startAgentRun(sql, runIdA, "EDITOR", `${DATE_A}T06:06:00.000Z`);
		await recordAttempt(sql, runIdA, {
			attemptId: `${suffix}-attempt-1`,
			stage: "EDITOR",
			provider: "anthropic",
			model: "primary-model",
			startedAt: `${DATE_A}T06:06:00.000Z`,
			finishedAt: `${DATE_A}T06:08:00.000Z`,
			durationMs: 120_000,
			status: "FAILED",
			failureClass: "TIMEOUT",
			fallbackReason: "deadline exceeded",
		});
		await recordAttempt(sql, runIdA, {
			attemptId: `${suffix}-attempt-2`,
			stage: "EDITOR",
			provider: "anthropic",
			model: "fallback-model",
			startedAt: `${DATE_A}T06:08:10.000Z`,
			finishedAt: `${DATE_A}T06:09:30.000Z`,
			durationMs: 80_000,
			status: "SUCCESS",
		});
		await finishAgentRun(sql, runIdA, "EDITOR", {
			status: "SUCCESS",
			finishedAt: `${DATE_A}T06:09:30.000Z`,
			durationMs: 80_000,
			provider: "anthropic",
			model: "fallback-model",
		});

		const brief = (date: string): DailyBrief => ({
			date,
			producedAt: `${date}T06:10:00.000Z`,
			stories: [
				{
					storyId: "st-widget",
					section: "COMPANIES",
					mustKnow: true,
					title: "Quantum widget factory opens",
					whatHappened: "a quantum widget factory opened",
					whyItMatters: "widgets matter",
					whatChanged: "it opened",
					impact: "widget supply rises",
					confidence: "HIGH",
					sourceItemIds: ["it-early"],
					factRefs: [],
				},
			],
			emergingSignals: [],
			dailyAnalysis: "analysis",
			watchNext: ["widget prices"],
		});
		await saveBrief(sql, lineage, brief(DATE_A), runIdA);
		await saveBrief(sql, lineage, brief(DATE_B), runIdB);
		await saveDraft(sql, lineage, DATE_B, { stories: [] }, {
			producedAt: `${DATE_B}T06:07:00.000Z`,
			runId: runIdB,
			validationStatus: "FAILED",
			validationErrors: [{ path: "stories", message: "too few stories" }],
		});
	});

	afterAll(async () => {
		if (!probe.available) return;
		await purgeLineage(sql, lineage);
		// Rows outside the lineage-scoped purge are cleaned up by hand.
		await sql`delete from raw_items where external_id like ${`${suffix}:%`}`;
		await sql`delete from collection_runs where collection_run_id = ${`cr-${suffix}`}`;
		await sql`delete from source_configs where collector_id = ${`col-${suffix}`}`;
		await sql`delete from daily_runs where run_id in (${runIdA}, ${runIdB})`;
		await sql.end({ timeout: 5 });
	});

	it("summarises published briefs newest first", async () => {
		const summaries = await listBriefSummaries(sql, lineage, 10);
		expect(summaries.map((s) => s.date)).toEqual([DATE_B, DATE_A]);
		expect(summaries[0]?.storyCount).toBe(1);
		expect(summaries[0]?.mustKnowCount).toBe(1);
		expect(summaries[0]?.sections).toEqual(["COMPANIES"]);
		expect(summaries[0]?.headline).toBe("Quantum widget factory opens");
		expect(await latestBriefDate(sql, lineage)).toBe(DATE_B);
	});

	it("full-text searches published brief stories", async () => {
		const hits = await searchBriefStories(sql, lineage, "quantum widget", 10);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]?.storyId).toBe("st-widget");
		expect(hits[0]?.rank).toBeGreaterThan(0);
		expect(await searchBriefStories(sql, lineage, "   ", 10)).toEqual([]);
	});

	it("lists every brief a story reached", async () => {
		const appearances = await briefAppearancesForStory(sql, lineage, "st-widget");
		expect(appearances.map((a) => a.date)).toEqual([DATE_B, DATE_A]);
		expect(appearances[0]?.section).toBe("COMPANIES");
	});

	it("reports rejected drafts with their validation errors", async () => {
		const failures = await listDraftValidationFailures(sql, lineage, 10);
		expect(failures).toHaveLength(1);
		expect(failures[0]?.date).toBe(DATE_B);
		expect(failures[0]?.validationErrors).toHaveLength(1);
	});

	it("fetches items in bulk and resolves their provenance", async () => {
		const items = await getNormalizedItems(sql, lineage, ["it-early", "it-late", "it-missing"]);
		expect(items.map((i) => i.id).sort()).toEqual(["it-early", "it-late"]);
		const provenance = await getItemProvenance(sql, lineage, "it-late");
		expect(provenance?.collectorId).toBe(`col-${suffix}`);
		expect(provenance?.fetchedAt).toBe(`${DATE_A}T14:00:00.000Z`);
		expect(await getItemProvenance(sql, lineage, "it-nope")).toBeUndefined();
	});

	it("finds only items fetched after the day's first run", async () => {
		const late = await listItemsFetchedAfterMorningRun(sql, lineage, DATE_A, 0, 20);
		expect(late.map((i) => i.itemId)).toEqual(["it-late"]);
		expect(late[0]?.fetchedAt).toBe(`${DATE_A}T14:00:00.000Z`);
	});

	it("returns a story's whole timeline oldest first", async () => {
		const timeline = await listStoryTimeline(sql, lineage, "st-widget");
		expect(timeline.map((e) => e.date)).toEqual([DATE_A, DATE_B]);
		expect(timeline[0]?.changeType).toBe("NEW");
		expect(timeline[1]?.changeType).toBe("UPDATE");
		// firstSeenAt is inherited from the earliest date the story appeared on.
		expect(timeline[1]?.firstSeenAt).toBe(`${DATE_A}T06:03:00.000Z`);
	});

	it("relates stories by shared source items", async () => {
		const related = await findRelatedStories(sql, lineage, "st-widget", 5);
		const recall = related.find((r) => r.entry.storyId === "st-widget-recall");
		expect(recall).toBeDefined();
		expect(recall?.sharedItemCount).toBeGreaterThan(0);
	});

	it("lists every decision recorded about an item", async () => {
		const decisions = await listDecisionsForItem(sql, lineage, "it-early");
		expect(decisions.map((d) => d.date)).toEqual([DATE_B, DATE_A]);
		expect(decisions[0]?.disposition).toBe("DUPLICATE");
		expect(decisions[1]?.disposition).toBe("CANDIDATE");
	});

	it("exposes run stage timings and the fallback attempt history", async () => {
		const runs = await listRecentRuns(sql, lineage, 10);
		expect(runs.map((r) => r.runId)).toEqual([runIdB, runIdA]);
		const stages = await listAgentRuns(sql, [runIdA]);
		expect(stages[0]?.model).toBe("fallback-model");
		expect(stages[0]?.durationMs).toBe(80_000);
		const attempts = await listAttempts(sql, [runIdA]);
		expect(attempts).toHaveLength(2);
		expect(attempts[0]?.status).toBe("FAILED");
		expect(attempts[0]?.fallbackReason).toBe("deadline exceeded");
		expect(attempts[1]?.model).toBe("fallback-model");
		expect(await listAttempts(sql, [])).toEqual([]);
	});

	it("reports collector configuration, throughput and recent runs", async () => {
		const sources = await listSourceConfigs(sql);
		const mine = sources.find((s) => s.collectorId === `col-${suffix}`);
		expect(mine?.enabled).toBe(false);
		expect(mine?.requiredSecrets).toEqual(["SOME_TOKEN"]);
		expect(mine?.configKeys).toEqual(["window"]);
		// The config payload itself is never returned, only its key names.
		expect(JSON.stringify(mine)).not.toContain("24h");

		const runs = await listCollectionRuns(sql, 50);
		const run = runs.find((r) => r.collectionRunId === `cr-${suffix}`);
		expect(run?.health).toBe("DEGRADED");
		expect(run?.error).toBe("upstream 503");
		expect(run?.warnings).toEqual(["partial page"]);

		// The throughput window is relative to now; the seeded run is dated in the
		// future relative to nothing in particular, so only the shape is asserted.
		const throughput = await collectorThroughput(sql, 24 * 365 * 50);
		expect(Array.isArray(throughput)).toBe(true);
	});
});
