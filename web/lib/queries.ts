import { localDateKey, reportingZone } from "../../src/runtime/local-day.ts";
import {
	briefAppearancesForStory,
	getBrief,
	latestBriefDate,
	listBriefSummaries,
	listDraftValidationFailures,
	searchBriefStories,
	type BriefAppearance,
	type BriefStoryHit,
	type BriefSummary,
	type DraftValidationRecord,
} from "../../src/db/briefs.ts";
import {
	collectorThroughput,
	listCollectionRuns,
	listSourceConfigs,
	type CollectionRunRow,
	type CollectorThroughput,
	type SourceConfigRow,
} from "../../src/db/collector-health.ts";
import { dispositionCounts, explainItem, type ItemExplanation } from "../../src/db/decisions.ts";
import { getFacts } from "../../src/db/facts.ts";
import {
	getItemProvenance,
	getNormalizedItems,
	listItemsFetchedAfterMorningRun,
	searchNormalizedItems,
	type ItemProvenance,
	type LateItem,
} from "../../src/db/items.ts";
import {
	getRun,
	listAgentRuns,
	listAttempts,
	listRecentRuns,
	listRunsForDate,
	type AgentRunRow,
	type AttemptRow,
	type RunSummary,
} from "../../src/db/runs.ts";
import { listSignals, signalsForStory, type EmergingSignal } from "../../src/db/signals.ts";
import {
	findRelatedStories,
	getLatestStory,
	listDecisionsForItem,
	listStoriesForDate,
	listStoryItemRoles,
	listStoryTimeline,
	type DatedItemDecision,
	type RelatedStory,
} from "../../src/db/stories.ts";
import type { DailyBrief } from "../../src/schemas/brief.ts";
import type { StructuredFact } from "../../src/schemas/fact.ts";
import type { NormalizedItem } from "../../src/schemas/item.ts";
import type { StoryLedgerEntry } from "../../src/schemas/story.ts";
import { db, LINEAGE } from "./db.ts";
import { collectFactRefs, collectSourceItemIds } from "./sections.ts";
import { DASHBOARD_LIMITS, type DayWorkload } from "./dashboard.ts";

/*
 * Page-shaped reads. Every function here is a composition of the repo's own
 * query layer in src/db — this module adds no SQL of its own, so the reader and
 * the pipeline can never drift on what a story, a fact or a decision is.
 *
 * Nothing in this file, or anything it imports, touches a model. A request
 * serves rows the pipeline already published and does no inference of any kind.
 */

export interface BriefPageData {
	brief: DailyBrief;
	facts: StructuredFact[];
	items: NormalizedItem[];
	lateItems: LateItem[];
	/** Ledger rows for the same date: the source of each story's change type and importance. */
	ledger: StoryLedgerEntry[];
	/** Tracked signal records, for lifecycle state and confidence next to the brief's signals. */
	signalRecords: EmergingSignal[];
	neighbours: { previous: string | undefined; next: string | undefined };
}

export async function loadBriefPage(date: string): Promise<BriefPageData | undefined> {
	const sql = db();
	const brief = await getBrief(sql, LINEAGE, date);
	if (!brief) return undefined;
	const [facts, items, lateItems, summaries, ledger, signalRecords] = await Promise.all([
		getFacts(sql, LINEAGE, collectFactRefs(brief)),
		getNormalizedItems(sql, LINEAGE, collectSourceItemIds(brief)),
		// The dashboard states how many arrived; when this cap is reached it
		// says so rather than presenting the page size as the count.
		listItemsFetchedAfterMorningRun(sql, LINEAGE, date, 0.6, DASHBOARD_LIMITS.lateItemsFetch),
		listBriefSummaries(sql, LINEAGE, 400),
		listStoriesForDate(sql, LINEAGE, date),
		listSignals(sql, LINEAGE),
	]);
	// Neighbours come from the published set, not from calendar arithmetic: a
	// day with no brief must not produce a dead link in the pager.
	const dates = summaries.map((s) => s.date);
	const index = dates.indexOf(date);
	return {
		brief,
		facts,
		items,
		lateItems,
		ledger,
		signalRecords,
		neighbours: {
			previous: index >= 0 ? dates[index + 1] : undefined,
			next: index > 0 ? dates[index - 1] : undefined,
		},
	};
}

/**
 * What the day's run read, for the Today page's closing paragraph. Counts come
 * from the rows the pipeline wrote — decisions, the run row, collection runs —
 * never from the brief's own prose. A date with no run row yields undefined and
 * the page omits the paragraph rather than guessing.
 */
