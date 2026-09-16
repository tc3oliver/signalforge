import type { DailyBrief, DailyBriefStory, ConfidenceLevel } from "../../src/schemas/brief.ts";
import type { ChangeType, StoryLedgerEntry } from "../../src/schemas/story.ts";
import type { EmergingSignal, SignalState } from "../../src/db/signals.ts";
import type { LateItem } from "../../src/db/items.ts";
import { displaySourceName } from "./format.ts";
import { TOPICAL_SECTIONS } from "./sections.ts";
import { confidenceLevelFromScore } from "./format.ts";

/*
 * The dashboard view model. Everything on the Today page is derived here, as a
 * pure function of rows the pipeline already published, so the page component
 * only draws and the derivation is testable without React or a database.
 *
 * Nothing in this file adds information. The hero line is the opening of the
 * editor's own daily analysis; a card's takeaway is the opening of its "why it
 * matters"; change types and importance come from the story ledger; source
 * counts are the length of the cited id list. When a value is missing it is
 * left out, never guessed -- a dashboard that fills gaps stops being evidence.
 */

export type ImportanceLevel = "HIGH" | "MEDIUM" | "LOW";

/**
 * Presentation buckets for the ledger's 0..1 importance score. This is a
 * reading aid, not an editorial threshold: the pipeline's own selection gates
 * are untouched by it and the raw score stays visible on the story page.
 */
export function importanceLevelFromScore(score: number): ImportanceLevel {
	if (score >= 0.75) return "HIGH";
	if (score >= 0.45) return "MEDIUM";
	return "LOW";
}

/**
 * A sentence ends at a CJK terminator, or at an ASCII one that is followed by
 * whitespace or the end of the text -- so "Homebrew 7.0.0" stays one token.
 */
export function splitSentences(text: string): string[] {
	const flat = text.replace(/\s+/g, " ").trim();
	const out: string[] = [];
	let start = 0;
	for (let i = 0; i < flat.length; i++) {
		const ch = flat[i] ?? "";
		const cjkEnd = ch === "。" || ch === "！" || ch === "？";
		const asciiEnd =
			(ch === "." || ch === "!" || ch === "?") && (i + 1 === flat.length || flat[i + 1] === " ");
		if (!cjkEnd && !asciiEnd) continue;
		const sentence = flat.slice(start, i + 1).trim();
		if (sentence !== "") out.push(sentence);
		start = i + 1;
	}
	const tail = flat.slice(start).trim();
	if (tail !== "") out.push(tail);
	return out;
}

/**
 * Below this length a lone opening sentence is treated as a lead-in rather
 * than a summary, and the next sentence is clipped in after it.
 */
export const SHORT_LEAD_CHARS = 40;

/**
 * The first whole sentences of `text` that fit inside `maxChars`. Always at
 * least one sentence; a first sentence that is itself too long is clipped with
 * an ellipsis rather than dropped, because an empty hero is worse than a long one.
 *
 * A very short first sentence followed by one that does not fit is the
 * pattern of a throat-clearing opener ("今日……呈現出強烈對比。") with the
 * substance in sentence two. In that case the second sentence is clipped in,
 * so the hero carries actual content rather than only the lead-in.
 */
export function leadSentences(text: string, maxChars: number, maxSentences = 2): string {
	const sentences = splitSentences(text);
	if (sentences.length === 0) return "";
	let out = "";
	let taken = 0;
	for (const sentence of sentences.slice(0, maxSentences)) {
		const candidate = `${out}${joiner(out)}${sentence}`;
		if (candidate.length > maxChars) break;
		out = candidate;
		taken++;
	}
	if (out === "") {
		const first = sentences[0] ?? "";
		return clip(first, maxChars);
	}
	const next = sentences[taken];
	if (taken === 1 && maxSentences > 1 && out.length < SHORT_LEAD_CHARS && next !== undefined) {
		return clip(`${out}${joiner(out)}${next}`, maxChars);
	}
	return out;
}

/** CJK sentences run together; only ASCII-terminated ones take a space. */
function joiner(before: string): string {
	if (before === "") return "";
	return /[。！？]$/.test(before) ? "" : " ";
}

