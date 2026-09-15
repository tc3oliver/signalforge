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

/** The one total ordering over candidate pairs: overlap first, then ids, so the
 * same inputs always yield the same assignment and the same reported order. */
function byPreference(a: StoryEventMatch, b: StoryEventMatch): number {
	if (b.jaccard !== a.jaccard) return b.jaccard - a.jaccard;
	if (a.eventId !== b.eventId) return a.eventId < b.eventId ? -1 : 1;
	return a.storyId < b.storyId ? -1 : a.storyId > b.storyId ? 1 : 0;
}

/**
 * Maximum one-to-one assignment of produced stories to gold events by item-set
 * membership.
 *
 * This was greedy over candidates sorted by overlap, and greedy is not merely
 * suboptimal here: a high-scoring pair could consume the only story an event was
 * eligible for, leaving that event unmatched. `importantStoryRecall` and
 * `selectedStoryPrecision` then charged the resulting miss to the model, which
 * had in fact produced a story for every event. So the assignment now maximises
 * the number of matched pairs (Kuhn's augmenting-path search -- the two sets are
 * a day's worth of stories and events, so the cost is irrelevant).
 *
 * Determinism still matters more than which maximum is found, because the
 * stability report compares assignments across lineages: events are processed
 * best-overlap first and each event's candidates are tried in (jaccard desc,
 * storyId) order, both derived from one total ordering of the candidate list.
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

	candidates.sort(byPreference);

	// Insertion order of this map is the event order the search uses: an event's
	// first appearance in the sorted candidate list, i.e. best overlap first with
	// eventId breaking ties. Each list is already (jaccard desc, storyId) sorted
	// because the global comparator groups by eventId second.
	const byEvent = new Map<string, StoryEventMatch[]>();
	for (const candidate of candidates) {
		const list = byEvent.get(candidate.eventId);
		if (list) list.push(candidate);
		else byEvent.set(candidate.eventId, [candidate]);
	}

	const matchByEvent = new Map<string, StoryEventMatch>();
	const eventByStory = new Map<string, string>();

	/**
	 * Augmenting-path step, free stories first.
	 *
	 * The second loop is what makes the matching maximum, but running it alone
	 * would let an event displace a holder that had no need to move, changing a
	 * settled pairing for no gain in cardinality. Taking an unclaimed story when
	 * one is available keeps the preferred pairing and leaves displacement as a
	 * last resort.
	 */
	function augment(eventId: string, visited: Set<string>): boolean {
		const list = byEvent.get(eventId) ?? [];
		for (const candidate of list) {
			if (visited.has(candidate.storyId)) continue;
			if (eventByStory.has(candidate.storyId)) continue;
			visited.add(candidate.storyId);
			eventByStory.set(candidate.storyId, eventId);
			matchByEvent.set(eventId, candidate);
			return true;
		}
		for (const candidate of list) {
			if (visited.has(candidate.storyId)) continue;
			visited.add(candidate.storyId);
			const holder = eventByStory.get(candidate.storyId);
			if (holder !== undefined && augment(holder, visited)) {
				eventByStory.set(candidate.storyId, eventId);
				matchByEvent.set(eventId, candidate);
				return true;
			}
		}
		return false;
	}

	for (const eventId of byEvent.keys()) augment(eventId, new Set<string>());

	const matches = [...matchByEvent.values()].sort(byPreference);
	const takenStories = new Set(eventByStory.keys());
	return {
		matches,
		unmatchedStoryIds: stories.map((s) => s.storyId).filter((id) => !takenStories.has(id)),
		unmatchedEventIds: gold.events.map((e) => e.eventId).filter((id) => !matchByEvent.has(id)),
	};
}