export async function loadDayWorkload(date: string): Promise<DayWorkload | undefined> {
	const sql = db();
	const runIds = await listRunsForDate(sql, LINEAGE, date);
	if (runIds.length === 0) return undefined;
	const [runs, dispositions, collectionRuns] = await Promise.all([
		Promise.all(runIds.map((id) => getRun(sql, id))),
		dispositionCounts(sql, LINEAGE, date),
		listCollectionRuns(sql, 400),
	]);
	// A day can hold more than one run (a retry, an incremental pass); the
	// scan-coverage number is the largest processed count any of them reached.
	const itemsScanned = Math.max(0, ...runs.map((run) => run?.processedItems ?? 0));
	const runIdSet = new Set(runIds);
	const sources = new Set(
		collectionRuns
			.filter((row) => row.runId !== undefined && runIdSet.has(row.runId) && row.itemsFetched > 0)
			.map((row) => row.collectorId),
	).size;
	return { itemsScanned, sources, dispositions };
}

export async function loadLatestBriefDate(): Promise<string | undefined> {
	return latestBriefDate(db(), LINEAGE);
}

export async function loadBriefHistory(limit = 90): Promise<BriefSummary[]> {
	return listBriefSummaries(db(), LINEAGE, limit);
}

export interface StoryPageData {
	latest: StoryLedgerEntry;
	timeline: StoryLedgerEntry[];
	appearances: BriefAppearance[];
	facts: StructuredFact[];
	primarySources: NormalizedItem[];
	allSources: NormalizedItem[];
	unresolvedSourceIds: string[];
	related: RelatedStory[];
	signals: EmergingSignal[];
	roles: Map<string, "PRIMARY" | "SUPPORTING">;
}

export async function loadStoryPage(storyId: string): Promise<StoryPageData | undefined> {
	const sql = db();
	const latest = await getLatestStory(sql, LINEAGE, storyId);
	if (!latest) return undefined;

	const [timeline, appearances, related, signals, roleRows] = await Promise.all([
		listStoryTimeline(sql, LINEAGE, storyId),
		briefAppearancesForStory(sql, LINEAGE, storyId),
		findRelatedStories(sql, LINEAGE, storyId),
		signalsForStory(sql, LINEAGE, storyId),
		listStoryItemRoles(sql, LINEAGE, storyId, latest.date),
	]);

	// The union across the whole timeline, not just the latest day: a source
	// that carried the story on day one is still one of its sources on day four.
	const sourceIds = unique([
		...timeline.flatMap((entry) => entry.sourceItemIds),
		...appearances.flatMap((a) => a.sourceItemIds),
	]);
	const factRefs = unique([
		...timeline.flatMap((entry) => entry.factRefs),
		...appearances.flatMap((a) => a.factRefs),
	]);
	const [facts, items] = await Promise.all([
		getFacts(sql, LINEAGE, factRefs),
		getNormalizedItems(sql, LINEAGE, sourceIds),
	]);

	const byId = new Map(items.map((i) => [i.id, i] as const));
	const primaryIds = new Set([
		...timeline.flatMap((entry) => entry.primarySourceIds),
		...roleRows.filter((r) => r.role === "PRIMARY").map((r) => r.itemId),
	]);
	const roles = new Map<string, "PRIMARY" | "SUPPORTING">(
		sourceIds.map((id) => [id, primaryIds.has(id) ? "PRIMARY" : "SUPPORTING"] as const),
	);

	return {
		latest,
		timeline,
		appearances,
		facts,
		primarySources: [...primaryIds].map((id) => byId.get(id)).filter(isItem),
		allSources: sourceIds.map((id) => byId.get(id)).filter(isItem),
		// Shown rather than hidden: a cited source that is not in the item store
		// is a data bug the reader should make visible, not paper over.
		unresolvedSourceIds: sourceIds.filter((id) => !byId.has(id)),
		related,
		signals,
		roles,
	};
}

export async function loadSignals(): Promise<{
	signals: EmergingSignal[];
	storyTitles: Map<string, string>;
}> {
	const sql = db();
	const signals = await listSignals(sql, LINEAGE);
	const storyIds = unique(signals.flatMap((s) => s.storyIds));
	const entries = await Promise.all(
		storyIds.map(async (id) => [id, await getLatestStory(sql, LINEAGE, id)] as const),
	);
	const storyTitles = new Map<string, string>();
	for (const [id, entry] of entries) {
		if (entry) storyTitles.set(id, entry.canonicalTitle);
	}
	return { signals, storyTitles };
}

export interface SearchResults {
	query: string;
	briefHits: BriefStoryHit[];
	itemHits: Array<{ item: NormalizedItem; rank: number }>;
}

/**
 * Both halves are Postgres full-text search over the stored generated tsvector
 * columns, ranked by ts_rank. The ranking is reproducible and inspectable —
 * there is no embedding similarity standing alone and no model in the path.
 */
