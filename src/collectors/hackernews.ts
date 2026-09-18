import type { Collector, CollectorContext, CollectorResult } from "./types.ts";
import { CollectedItem } from "./types.ts";
import { decodeHtmlEntities, htmlToText } from "./html-text.ts";
import { RequestBudget, TokenBucket, fetchWithRetry, mapWithConcurrency } from "./http.ts";

const BASE_URL = "https://hacker-news.firebaseio.com/v0";
const LISTS = ["topstories", "beststories", "newstories"] as const;
type HnList = (typeof LISTS)[number];

/** Shape of a Firebase HN item, as far as we rely on it. Anything else is passed through raw. */
interface HnItem {
	id: number;
	type?: string;
	title?: string;
	url?: string;
	text?: string;
	by?: string;
	time?: number;
	score?: number;
	deleted?: boolean;
	dead?: boolean;
}

/** Cursor persisted between runs: ids already seen, capped to bound growth. */
interface HnCursor {
	seenIds: number[];
}

const MAX_SEEN_IDS = 5000;
const FETCH_CONCURRENCY = 8;

function parseCursor(raw: string | undefined): HnCursor {
	if (!raw) return { seenIds: [] };
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && Array.isArray((parsed as HnCursor).seenIds)) {
			return { seenIds: (parsed as HnCursor).seenIds.filter((n) => typeof n === "number") };
		}
	} catch {
		// Malformed cursor is treated as "no cursor" rather than fatal.
	}
	return { seenIds: [] };
}

function serializeCursor(seenIds: Set<number>): string {
	// Keep only the most recent ids (HN ids are monotonically increasing) to bound cursor size.
	const sorted = Array.from(seenIds).sort((a, b) => b - a).slice(0, MAX_SEEN_IDS);
	return JSON.stringify({ seenIds: sorted } satisfies HnCursor);
}

export class HackerNewsCollector implements Collector {
	readonly id = "hackernews";
	readonly sourceType = "hackernews" as const;
	readonly requiredSecrets: readonly string[] = [];

	async check(_ctx: CollectorContext): Promise<{ ok: boolean; detail: string }> {
		return { ok: true, detail: "hackernews requires no credentials" };
	}

	async collect(ctx: CollectorContext): Promise<CollectorResult> {
		const startedAt = ctx.now().toISOString();
		const warnings: string[] = [];
		const items: CollectedItem[] = [];
		const budget = new RequestBudget(2000);
		const bucket = new TokenBucket({ capacity: 10, refillPerSecond: 5 });
		const cursor = parseCursor(ctx.cursor);
		const seenIds = new Set(cursor.seenIds);

		let health: CollectorResult["health"] = "OK";
		let error: string | undefined;

		try {
			const idLists = await Promise.all(
				LISTS.map((list) => fetchList(ctx, list, budget, bucket)),
			);
			// Each HN list is up to 500 ids and every item costs its own request, so
			// taking all three whole is ~1500 requests behind a 5/sec bucket -- five
			// minutes for a source that is meant to be cheap enough to poll hourly.
			// The lists are already ranked, so the head of each is the part worth
			// having, and how much of it is an operator setting.
			const perList = Math.max(1, ctx.sourceConfig.pageSize);
			const candidateIds = Array.from(new Set(idLists.flatMap((ids) => ids.slice(0, perList))));
			// Incremental: skip ids already seen via the cursor.
			const newIds = candidateIds.filter((id) => !seenIds.has(id));

			const fetched = await mapWithConcurrency(newIds, FETCH_CONCURRENCY, async (id) => {
				try {
					return await fetchItem(ctx, id, budget, bucket);
				} catch (err) {
					warnings.push(`failed to fetch item ${id}: ${(err as Error).message}`);
					return undefined;
				}
			});

			/*
			 * The score floor. A volume control, not a relevance filter.
			 *
			 * `newstories` is one of the three lists this collector reads, and it is
			 * the only unranked one: it is every submission in arrival order, most
			 * of which no one has voted on yet. The head of a ranked list is the
			 * part worth having (see fetchList above); the head of an unranked one
			 * is merely the most recent.
			 *
			 * Measured on 2026-09-18, which took 366 HN items into a 1311-item day:
			 *
			 *   score     items  candidates  reached the brief
			 *   <20         320          15                  0
			 *   20-49        14           3                  0
			 *   50-99        15           3                  0
			 *   100-299      15           5                  -
			 *   >=300         2           1                  -
			 *
			 * The <20 bucket was 24% of the entire day's curation workload -- about
			 * thirteen minutes of model time -- and contributed nothing to the
			 * published brief. That is one day of evidence, which is why this is an
			 * operator setting with the measurement written down rather than a
			 * constant: set `minScore: 0` in sources.yaml to restore the old
			 * behaviour, and the warnings below say exactly what a run dropped.
			 */
			const minScore = ctx.sourceConfig.minScore ?? 0;
			let belowScoreFloor = 0;

			for (const hnItem of fetched) {
				if (!hnItem) continue;
				seenIds.add(hnItem.id);
				// Dropped for invalid/corrupt payload: no title means nothing to normalize into.
				if (hnItem.deleted || hnItem.dead) {
					warnings.push(`dropped ${hnItem.id}: deleted/dead item (source-policy)`);
					continue;
				}
				if (!hnItem.title) {
					warnings.push(`dropped ${hnItem.id}: missing title (invalid payload)`);
					continue;
				}
				// Absent score is treated as 0: an item HN has not scored yet is
				// precisely the unranked case this floor exists for.
				if (minScore > 0 && (hnItem.score ?? 0) < minScore) {
					belowScoreFloor += 1;
					continue;
				}
				items.push(toCollectedItem(hnItem, startedAt));
			}

			// One warning for the whole bucket, not one per item: at the shipped
			// floor this drops a few hundred items a day, and a warning each would
			// bury every other warning this collector has to report.
			if (belowScoreFloor > 0) {
				warnings.push(
					`dropped ${belowScoreFloor} item(s): score below minScore=${minScore} (source-policy)`,
				);
			}
		} catch (err) {
			health = "FAILED";
			error = (err as Error).message;
		}

		const finishedAt = ctx.now().toISOString();
		return {
			collectorId: this.id,
			health,
			items,
			facts: [],
			cursor: serializeCursor(seenIds),
			itemsFetched: items.length,
			warnings,
			error,
			startedAt,
			finishedAt,
			latencyMs: Date.parse(finishedAt) - Date.parse(startedAt),
		};
	}
}

