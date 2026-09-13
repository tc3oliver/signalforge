import type { Collector, CollectorContext, CollectorResult } from "./types.ts";
import { CollectedItem } from "./types.ts";
import { HttpError, RequestBudget, TokenBucket, fetchWithRetry } from "./http.ts";

const API_BASE = "https://api.semanticscholar.org/graph/v1";
const FIELDS = "title,abstract,url,venue,year,publicationDate,authors,citationCount,externalIds";
const BATCH_SIZE = 100;

/**
 * Enrichment collector: given a set of arXiv ids (from the cursor, seeded by
 * the arxiv collector's output via config, or passed explicitly), fetches
 * citation counts, authors, venue, and related-paper metadata.
 */
export interface SemanticScholarPaper {
	paperId: string;
	title: string;
	abstract: string | null;
	url: string | null;
	venue: string | null;
	year: number | null;
	publicationDate: string | null;
	authors: { name: string }[];
	citationCount: number | null;
	externalIds?: { ArXiv?: string };
}

interface SsCursor {
	/** arXiv ids already enriched this run/last run, to avoid redundant refetches within a short window. */
	seenArxivIds: string[];
}

const MAX_SEEN = 5000;

function parseCursor(raw: string | undefined): SsCursor {
	if (!raw) return { seenArxivIds: [] };
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && Array.isArray((parsed as SsCursor).seenArxivIds)) {
			return parsed as SsCursor;
		}
	} catch {
		// Malformed cursor: start clean rather than fail.
	}
	return { seenArxivIds: [] };
}

export class SemanticScholarCollector implements Collector {
	readonly id = "semantic-scholar";
	readonly sourceType = "semantic-scholar" as const;
	readonly requiredSecrets: readonly string[] = [];
	#arxivIds: string[];

	/**
	 * `arxivIds` is the enrichment worklist for this run — in production this
	 * is populated from recently collected arXiv items; tests and callers may
	 * pass it explicitly since this collector has no independent discovery feed.
	 */
	constructor(opts?: { arxivIds?: string[] }) {
		this.#arxivIds = opts?.arxivIds ?? [];
	}

	async check(ctx: CollectorContext): Promise<{ ok: boolean; detail: string }> {
		const hasKey = await ctx.hasSecret("SEMANTIC_SCHOLAR_API_KEY");
		return {
			ok: true,
			detail: hasKey ? "SEMANTIC_SCHOLAR_API_KEY present" : "no API key; public tier rate limits apply",
		};
	}

	async collect(ctx: CollectorContext): Promise<CollectorResult> {
		const startedAt = ctx.now().toISOString();
		const warnings: string[] = [];
		const items: CollectedItem[] = [];
		const budget = new RequestBudget(200);
		const cursor = parseCursor(ctx.cursor);
		const seen = new Set(cursor.seenArxivIds);

		const apiKey = (await ctx.hasSecret("SEMANTIC_SCHOLAR_API_KEY")) ? await ctx.secret("SEMANTIC_SCHOLAR_API_KEY") : undefined;
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (apiKey) headers["x-api-key"] = apiKey;
		// Keyless tier is throttled hard; back off harder by capping burst to 1.
		const bucket = new TokenBucket({ capacity: apiKey ? 5 : 1, refillPerSecond: apiKey ? 2 : 0.2 });

		let health: CollectorResult["health"] = "OK";
		let error: string | undefined;

		const toFetch = this.#arxivIds.filter((id) => !seen.has(id));
		if (toFetch.length === 0) {
			warnings.push("no arXiv ids provided for enrichment");
		}

		try {
			for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
				const batch = toFetch.slice(i, i + BATCH_SIZE);
				const ids = batch.map((id) => `ArXiv:${id}`);
				let res: Response;
				try {
					res = await fetchWithRetry(
						`${API_BASE}/paper/batch?fields=${FIELDS}`,
						{ method: "POST", headers, body: JSON.stringify({ ids }) },
						{ fetchImpl: ctx.fetch, signal: ctx.signal, budget, bucket, timeoutMs: 15_000, maxAttempts: 5, baseDelayMs: 1000 },
					);
				} catch (err) {
					if (err instanceof HttpError && err.status === 429) {
						health = "DEGRADED";
						warnings.push(`batch starting at ${i} rate-limited and exhausted retries`);
						continue;
					}
					throw err;
				}
				const body = (await res.json()) as unknown;
				if (!Array.isArray(body)) {
					warnings.push(`batch starting at ${i}: unexpected payload shape (dropped)`);
					continue;
				}
				for (let j = 0; j < body.length; j++) {
					const paper = body[j] as SemanticScholarPaper | null;
					const arxivId = batch[j];
					if (arxivId) seen.add(arxivId);
					if (!paper || !paper.paperId) {
						// null entries mean "not found" on Semantic Scholar's side — not an error, just uncovered.
						warnings.push(`no Semantic Scholar record for arXiv:${arxivId}`);
						continue;
					}
					items.push(toCollectedItem(paper, arxivId, startedAt));
				}
			}
		} catch (err) {
			health = "FAILED";
			error = (err as Error).message;
		}

		if (!apiKey && health === "OK" && toFetch.length > 0) {
			health = "DEGRADED";
			warnings.push("running without SEMANTIC_SCHOLAR_API_KEY: low public-tier rate limits apply");
		}

		const seenTrimmed = Array.from(seen).slice(-MAX_SEEN);
		const finishedAt = ctx.now().toISOString();
		return {
			collectorId: this.id,
			health,
			items,
			facts: [],
			cursor: JSON.stringify({ seenArxivIds: seenTrimmed } satisfies SsCursor),
			itemsFetched: items.length,
			warnings,
			error,
			startedAt,
			finishedAt,
			latencyMs: Date.parse(finishedAt) - Date.parse(startedAt),
		};
	}
}

function toCollectedItem(paper: SemanticScholarPaper, arxivId: string | undefined, fetchedAt: string): CollectedItem {
	return CollectedItem.parse({
		sourceType: "semantic-scholar",
		sourceName: "semantic-scholar",
		externalId: paper.paperId,
		title: paper.title,
		summary: paper.abstract ?? "",
		url: paper.url ?? undefined,
		author: paper.authors[0]?.name,
		publishedAt: paper.publicationDate ?? (paper.year ? `${paper.year}-01-01` : fetchedAt),
		metadata: {
			citationCount: paper.citationCount ?? 0,
			venue: paper.venue ?? "",
			authors: paper.authors.map((a) => a.name),
			arxivId: arxivId ?? paper.externalIds?.ArXiv ?? "",
		},
		raw: { externalId: paper.paperId, body: paper, fetchedAt },
	});
}