export async function loadSearch(query: string): Promise<SearchResults> {
	const trimmed = query.trim();
	if (trimmed === "") return { query: trimmed, briefHits: [], itemHits: [] };
	const sql = db();
	const [briefHits, itemMatches] = await Promise.all([
		searchBriefStories(sql, LINEAGE, trimmed, 30),
		searchNormalizedItems(sql, LINEAGE, trimmed, 30),
	]);
	const items = await getNormalizedItems(sql, LINEAGE, itemMatches.map((m) => m.itemId));
	const byId = new Map(items.map((i) => [i.id, i] as const));
	const itemHits = itemMatches
		.map((m) => {
			const item = byId.get(m.itemId);
			return item ? { item, rank: m.rank } : undefined;
		})
		.filter((hit): hit is { item: NormalizedItem; rank: number } => hit !== undefined);
	return { query: trimmed, briefHits, itemHits };
}

export interface RunsPageData {
	runs: RunSummary[];
	agentRuns: AgentRunRow[];
	attempts: AttemptRow[];
	collectionRuns: CollectionRunRow[];
	validationFailures: DraftValidationRecord[];
}

export async function loadRunsPage(): Promise<RunsPageData> {
	const sql = db();
	const runs = await listRecentRuns(sql, LINEAGE, 40);
	const runIds = runs.map((r) => r.runId);
	const [agentRuns, attempts, collectionRuns, validationFailures] = await Promise.all([
		listAgentRuns(sql, runIds),
		listAttempts(sql, runIds),
		listCollectionRuns(sql, 60),
		listDraftValidationFailures(sql, LINEAGE, 25),
	]);
	return { runs, agentRuns, attempts, collectionRuns, validationFailures };
}

export interface SourcesPageData {
	sources: SourceConfigRow[];
	throughput: Map<string, CollectorThroughput>;
	recentRuns: CollectionRunRow[];
}

export async function loadSourcesPage(): Promise<SourcesPageData> {
	const sql = db();
	const [sources, throughput, recentRuns] = await Promise.all([
		listSourceConfigs(sql),
		collectorThroughput(sql, 168),
		listCollectionRuns(sql, 40),
	]);
	return {
		sources,
		throughput: new Map(throughput.map((t) => [t.collectorId, t] as const)),
		recentRuns,
	};
}

export interface ItemTraceStep {
	stage: "scanned" | "decided" | "story" | "brief";
	label: string;
	detail: string;
	outcome: "ok" | "stopped" | "unknown";
	href?: string;
}

export interface ItemTraceData {
	itemId: string;
	date: string;
	provenance: ItemProvenance | undefined;
	decisions: DatedItemDecision[];
	explanation: ItemExplanation;
	story: StoryLedgerEntry | undefined;
	appearances: BriefAppearance[];
	dispositionCounts: Record<string, number>;
	availableDates: string[];
}

/**
 * The full "why did this not reach the brief" trace for one item. It resolves
 * against a specific date because a decision is per-date: an item judged
 * irrelevant on Monday can become a candidate on Tuesday.
 */
export async function loadItemTrace(
	itemId: string,
	requestedDate?: string,
): Promise<ItemTraceData> {
	const sql = db();
	const [provenance, decisions] = await Promise.all([
		getItemProvenance(sql, LINEAGE, itemId),
		listDecisionsForItem(sql, LINEAGE, itemId),
	]);
	const availableDates = decisions.map((d) => d.date);
	const date =
		requestedDate && availableDates.includes(requestedDate)
			? requestedDate
			: availableDates[0] ?? requestedDate ?? localDateKey(new Date(), reportingZone());

	const [explanation, counts] = await Promise.all([
		explainItem(sql, LINEAGE, date, itemId),
		dispositionCounts(sql, LINEAGE, date),
	]);
	const storyId = explanation.storyId;
	const [story, appearances] = await Promise.all([
		storyId ? getLatestStory(sql, LINEAGE, storyId) : Promise.resolve(undefined),
		storyId ? briefAppearancesForStory(sql, LINEAGE, storyId) : Promise.resolve([]),
	]);

	return {
		itemId,
		date,
		provenance,
		decisions,
		explanation,
		story,
		appearances,
		dispositionCounts: counts,
		availableDates,
	};
}

export async function loadRecentItemsForAdmin(limit = 40): Promise<LateItem[]> {
	const sql = db();
	const latest = await latestBriefDate(sql, LINEAGE);
	if (!latest) return [];
	return listItemsFetchedAfterMorningRun(sql, LINEAGE, latest, 0, limit);
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function isItem(value: NormalizedItem | undefined): value is NormalizedItem {
	return value !== undefined;
}