async function fetchList(
	ctx: CollectorContext,
	list: HnList,
	budget: RequestBudget,
	bucket: TokenBucket,
): Promise<number[]> {
	const res = await fetchWithRetry(
		`${BASE_URL}/${list}.json`,
		{},
		{ fetchImpl: ctx.fetch, signal: ctx.signal, budget, bucket, timeoutMs: 10_000 },
	);
	const body = (await res.json()) as unknown;
	if (!Array.isArray(body)) throw new Error(`unexpected ${list} payload shape`);
	return body.filter((v): v is number => typeof v === "number");
}

async function fetchItem(
	ctx: CollectorContext,
	id: number,
	budget: RequestBudget,
	bucket: TokenBucket,
): Promise<HnItem> {
	const res = await fetchWithRetry(
		`${BASE_URL}/item/${id}.json`,
		{},
		{ fetchImpl: ctx.fetch, signal: ctx.signal, budget, bucket, timeoutMs: 10_000 },
	);
	const body = (await res.json()) as unknown;
	if (!body || typeof body !== "object" || typeof (body as HnItem).id !== "number") {
		throw new Error(`malformed item ${id}`);
	}
	return body as HnItem;
}

function titleOf(hnItem: HnItem): string {
	const decoded = hnItem.title === undefined ? "" : decodeHtmlEntities(hnItem.title).trim();
	return decoded === "" ? `HN item ${hnItem.id}` : decoded;
}

function toCollectedItem(hnItem: HnItem, fetchedAt: string): CollectedItem {
	// `text` is HTML: paragraphs, anchors, and every slash and apostrophe
	// entity-encoded. The agent-visible fields get plain text; `raw.body` below
	// still carries the provider's exact bytes.
	const text = hnItem.text === undefined ? undefined : htmlToText(hnItem.text);
	return CollectedItem.parse({
		sourceType: "hackernews",
		sourceName: "hackernews",
		externalId: String(hnItem.id),
		// Only entities are decoded in a title: the API does not send HTML there,
		// and stripping tags from one would silently erase an injection attempt
		// that has no text content -- which the agent should see, not be spared.
		title: titleOf(hnItem),
		summary: text ?? "",
		...(text === undefined ? {} : { body: text }),
		url: hnItem.url ?? `https://news.ycombinator.com/item?id=${hnItem.id}`,
		author: hnItem.by,
		publishedAt: hnItem.time ? new Date(hnItem.time * 1000).toISOString() : fetchedAt,
		metadata: {
			score: hnItem.score ?? 0,
			type: hnItem.type ?? "story",
		},
		raw: {
			externalId: String(hnItem.id),
			body: hnItem,
			fetchedAt,
		},
	});
}
