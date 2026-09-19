/*
 * Did the story-ledger change work?
 *
 * Two things shipped together on 2026-09-19 and this measures both, from the
 * run log and the ledger, with no model and no replay.
 *
 * `list_today_stories` stopped returning every story's title and returns the
 * ids alone. That was 73% of a term the day paid about 140,000 tokens for, and
 * the saving is arithmetic once the result sizes are known.
 *
 * The harder question is the one the titles were supposedly there for. The day
 * shipped at least ten pairs that are one event under two slugs while the whole
 * 153-row list sat in context, so `upsert_story` now names a near neighbour in
 * its receipt. That check can fail in two directions and the numbers below keep
 * them apart: a fire the model ignored and was right to ignore is not the same
 * as a fire it ignored and shipped a split event, and a pair that survives to
 * the final ledger is not proof of either until someone reads the two titles.
 *
 * Nothing here merges, rewrites or scores a decision. It reports pairs and
 * leaves the judgement where it belongs.
 */

import type { StoryLedgerEntry } from "../schemas/index.ts";

/**
 * How many times a tool result is re-sent to the provider over the rest of its
 * work unit, and how many characters of amplified context one prompt token
 * buys. Both measured across the 2026-09-18 and 2026-09-19 runs -- 4.56 mean
 * occurrences, and a regression of prompt tokens on amplified characters with
 * R² 0.910. They convert a character count into the thing that is actually
 * billed, and are stated here so a reader can see which figures are measured
 * and which are derived from them.
 */
export const AMPLIFICATION = 4.56;
export const CHARS_PER_PROMPT_TOKEN = 3.395;

export function amplifiedTokens(chars: number): number {
	return Math.round((chars * AMPLIFICATION) / CHARS_PER_PROMPT_TOKEN);
}

/** Same tokenizer the ledger's history search uses, so today and yesterday rank alike. */
function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9一-鿿.+#-]+/)
		.filter((t) => t.length > 1);
}

/**
 * How much of `text`'s vocabulary `other` accounts for. Asymmetric, exactly as
 * the live check is: the story being written is the one asking.
 */
export function overlap(text: string, other: string): number {
	const terms = new Set(tokenize(text));
	if (terms.size === 0) return 0;
	const hay = new Set(tokenize(other));
	let hits = 0;
	for (const t of terms) if (hay.has(t)) hits += 1;
	return hits / terms.size;
}

export interface LedgerPair {
	/** The later story, by ledger ordinal: the one the check would have fired on. */
	storyId: string;
	title: string;
	/** The earlier story it resembles. */
	otherStoryId: string;
	otherTitle: string;
	score: number;
	/** True when the two share at least one source item, which makes a split much likelier. */
	sharesSource: boolean;
}

/**
 * Pairs in the final ledger that still look like one event.
 *
 * These are the residual after the model saw the warning and wrote both anyway
 * -- or after it never saw one, because the two were written far enough apart
 * in vocabulary to score below the threshold. Either way the pair is real in
 * the published ledger, so it is listed for a person to read. No pair is
 * removed for looking like a false positive; token overlap cannot tell "CFTC
 * extends passive software relief" from "CFTC eases passive wallet
 * registration", and deciding that is the whole reason this prints rather than
 * acts.
 */
export function residualPairs(
	entries: readonly StoryLedgerEntry[],
	threshold: number,
): LedgerPair[] {
	const pairs: LedgerPair[] = [];
	for (let i = 0; i < entries.length; i += 1) {
		const later = entries[i]!;
		for (let j = 0; j < i; j += 1) {
			const earlier = entries[j]!;
			const score = overlap(later.canonicalTitle, earlier.canonicalTitle);
			if (score < threshold) continue;
			const shared = new Set(earlier.sourceItemIds);
			pairs.push({
				storyId: later.storyId,
				title: later.canonicalTitle,
				otherStoryId: earlier.storyId,
				otherTitle: earlier.canonicalTitle,
				score: Number(score.toFixed(3)),
				sharesSource: later.sourceItemIds.some((id) => shared.has(id)),
			});
		}
	}
	// Strongest first, then by id, so two runs over the same ledger print the
	// same report in the same order.
	pairs.sort(
		(a, b) =>
			b.score - a.score ||
			a.storyId.localeCompare(b.storyId) ||
			a.otherStoryId.localeCompare(b.otherStoryId),
	);
	return pairs;
}

