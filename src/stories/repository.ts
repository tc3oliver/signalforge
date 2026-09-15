import type { ItemDecision } from "../schemas/decision.ts";
import type { StoryLedgerEntry, StoryUpsertPayload } from "../schemas/story.ts";

/** Free-text / id search over prior days' ledger entries. */
export interface StoryHistoryQuery {
	text?: string;
	storyId?: string;
	/** Only dates strictly before this one are searched. */
	beforeDate: string;
	limit?: number;
}

/**
 * Storage boundary for the story ledger and the curator's per-item decisions.
 *
 * The agent workflow only ever talks to this interface, so swapping the JSON
 * files for PostgreSQL later is a constructor change and nothing else.
 */
export interface StoryRepository {
	getStory(storyId: string): Promise<StoryLedgerEntry | undefined>;
	listStories(date: string): Promise<StoryLedgerEntry[]>;
	/**
	 * Create or merge this date's entry for `input.storyId`.
	 *
	 * Same storyId on this date -> merge: union the id arrays, overwrite the
	 * scores/changeType/status/reason/canonicalTitle, keep the original
	 * firstSeenAt and bump lastSeenAt. Seen only on an earlier date -> create
	 * this date's entry but inherit firstSeenAt from the earliest prior
	 * occurrence, which is what gives a story cross-day continuity. Otherwise
	 * create fresh with firstSeenAt = lastSeenAt = now.
	 */
	upsertStory(date: string, input: StoryUpsertPayload, now: Date): Promise<StoryLedgerEntry>;
	findHistory(query: StoryHistoryQuery): Promise<StoryLedgerEntry[]>;
	/** Idempotent per itemId: re-recording an itemId replaces its prior decision. */
	recordDecisions(date: string, decisions: ItemDecision[]): Promise<void>;
	listDecisions(date: string): Promise<ItemDecision[]>;
	processedItemIds(date: string): Promise<Set<string>>;
}