function clip(text: string, maxChars: number): string {
	return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

/** The change types that mean something moved; NO_MATERIAL_CHANGE is not one of them. */
const CHANGE_PRIORITY: readonly ChangeType[] = [
	"ESCALATION",
	"REVERSAL",
	"RESOLUTION",
	"UPDATE",
	"CONFIRMATION",
	"RUMOR",
	"NEW",
];

/** True for a change type that counts as an update to something already known. */
export function isUpdateChange(type: ChangeType | undefined): boolean {
	return type !== undefined && type !== "NEW" && type !== "NO_MATERIAL_CHANGE";
}

export interface StoryCardView {
	storyId: string;
	title: string;
	section: string;
	mustKnow: boolean;
	/** From the ledger row for the same story and date; absent when there is none. */
	changeType: ChangeType | undefined;
	importance: ImportanceLevel | undefined;
	confidence: ConfidenceLevel;
	/** Opening sentence(s) of the editor's "why it matters". */
	takeaway: string;
	sourceCount: number;
}

export interface MustKnowCardView extends StoryCardView {
	/** 1-based display rank, in the order the editor listed the stories. */
	rank: number;
}

export interface ChangeRowView {
	storyId: string;
	title: string;
	changeType: ChangeType;
}

export interface SignalCardView {
	label: string;
	summary: string;
	state: SignalState | undefined;
	confidence: ConfidenceLevel | undefined;
	storyCount: number;
	/** Distinct cited items across the signal's stories that are in this brief. */
	sourceCount: number;
	/** Inclusive day span between first and last observation, when tracked. */
	daySpan: number | undefined;
	storyIds: string[];
}

export interface SectionView {
	key: string;
	heading: string;
	rows: StoryCardView[];
	/** How many stories the section holds beyond `rows`. */
	overflow: number;
	total: number;
}

export interface LateItemView {
	itemId: string;
	title: string;
	sourceName: string;
	url: string | undefined;
	fetchedAt: string;
	storyId: string | undefined;
}

export interface DashboardView {
	date: string;
	producedAt: string;
	hero: {
		summary: string;
		stats: {
			stories: number;
			mustKnow: number;
			updates: number;
			signals: number;
			newSinceMorning: number;
		};
	};
	mustKnow: MustKnowCardView[];
	changes: ChangeRowView[];
	signals: SignalCardView[];
	sections: SectionView[];
	/** `capped` means the query hit its fetch limit, so `total` is a floor, not a count. */
	newSinceMorning: { total: number; capped: boolean; items: LateItemView[] };
	analysis: { preview: string; full: string; truncated: boolean };
	watchNext: string[];
	/** What the day's run read and discarded; absent when the run left no record. */
	workload: DayWorkloadView | undefined;
}

/** The day's work, as the pipeline recorded it. Every field is a count of rows. */
export interface DayWorkload {
	/** Items the curator recorded a decision on — the scan-coverage number. */
	itemsScanned: number;
	/** Collectors that fetched at least one item for this run. */
	sources: number;
	/** Decisions by disposition; a missing key is zero. */
	dispositions: Readonly<Partial<Record<"IRRELEVANT" | "DUPLICATE" | "CANDIDATE", number>>>;
}

export interface DayWorkloadView {
	itemsScanned: number;
	sources: number;
	irrelevant: number;
	duplicate: number;
	/** Stories in the brief — what the reader actually gets. */
	storiesKept: number;
	/** Ledger rows judged NO_MATERIAL_CHANGE: read, recorded, and kept out. */
	unchangedStories: number;
}

export interface DashboardInput {
	brief: DailyBrief;
	/** Ledger rows for the brief's date, any order; matched by storyId. */
	ledger: readonly StoryLedgerEntry[];
	/** Tracked signal records; matched to the brief's signals by label. */
	signalRecords: readonly EmergingSignal[];
	lateItems: readonly LateItem[];
	/** Optional: a page rendered from fixtures, or a day whose run row is gone, has none. */
	workload?: DayWorkload;
}

export const DASHBOARD_LIMITS = Object.freeze({
	/*
	 * Effectively "two whole sentences", not a character budget.
	 *
	 * This was 200, which is narrower than the briefs actually are. Measured
	 * across every published day, the opening sentences run 40-151 characters
	 * and the second 100-180, so two of them need up to 251 -- and on three of
	 * the first four days the second sentence did not fit and was dropped. The
	 * hero then showed a single sentence, which is a headline, not "60 秒掌握
	 * 今天": on 2026-09-16 it said the shift was structural and cut away every
	 * word saying what shifted.
	 *
	 * `leadSentences` caps at `maxSentences` (2 here) before it ever consults
	 * this number, so a large value does not make the hero unbounded -- it makes
	 * the sentence count the bound and stops a long second sentence from being
	 * silently thrown away. The clip path survives for a single sentence longer
	 * than this, which no brief has produced.
	 */
	heroChars: 1000,
	takeawayChars: 96,
	changes: 6,
	sectionRows: 4,
	lateItems: 3,
	analysisChars: 320,
	signalChars: 160,
	/** How many late items the page read asks for; at this many the count is shown as a floor. */
	lateItemsFetch: 200,
});

export function buildDashboard(input: DashboardInput): DashboardView {
	const { brief, lateItems } = input;
	const ledger = new Map(input.ledger.map((entry) => [entry.storyId, entry] as const));
	const cards = brief.stories.map((story) => toCard(story, ledger.get(story.storyId)));

	const mustKnow = cards
		.filter((card) => card.mustKnow)
		.map((card, index) => ({ ...card, rank: index + 1 }));

	const changes = buildChanges(cards);
	const signals = brief.emergingSignals.map((signal) =>
		toSignalCard(signal, brief.stories, input.signalRecords),
	);

	const sections: SectionView[] = [];
	for (const [key, heading] of TOPICAL_SECTIONS) {
		const rows = cards.filter((card) => card.section === key);
		if (rows.length === 0) continue;
		sections.push({
			key,
			heading,
			rows: rows.slice(0, DASHBOARD_LIMITS.sectionRows),
			overflow: Math.max(0, rows.length - DASHBOARD_LIMITS.sectionRows),
			total: rows.length,
		});
	}

	const analysisFull = brief.dailyAnalysis.trim();
	const analysisPreview = leadSentences(analysisFull, DASHBOARD_LIMITS.analysisChars, 3);

	return {
		date: brief.date,
		producedAt: brief.producedAt,
		hero: {
			summary: leadSentences(analysisFull, DASHBOARD_LIMITS.heroChars),
			stats: {
				stories: brief.stories.length,
				mustKnow: mustKnow.length,
				updates: cards.filter((card) => isUpdateChange(card.changeType)).length,
				signals: brief.emergingSignals.length,
				newSinceMorning: lateItems.length,
			},
		},
		mustKnow,
		changes,
		signals,
		sections,
		newSinceMorning: {
			total: lateItems.length,
			capped: lateItems.length >= DASHBOARD_LIMITS.lateItemsFetch,
			items: lateItems.slice(0, DASHBOARD_LIMITS.lateItems).map((item) => ({
				itemId: item.itemId,
				title: item.title,
				sourceName: displaySourceName(item.sourceName),
				url: item.url,
				fetchedAt: item.fetchedAt,
				storyId: item.storyId,
			})),
		},
		workload: input.workload ? toWorkloadView(input.workload, brief, input.ledger) : undefined,
		analysis: {
			preview: analysisPreview,
			full: analysisFull,
			truncated: analysisPreview.length < analysisFull.length,
		},
		watchNext: brief.watchNext.map((entry) => entry.trim()).filter((entry) => entry !== ""),
	};
}

function toCard(story: DailyBriefStory, entry: StoryLedgerEntry | undefined): StoryCardView {
	return {
		storyId: story.storyId,
		title: story.title,
		section: story.section,
		mustKnow: story.mustKnow,
		changeType: entry?.changeType,
		importance: entry === undefined ? undefined : importanceLevelFromScore(entry.importance),
		confidence: story.confidence,
		takeaway: leadSentences(story.whyItMatters, DASHBOARD_LIMITS.takeawayChars, 1),
		sourceCount: story.sourceItemIds.length,
	};
}

/**
 * One line per story that changed, strongest kind of change first, in editor
 * order within a kind. Stories with no ledger row have no known change and are
 * left out rather than labelled.
 */
function buildChanges(cards: readonly StoryCardView[]): ChangeRowView[] {
	const rows: ChangeRowView[] = [];
	for (const type of CHANGE_PRIORITY) {
		for (const card of cards) {
			if (card.changeType !== type) continue;
			rows.push({ storyId: card.storyId, title: card.title, changeType: type });
		}
	}
	return rows.slice(0, DASHBOARD_LIMITS.changes);
}

function toSignalCard(
	signal: DailyBrief["emergingSignals"][number],
	stories: readonly DailyBriefStory[],
	records: readonly EmergingSignal[],
): SignalCardView {
	const record = records.find((r) => r.label === signal.label);
	const linked = new Set(signal.storyIds);
	const sources = new Set<string>();
	for (const story of stories) {
		if (!linked.has(story.storyId)) continue;
		for (const id of story.sourceItemIds) sources.add(id);
	}
	return {
		label: signal.label,
		summary: leadSentences(signal.body, DASHBOARD_LIMITS.signalChars, 2),
		state: record?.state,
		confidence: record === undefined ? undefined : confidenceLevelFromScore(record.confidence),
		storyCount: signal.storyIds.length,
		sourceCount: sources.size,
		daySpan: record === undefined ? undefined : daySpan(record.firstSeenAt, record.lastSeenAt),
		storyIds: [...signal.storyIds],
	};
}

function daySpan(first: string, last: string): number | undefined {
	const a = Date.parse(first);
	const b = Date.parse(last);
	if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
	const days = Math.floor((b - a) / 86_400_000);
	return Math.max(1, days + 1);
}

function toWorkloadView(
	workload: DayWorkload,
	brief: DailyBrief,
	ledger: readonly StoryLedgerEntry[],
): DayWorkloadView {
	return {
		itemsScanned: workload.itemsScanned,
		sources: workload.sources,
		irrelevant: workload.dispositions.IRRELEVANT ?? 0,
		duplicate: workload.dispositions.DUPLICATE ?? 0,
		storiesKept: brief.stories.length,
		unchangedStories: ledger.filter((entry) => entry.changeType === "NO_MATERIAL_CHANGE").length,
	};
}