/** One `note()` payload from the run log, as far as this cares about it. */
export interface LedgerEvent {
	kind?: string;
	stage?: string;
	tool?: string;
	ts?: string;
	chars?: number;
	count?: number;
	total?: number;
	hits?: number;
	match?: string;
	storyId?: string;
	todayNear?: string[];
	todayNearTop?: string;
	todayNearScore?: number;
}

export interface NearFire {
	ts: string | undefined;
	/** The story the model was writing when the check fired. */
	storyId: string;
	/** The strongest existing neighbour it was pointed at. */
	top: string;
	score: number;
	candidates: string[];
	/**
	 * True when a later upsert in the same run wrote under one of the named
	 * candidates. That is the model accepting the hint: the id it merges into is
	 * already recorded on every upsert, so acceptance needs no new telemetry.
	 *
	 * It is a lower bound on agreement, not a verdict. The model may reasonably
	 * decide the two are different events, and a fire it declined is a false
	 * positive only if the final ledger still holds them as one event -- which
	 * is what residualPairs is for.
	 */
	accepted: boolean;
}

export interface LedgerTelemetry {
	/** Every `list_today_stories` result and what it cost. */
	listCalls: number;
	listChars: number;
	listTokens: number;
	/** Calls that passed `match` rather than taking the whole id list. */
	listMatchCalls: number;
	largestList: number;
	fires: NearFire[];
	accepted: number;
	declined: number;
	upserts: number;
}

/**
 * Reads a run's events. Pass the events for one run, already filtered: this
 * counts what it is given and does not know which day it is looking at.
 */
export function ledgerTelemetry(events: readonly LedgerEvent[]): LedgerTelemetry {
	const fires: NearFire[] = [];
	const writtenAt = new Map<string, number[]>();
	let upserts = 0;
	let listCalls = 0;
	let listMatchCalls = 0;
	let listChars = 0;
	let largestList = 0;

	events.forEach((e, index) => {
		if (e.kind === "tool_result" && e.tool === "list_today_stories") {
			listChars += e.chars ?? 0;
			largestList = Math.max(largestList, e.chars ?? 0);
		}
		if (e.kind === "tool_call" && e.tool === "list_today_stories") {
			listCalls += 1;
			if (e.match !== undefined) listMatchCalls += 1;
		}
		if (e.kind === "tool_call" && e.tool === "upsert_story") {
			if (e.storyId !== undefined) {
				upserts += 1;
				// Every index each id was written at, not just the first. A
				// candidate the check names has almost always been written once
				// already -- that is why it exists to be named -- so acceptance is
				// a write that comes after the warning, and recording only the
				// first occurrence would report every fire as declined.
				const seen = writtenAt.get(e.storyId);
				if (seen) seen.push(index);
				else writtenAt.set(e.storyId, [index]);
			}
			if (e.todayNear && e.todayNear.length > 0 && e.storyId !== undefined) {
				fires.push({
					ts: e.ts,
					storyId: e.storyId,
					top: e.todayNearTop ?? e.todayNear[0]!,
					score: e.todayNearScore ?? 0,
					candidates: e.todayNear,
					accepted: false,
				});
			}
		}
	});

	for (const fire of fires) {
		const at = events.findIndex((e) => e.ts === fire.ts && e.storyId === fire.storyId);
		fire.accepted = fire.candidates.some((id) =>
			(writtenAt.get(id) ?? []).some((i) => i > at),
		);
	}

	const accepted = fires.filter((f) => f.accepted).length;
	return {
		listCalls,
		listChars,
		listTokens: amplifiedTokens(listChars),
		listMatchCalls,
		largestList,
		fires,
		accepted,
		declined: fires.length - accepted,
		upserts,
	};
}

/**
 * What the same `list_today_stories` calls would have cost with titles.
 *
 * The saving is not a projection: the ids returned are in the ledger, so the
 * old payload can be rebuilt exactly for each call and the difference measured.
 * `sizes` is the number of stories each call returned, in order.
 */
export function listSavings(
	entries: readonly StoryLedgerEntry[],
	sizes: readonly number[],
): { before: number; after: number; beforeTokens: number; afterTokens: number } {
	let before = 0;
	let after = 0;
	for (const n of sizes) {
		const slice = entries.slice(0, n);
		before += JSON.stringify({
			stories: slice.map((s) => ({
				storyId: s.storyId,
				title: s.canonicalTitle,
				changeType: s.changeType,
				sourceItems: s.sourceItemIds.length,
			})),
		}).length;
		after += JSON.stringify({ total: n, storyIds: slice.map((s) => s.storyId) }).length;
	}
	return {
		before,
		after,
		beforeTokens: amplifiedTokens(before),
		afterTokens: amplifiedTokens(after),
	};
}
