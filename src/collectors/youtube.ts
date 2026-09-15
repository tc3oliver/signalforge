import { scrubSecrets } from "../runtime/redact.ts";
import { COLLECTOR_CONCURRENCY, HttpError, TokenBucket, fetchWithRetry, mapWithConcurrency } from "./http.ts";
import type { Collector, CollectorContext, CollectorResult, CollectedItem } from "./types.ts";
import { UNTRUSTED_EXTERNAL_CONTENT } from "./types.ts";

/**
 * Queries used for Data API discovery (key required). Channels come from
 * config/watchlists.yaml (ctx.watchlists.youtube_channels), as either a UC...
 * channel id or an @handle; there is no schema field for discovery queries yet,
 * so this stays a documented default.
 */
const DISCOVERY_QUERIES = ["claude code", "local llm inference"];

/**
 * YouTube Data API takes the key as a query param; never let it reach a log or
 * raw payload. Shared so a new keyed collector inherits redaction by default.
 */
const redactUrl = scrubSecrets;

/** Minimal, dependency-free Atom feed parser for the fields we need. */
function parseAtomFeed(xml: string): { id: string; title: string; link?: string; published?: string; author?: string }[] {
	const entries: { id: string; title: string; link?: string; published?: string; author?: string }[] = [];
	const entryBlocks = xml.match(/<entry[\s\S]*?<\/entry>/g) ?? [];
	for (const block of entryBlocks) {
		const id = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
		const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1];
		const link = block.match(/<link[^>]*href="([^"]+)"/)?.[1];
		const published = block.match(/<published>([^<]+)<\/published>/)?.[1];
		const author = block.match(/<name>([^<]+)<\/name>/)?.[1];
		if (id && title) entries.push({ id, title, link, published, author });
	}
	return entries;
}

