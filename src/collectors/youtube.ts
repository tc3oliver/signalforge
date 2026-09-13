import { HttpError, TokenBucket, fetchWithRetry } from "./http.ts";
import type { Collector, CollectorContext, CollectorResult, CollectedItem } from "./types.ts";
import { UNTRUSTED_EXTERNAL_CONTENT } from "./types.ts";

/**
 * Queries used for Data API discovery (key required). Channels come from
 * config/watchlists.yaml (ctx.watchlists.youtube_channels) as channel ids; there
 * is no schema field for discovery queries yet, so this stays a documented default.
 */
const DISCOVERY_QUERIES = ["claude code", "local llm inference"];

/** YouTube Data API takes the key as a query param; never let it reach a log or raw payload. */
function redactUrl(url: string): string {
	return url.replace(/([?&]key=)[^&]+/i, "$1REDACTED");
}

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

		const channelIds = ctx.watchlists.youtube_channels;
		const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 2 });
		const get = (url: string) => fetchWithRetry(url, {}, { fetchImpl: ctx.fetch, timeoutMs: 15_000, maxAttempts: 3, signal: ctx.signal, bucket });

		if (channelIds.length === 0) warnings.push("no YouTube channels configured");

		// --- RSS per channel: no key required, always attempted ---
		for (const channelId of channelIds) {
			const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
			try {
				const res = await get(url);
				const xml = await res.text();
				const entries = parseAtomFeed(xml);
				if (entries.length === 0) {
					warnings.push(`RSS for ${channelId}: no parsable entries (possibly malformed feed)`);
					continue;
				}
				const fetchedAt = ctx.now().toISOString();
				for (const entry of entries) {
					itemsFetched++;
					const externalId = `youtube-${entry.id}`;
					items.push({
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
				warnings.push(
					err instanceof HttpError ? `RSS for ${channelId} returned ${err.status}` : `RSS for ${channelId} request failed: ${(err as Error).message}`,
				);
			}
		}

		// --- Data API discovery: only when a key is configured; cleanly skipped otherwise ---
		const hasKey = await ctx.hasSecret("YOUTUBE_API_KEY");
		if (hasKey) {
			const apiKey = await ctx.secret("YOUTUBE_API_KEY");
			for (const query of DISCOVERY_QUERIES) {
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
						warnings.push(`Data API search "${query}": malformed payload`);
						continue;
					}
					const fetchedAt = ctx.now().toISOString();
					for (const result of results) {
						const videoId = result.id?.videoId;
						const title = result.snippet?.title;
						if (!videoId || !title) {
							warnings.push(`Data API search "${query}": malformed result entry, skipped`);
							continue;
						}
						itemsFetched++;
						const externalId = `youtube-${videoId}`;
						items.push({
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
					warnings.push(
						err instanceof HttpError
							? `Data API search "${query}" returned ${err.status} for ${redactUrl(url)}`
							: `Data API search "${query}" request failed: ${(err as Error).message}`,
					);
				}
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
		if (duplicates > 0) warnings.push(`dropped ${duplicates} exact duplicate video(s) seen via multiple sources`);

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
