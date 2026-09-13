import { fetchWithRetry, TokenBucket } from "./http.ts";

/**
 * Thin per-collector adapter over the shared fetchWithRetry/TokenBucket
 * primitives in ./http.ts (owned by another agent) — gives call sites a
 * small get(url) surface instead of threading bucket/signal through each one.
 */
function createHttpClient(
	fetchImpl: typeof fetch,
	opts: { timeoutMs?: number; retries?: number; rateLimit?: { perSecond: number }; headers?: Record<string, string>; signal?: AbortSignal },
) {
	const bucket = opts.rateLimit
		? new TokenBucket({ capacity: Math.max(1, Math.ceil(opts.rateLimit.perSecond)), refillPerSecond: opts.rateLimit.perSecond })
		: undefined;
	return {
		async get(url: string, extra?: { headers?: Record<string, string> }): Promise<Response> {
			return fetchWithRetry(
				url,
				{ method: "GET", headers: { ...opts.headers, ...extra?.headers } },
				{ fetchImpl, timeoutMs: opts.timeoutMs, maxAttempts: opts.retries, signal: opts.signal, bucket },
			);
		},
	};
}
import type { Collector, CollectorContext, CollectorResult, CollectedItem } from "./types.ts";
import { UNTRUSTED_EXTERNAL_CONTENT } from "./types.ts";

const PAGE_LIMIT = 100;

interface MinifluxEntry {
	id: number;
	title?: string;
	url?: string;
	author?: string;
	content?: string;
	published_at?: string;
	feed?: { title?: string };
}

interface MinifluxEntriesResponse {
	total?: number;
	entries?: MinifluxEntry[];
}

/** Cursor is the highest entry id we've fully consumed. */
function parseCursor(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

export const minifluxCollector: Collector = {
	id: "miniflux",
	sourceType: "rss",
	requiredSecrets: ["MINIFLUX_URL", "MINIFLUX_API_KEY"],

	async check(ctx: CollectorContext) {
		const hasUrl = await ctx.hasSecret("MINIFLUX_URL");
		const hasKey = await ctx.hasSecret("MINIFLUX_API_KEY");
		if (!hasUrl || !hasKey) {
			return { ok: false, detail: "MINIFLUX_URL and MINIFLUX_API_KEY are both required and not fully configured" };
		}
		return { ok: true, detail: "MINIFLUX_URL and MINIFLUX_API_KEY present" };
	},

	async collect(ctx: CollectorContext): Promise<CollectorResult> {
		const startedAt = ctx.now().toISOString();
		const items: CollectedItem[] = [];
		const warnings: string[] = [];
		let itemsFetched = 0;

		const hasUrl = await ctx.hasSecret("MINIFLUX_URL");
		const hasKey = await ctx.hasSecret("MINIFLUX_API_KEY");
		if (!hasUrl || !hasKey) {
			const finishedAt = ctx.now().toISOString();
			return {
				collectorId: "miniflux",
				health: "DISABLED",
				items: [],
				facts: [],
				itemsFetched: 0,
				warnings: [],
				error: "MINIFLUX_URL and MINIFLUX_API_KEY are both required and not fully configured",
				startedAt,
				finishedAt,
				latencyMs: 0,
			};
		}

		const baseUrl = (await ctx.secret("MINIFLUX_URL")).replace(/\/$/, "");
		const apiKey = await ctx.secret("MINIFLUX_API_KEY");
		const client = createHttpClient(ctx.fetch, {
			timeoutMs: 15_000,
			retries: 3,
			rateLimit: { perSecond: 5 },
			headers: { "X-Auth-Token": apiKey },
			signal: ctx.signal,
		});

		const startAfterId = parseCursor(ctx.cursor);
		let maxSeenId = startAfterId ?? 0;
		let health: "OK" | "DEGRADED" | "FAILED" = "OK";
		let offset = 0;
		let total = Infinity;

		while (offset < total) {
			const params = new URLSearchParams({
				order: "id",
				direction: "asc",
				limit: String(PAGE_LIMIT),
				offset: String(offset),
			});
			if (startAfterId !== undefined) params.set("after_entry_id", String(startAfterId));
			params.set("changed_after", Math.floor(ctx.since.getTime() / 1000).toString());

			const url = `${baseUrl}/v1/entries?${params.toString()}`;
			try {
				const res = await client.get(url);
				if (!res.ok) {
					warnings.push(`entries request returned ${res.status} at offset ${offset}`);
					break;
				}
				const body = (await res.json()) as MinifluxEntriesResponse;
				if (typeof body.total !== "number" || !Array.isArray(body.entries)) {
					warnings.push(`malformed entries payload at offset ${offset}`);
					break;
				}
				total = body.total;
				const fetchedAt = ctx.now().toISOString();

				for (const entry of body.entries) {
					if (typeof entry.id !== "number" || !entry.title) {
						warnings.push(`malformed entry at offset ${offset}, skipped`);
						continue;
					}
					itemsFetched++;
					const externalId = `miniflux-${entry.id}`;
					items.push({
						sourceType: "rss",
						sourceName: entry.feed?.title ? `Miniflux: ${entry.feed.title}` : "Miniflux",
						externalId,
						title: entry.title,
						summary: entry.content ? entry.content.replace(/<[^>]+>/g, "").slice(0, 500) : entry.title,
						body: entry.content,
						url: entry.url,
						author: entry.author,
						publishedAt: entry.published_at ?? fetchedAt,
						metadata: { minifluxEntryId: entry.id, feedTitle: entry.feed?.title },
						trust: UNTRUSTED_EXTERNAL_CONTENT,
						raw: { externalId, body: entry, fetchedAt },
					});
					if (entry.id > maxSeenId) maxSeenId = entry.id;
				}

				if (body.entries.length === 0) break;
				offset += PAGE_LIMIT;
			} catch (err) {
				warnings.push(`entries request failed at offset ${offset}: ${(err as Error).message}`);
				break;
			}
		}

		if (warnings.length > 0) health = items.length > 0 ? "DEGRADED" : "FAILED";

		const finishedAt = ctx.now().toISOString();
		return {
			collectorId: "miniflux",
			health,
			items,
			facts: [],
			// Only advance the cursor past what we actually consumed; a broken page midway
			// through leaves it at the last fully-processed id so nothing gets skipped.
			cursor: String(maxSeenId),
			itemsFetched,
			warnings,
			startedAt,
			finishedAt,
			latencyMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
		};
	},
};
