import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJsonIfExists, writeJsonAtomic } from "../runtime/atomic-json.ts";
import type { ItemDecision } from "../schemas/decision.ts";
import type { StoryLedgerEntry, StoryUpsertInput } from "../schemas/story.ts";
import type { StoryHistoryQuery, StoryRepository } from "./repository.ts";

const DEFAULT_HISTORY_LIMIT = 10;

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9一-鿿]+/u)
		.filter((t) => t.length > 0);
}

function union(a: readonly string[], b: readonly string[]): string[] {
	const out: string[] = [...a];
	for (const value of b) if (!out.includes(value)) out.push(value);
	return out;
}

/**
 * File-backed ledger: `<root>/<date>/story-ledger.json` and
 * `<root>/<date>/item-decisions.json`, every write atomic.
 */
export class JsonStoryRepository implements StoryRepository {
	readonly #root: string;
	readonly #stories = new Map<string, StoryLedgerEntry[]>();
	readonly #decisions = new Map<string, ItemDecision[]>();

	constructor(root: string) {
		this.#root = root;
	}

	#storyPath(date: string): string {
		return join(this.#root, date, "story-ledger.json");
	}

	#decisionPath(date: string): string {
		return join(this.#root, date, "item-decisions.json");
	}

	/** Dates present on disk, ascending. */
	#dates(): string[] {
		if (!existsSync(this.#root)) return [];
		return readdirSync(this.#root, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort();
	}

	#loadStories(date: string): StoryLedgerEntry[] {
		const cached = this.#stories.get(date);
		if (cached) return cached;
		const loaded = readJsonIfExists<StoryLedgerEntry[]>(this.#storyPath(date)) ?? [];
		this.#stories.set(date, loaded);
		return loaded;
	}

	#loadDecisions(date: string): ItemDecision[] {
		const cached = this.#decisions.get(date);
		if (cached) return cached;
		const loaded = readJsonIfExists<ItemDecision[]>(this.#decisionPath(date)) ?? [];
		this.#decisions.set(date, loaded);
		return loaded;
	}

	/** Known dates plus any date that exists only in the write-through cache. */
	#allDates(): string[] {
		return union(this.#dates(), [...this.#stories.keys()]).sort();
	}

	async getStory(storyId: string): Promise<StoryLedgerEntry | undefined> {
		for (const date of this.#allDates().reverse()) {
			const hit = this.#loadStories(date).find((s) => s.storyId === storyId);
			if (hit) return hit;
		}
		return undefined;
	}

	async listStories(date: string): Promise<StoryLedgerEntry[]> {
		return [...this.#loadStories(date)];
	}

	async upsertStory(
		date: string,
		input: StoryUpsertInput,
		now: Date,
	): Promise<StoryLedgerEntry> {
		const nowIso = now.toISOString();
		const entries = this.#loadStories(date);
		const index = entries.findIndex((s) => s.storyId === input.storyId);
		const factRefs = input.factRefs ?? [];

		let entry: StoryLedgerEntry;
		if (index >= 0) {
			const prior = entries[index] as StoryLedgerEntry;
			entry = {
				...prior,
				canonicalTitle: input.canonicalTitle,
				sourceItemIds: union(prior.sourceItemIds, input.sourceItemIds),
				primarySourceIds: union(prior.primarySourceIds, input.primarySourceIds),
				factRefs: union(prior.factRefs, factRefs),
				status: input.status,
				changeType: input.changeType,
				relevance: input.relevance,
				novelty: input.novelty,
				importance: input.importance,
				confidence: input.confidence,
				reason: input.reason,
				lastSeenAt: nowIso,
			};
			entries[index] = entry;
		} else {
			entry = {
				storyId: input.storyId,
				date,
				canonicalTitle: input.canonicalTitle,
				sourceItemIds: [...input.sourceItemIds],
				primarySourceIds: [...input.primarySourceIds],
				// Inherited from the earliest prior day so continuity survives the
				// per-date file layout.
				firstSeenAt: this.#earliestFirstSeenAt(input.storyId, date) ?? nowIso,
				lastSeenAt: nowIso,
				status: input.status,
				changeType: input.changeType,
				relevance: input.relevance,
				novelty: input.novelty,
				importance: input.importance,
				confidence: input.confidence,
				reason: input.reason,
				factRefs: [...factRefs],
			};
			entries.push(entry);
		}

		this.#stories.set(date, entries);
		writeJsonAtomic(this.#storyPath(date), entries);
		return entry;
	}

	#earliestFirstSeenAt(storyId: string, beforeDate: string): string | undefined {
		for (const date of this.#allDates()) {
			if (date >= beforeDate) break;
			const hit = this.#loadStories(date).find((s) => s.storyId === storyId);
			if (hit) return hit.firstSeenAt;
		}
		return undefined;
	}

	async findHistory(query: StoryHistoryQuery): Promise<StoryLedgerEntry[]> {
		const limit = query.limit ?? DEFAULT_HISTORY_LIMIT;
		if (limit <= 0) return [];
		const dates = this.#allDates()
			.filter((d) => d < query.beforeDate)
			.reverse();

		const scored: Array<{ entry: StoryLedgerEntry; score: number; date: string }> = [];
		const queryTokens = query.storyId ? [] : tokenize(query.text ?? "");

		for (const date of dates) {
			for (const entry of this.#loadStories(date)) {
				if (query.storyId !== undefined) {
					if (entry.storyId === query.storyId) scored.push({ entry, score: 1, date });
					continue;
				}
				if (queryTokens.length === 0) continue;
				const haystack = new Set(tokenize(`${entry.canonicalTitle} ${entry.reason}`));
				const hits = queryTokens.filter((t) => haystack.has(t)).length;
				const score = hits / queryTokens.length;
				if (score > 0) scored.push({ entry, score, date });
			}
		}

		scored.sort((a, b) => (b.score - a.score) || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
		return scored.slice(0, limit).map((s) => s.entry);
	}

	async recordDecisions(date: string, decisions: ItemDecision[]): Promise<void> {
		const existing = this.#loadDecisions(date);
		for (const decision of decisions) {
			const index = existing.findIndex((d) => d.itemId === decision.itemId);
			if (index >= 0) existing[index] = decision;
			else existing.push(decision);
		}
		this.#decisions.set(date, existing);
		writeJsonAtomic(this.#decisionPath(date), existing);
	}

	async listDecisions(date: string): Promise<ItemDecision[]> {
		return [...this.#loadDecisions(date)];
	}

	async processedItemIds(date: string): Promise<Set<string>> {
		return new Set(this.#loadDecisions(date).map((d) => d.itemId));
	}
}