export const youtubeCollector: Collector = {
	id: "youtube",
	sourceType: "youtube",
	requiredSecrets: [],

	async check(ctx: CollectorContext) {
		const hasKey = await ctx.hasSecret("YOUTUBE_API_KEY");
		return {
			ok: true,
			detail: hasKey
				? "RSS + Data API discovery enabled"
				: "RSS only (YOUTUBE_API_KEY absent, Data API discovery disabled)",
		};
	},

	async collect(ctx: CollectorContext): Promise<CollectorResult> {
		const startedAt = ctx.now().toISOString();
		const items: CollectedItem[] = [];
		const warnings: string[] = [];
		let itemsFetched = 0;

		const configured = ctx.watchlists?.youtube_channels ?? [];
		const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 2 });
		const get = (url: string) => fetchWithRetry(url, {}, { fetchImpl: ctx.fetch, timeoutMs: 15_000, maxAttempts: 3, signal: ctx.signal, bucket });

		if (configured.length === 0) warnings.push("no YouTube channels configured");

		const hasKey = await ctx.hasSecret("YOUTUBE_API_KEY");
		const apiKey = hasKey ? await ctx.secret("YOUTUBE_API_KEY") : undefined;

		/*
		 * The watchlist is maintained by a human, who knows channels by their
		 * @handle; the feed endpoint only knows opaque UC... ids. Handing it a
		 * handle produces a 404 per channel and an empty collector that still
		 * reports itself as working, so handles are translated first -- and, when
		 * they cannot be (no key), skipped with a reason rather than requested
		 * anyway.
		 */
		const resolved = await mapWithConcurrency(configured, COLLECTOR_CONCURRENCY, async (entry) => {
			const outWarnings: string[] = [];
			if (!entry.startsWith("@")) return { id: entry as string | undefined, outWarnings };
			if (apiKey === undefined) {
				outWarnings.push(`${entry}: a handle cannot be resolved to a channel id without YOUTUBE_API_KEY; skipped`);
				return { id: undefined, outWarnings };
			}
			const url = `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(entry)}&key=${apiKey}`;
			try {
				const res = await get(url);
				const body = (await res.json()) as { items?: { id?: string }[] };
				const id = body.items?.[0]?.id;
				if (id === undefined) {
					outWarnings.push(`${entry}: no channel matched this handle`);
					return { id: undefined, outWarnings };
				}
				return { id, outWarnings };
			} catch (err) {
				outWarnings.push(
					err instanceof HttpError
						? `${entry}: handle lookup returned ${err.status} for ${redactUrl(url)}`
						: `${entry}: handle lookup failed: ${(err as Error).message}`,
				);
				return { id: undefined, outWarnings };
			}
		});
		const channelIds: string[] = [];
		for (const result of resolved) {
			warnings.push(...result.outWarnings);
			if (result.id !== undefined) channelIds.push(result.id);
		}

		// --- RSS per channel: no key required, always attempted ---
		const perChannel = await mapWithConcurrency(channelIds, COLLECTOR_CONCURRENCY, async (channelId) => {
			const outItems: CollectedItem[] = [];
			const outWarnings: string[] = [];
			const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
			try {
				const res = await get(url);
				const xml = await res.text();
				const entries = parseAtomFeed(xml);
				if (entries.length === 0) {
					outWarnings.push(`RSS for ${channelId}: no parsable entries (possibly malformed feed)`);
					return { outItems, outWarnings };
				}
				const fetchedAt = ctx.now().toISOString();
				for (const entry of entries) {
					const externalId = `youtube-${entry.id}`;
					outItems.push({
						sourceType: "youtube",
						sourceName: `YouTube: ${entry.author ?? channelId}`,
						externalId,
						title: entry.title,
						summary: entry.title,
						url: entry.link ?? `https://www.youtube.com/watch?v=${entry.id}`,
						author: entry.author ?? channelId,
						publishedAt: entry.published ?? fetchedAt,
						metadata: { channelId },
						trust: UNTRUSTED_EXTERNAL_CONTENT,
						raw: { externalId, body: entry, fetchedAt },
					});
				}
			} catch (err) {
				outWarnings.push(
					err instanceof HttpError ? `RSS for ${channelId} returned ${err.status}` : `RSS for ${channelId} request failed: ${(err as Error).message}`,
				);
			}
			return { outItems, outWarnings };
		});
		for (const result of perChannel) {
			items.push(...result.outItems);
			itemsFetched += result.outItems.length;
			warnings.push(...result.outWarnings);
		}

		// --- Data API discovery: only when a key is configured; cleanly skipped otherwise ---
		if (apiKey !== undefined) {
			const perQuery = await mapWithConcurrency(DISCOVERY_QUERIES, COLLECTOR_CONCURRENCY, async (query) => {
				const outItems: CollectedItem[] = [];
				const outWarnings: string[] = [];
				const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&q=${encodeURIComponent(
					query,
				)}&key=${apiKey}`;
				try {
					const res = await get(url);
					const body = (await res.json()) as {
						items?: { id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string; publishedAt?: string; description?: string } }[];
					};
					const results = body.items ?? [];
					if (!Array.isArray(results)) {
						outWarnings.push(`Data API search "${query}": malformed payload`);
						return { outItems, outWarnings };
					}
					const fetchedAt = ctx.now().toISOString();
					for (const result of results) {
						const videoId = result.id?.videoId;
						const title = result.snippet?.title;
						if (!videoId || !title) {
							outWarnings.push(`Data API search "${query}": malformed result entry, skipped`);
							continue;
						}
						const externalId = `youtube-${videoId}`;
						outItems.push({
							sourceType: "youtube",
							sourceName: `YouTube search: ${query}`,
							externalId,
							title,
							summary: result.snippet?.description ?? title,
							url: `https://www.youtube.com/watch?v=${videoId}`,
							author: result.snippet?.channelTitle,
							publishedAt: result.snippet?.publishedAt ?? fetchedAt,
							metadata: { query },
							trust: UNTRUSTED_EXTERNAL_CONTENT,
							raw: { externalId, body: result, fetchedAt },
						});
					}
				} catch (err) {
					outWarnings.push(
						err instanceof HttpError
							? `Data API search "${query}" returned ${err.status} for ${redactUrl(url)}`
							: `Data API search "${query}" request failed: ${(err as Error).message}`,
					);
				}
				return { outItems, outWarnings };
			});
			for (const result of perQuery) {
				items.push(...result.outItems);
				itemsFetched += result.outItems.length;
				warnings.push(...result.outWarnings);
			}
		}


		// De-duplicate: a video can surface via both its channel's RSS feed and a discovery query.
		const seen = new Set<string>();
		const deduped: CollectedItem[] = [];
		let duplicates = 0;
		for (const item of items) {
			if (seen.has(item.externalId)) {
				duplicates++;
				continue;
			}
			seen.add(item.externalId);
			deduped.push(item);
		}
		/*
		 * Deliberately not a warning. A video surfacing via both its channel feed
		 * and a discovery query is what this de-duplication is for, not a fault,
		 * and any warning makes the run DEGRADED -- which left youtube permanently
		 * DEGRADED and the health signal worth nothing. The count stays visible as
		 * the gap between itemsFetched and the items actually returned.
		 */

		const health: "OK" | "DEGRADED" | "FAILED" = warnings.length > 0 ? (deduped.length > 0 ? "DEGRADED" : "FAILED") : "OK";
		const finishedAt = ctx.now().toISOString();
		return {
			collectorId: "youtube",
			health,
			items: deduped,
			facts: [],
			itemsFetched,
			warnings,
			startedAt,
			finishedAt,
			latencyMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
		};
	},
};
