import type { Sql } from "../db/client.ts";
import {
	findStoriesByTokens,
	findStoryById,
	getLatestStory,
	listDecisionsForDate,
	listStoriesForDate,
	processedItemIdsForDate,
	upsertDecisions,
	upsertStoryRow,
} from "../db/stories.ts";
import type { ItemDecision } from "../schemas/decision.ts";
import type { StoryLedgerEntry, StoryUpsertInput } from "../schemas/story.ts";
import type { StoryHistoryQuery, StoryRepository } from "./repository.ts";

const DEFAULT_HISTORY_LIMIT = 10;

/** Mirrors the file-backed repository's tokeniser; the two must agree. */
function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9一-鿿]+/u)
		.filter((t) => t.length > 0);
}

/**
 * Postgres-backed ledger. Drop-in for `JsonStoryRepository`: same merge and
 * firstSeenAt-inheritance semantics, same history ranking.
 *
 * `lineage` namespaces every row. A synthetic or eval timeline passes its own
 * value and can then share a database with production without a slug collision.
 */
export class PostgresStoryRepository implements StoryRepository {
	readonly #sql: Sql;
	readonly #lineage: string;

	constructor(sql: Sql, lineage = process.env["DI_LINEAGE"] ?? "default") {
		this.#sql = sql;
		this.#lineage = lineage;
	}

	async getStory(storyId: string): Promise<StoryLedgerEntry | undefined> {
		return getLatestStory(this.#sql, this.#lineage, storyId);
	}

	async listStories(date: string): Promise<StoryLedgerEntry[]> {
		return listStoriesForDate(this.#sql, this.#lineage, date);
	}

	async upsertStory(
		date: string,
		input: StoryUpsertInput,
		now: Date,
	): Promise<StoryLedgerEntry> {
		return upsertStoryRow(this.#sql, this.#lineage, date, input, now.toISOString());
	}

	async findHistory(query: StoryHistoryQuery): Promise<StoryLedgerEntry[]> {
		const limit = query.limit ?? DEFAULT_HISTORY_LIMIT;
		if (limit <= 0) return [];
		if (query.storyId !== undefined) {
			return findStoryById(this.#sql, this.#lineage, query.storyId, query.beforeDate, limit);
		}
		const tokens = tokenize(query.text ?? "");
		if (tokens.length === 0) return [];
		return findStoriesByTokens(this.#sql, this.#lineage, tokens, query.beforeDate, limit);
	}

	async recordDecisions(date: string, decisions: ItemDecision[]): Promise<void> {
		await upsertDecisions(this.#sql, this.#lineage, date, decisions);
	}

	async listDecisions(date: string): Promise<ItemDecision[]> {
		return listDecisionsForDate(this.#sql, this.#lineage, date);
	}

	async processedItemIds(date: string): Promise<Set<string>> {
		return processedItemIdsForDate(this.#sql, this.#lineage, date);
	}
}
