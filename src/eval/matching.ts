import type { GoldTruth } from "../schemas/gold.ts";

/** Minimal story shape the matcher needs. Deliberately title-free: matching on
 * titles would reward a model for echoing wording instead of grouping sources. */
export interface MatchableStory {
	storyId: string;
	sourceItemIds: string[];
	primarySourceIds: string[];
}

export interface StoryEventMatch {
	storyId: string;
	eventId: string;
	jaccard: number;
	primaryHit: boolean;
}

export interface MatchResult {
	matches: StoryEventMatch[];
	unmatchedStoryIds: string[];
	unmatchedEventIds: string[];
}

/** Accept a pair outright at this overlap. */
const JACCARD_ACCEPT = 0.3;
/** Lower bar, only reachable when the story carries one of the event's primary items. */
const JACCARD_PRIMARY_RESCUE = 0.15;

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 && b.size === 0) return 0;
	let intersection = 0;
	for (const value of a) if (b.has(value)) intersection += 1;
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

function intersects(a: readonly string[], b: ReadonlySet<string>): boolean {
	for (const value of a) if (b.has(value)) return true;
	return false;
}

/**
 * Greedy one-to-one assignment of produced stories to gold events by item-set
 * membership. Highest-overlap pairs win first; ties break on (eventId, storyId)
 * lexical order so the same inputs always produce the same assignment.
 */
export function matchStoriesToEvents(stories: MatchableStory[], gold: GoldTruth): MatchResult {
	const storyItems = new Map<string, Set<string>>();
	for (const story of stories) storyItems.set(story.storyId, new Set(story.sourceItemIds));

	// Hoisted above the story loop: these depend only on the event, so building
	// them per (story, event) pair rebuilt the same sets |stories| times.
	const eventSets = gold.events.map((event) => ({
		event,
		items: new Set(event.itemIds),
		primary: new Set(event.primaryItemIds),
	}));

	const candidates: StoryEventMatch[] = [];
	for (const story of stories) {
		const items = storyItems.get(story.storyId) ?? new Set<string>();
		for (const { event, items: eventItems, primary: eventPrimary } of eventSets) {
			const score = jaccard(items, eventItems);
			const storyTouchesPrimary = intersects(story.sourceItemIds, eventPrimary);
			const eligible =
				score >= JACCARD_ACCEPT || (storyTouchesPrimary && score >= JACCARD_PRIMARY_RESCUE);
			if (!eligible) continue;
			candidates.push({
				storyId: story.storyId,
				eventId: event.eventId,
				jaccard: score,
				primaryHit: intersects(story.primarySourceIds, eventPrimary),
			});
		}
	}

	candidates.sort((a, b) => {
		if (b.jaccard !== a.jaccard) return b.jaccard - a.jaccard;
		if (a.eventId !== b.eventId) return a.eventId < b.eventId ? -1 : 1;
		return a.storyId < b.storyId ? -1 : a.storyId > b.storyId ? 1 : 0;
	});

	const takenStories = new Set<string>();
	const takenEvents = new Set<string>();
	const matches: StoryEventMatch[] = [];
	for (const candidate of candidates) {
		if (takenStories.has(candidate.storyId) || takenEvents.has(candidate.eventId)) continue;
		takenStories.add(candidate.storyId);
		takenEvents.add(candidate.eventId);
		matches.push(candidate);
	}

	return {
		matches,
		unmatchedStoryIds: stories.map((s) => s.storyId).filter((id) => !takenStories.has(id)),
		unmatchedEventIds: gold.events.map((e) => e.eventId).filter((id) => !takenEvents.has(id)),
	};
}
