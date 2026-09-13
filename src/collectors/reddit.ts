import { HttpError, TokenBucket, fetchWithRetry } from "./http.ts";
import type { Collector, CollectorContext, CollectorResult, CollectedItem } from "./types.ts";
import { UNTRUSTED_EXTERNAL_CONTENT } from "./types.ts";

/**
 * Keyword searches tracked by default. Subreddits come from config/watchlists.yaml
 * (ctx.watchlists.subreddits); there is no schema field for keyword searches yet,
 * so this stays a documented default.
 */
const SEARCH_QUERIES = ["claude code", "mcp server"];

const DEFAULT_USER_AGENT = "daily-intelligence/0.1 (personal reading digest; contact via repo owner)";

interface RedditPost {
	data?: {
		id?: string;
		title?: string;
		selftext?: string;
		author?: string;
		permalink?: string;
		url?: string;
		created_utc?: number;
		score?: number;
		num_comments?: number;
		subreddit?: string;
	};
}

interface RedditListing {
	data?: { children?: RedditPost[] };
}

async function fetchOAuthToken(
	fetchImpl: typeof fetch,
	clientId: string,
	clientSecret: string,
	userAgent: string,
): Promise<string | undefined> {
	const res = await fetchImpl("https://www.reddit.com/api/v1/access_token", {
		method: "POST",
		headers: {
			Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": userAgent,
		},
		body: "grant_type=client_credentials",
	});
	if (!res.ok) return undefined;
	const body = (await res.json()) as { access_token?: string };
	return body.access_token;
}

function toItem(post: RedditPost, sourceLabel: string): CollectedItem | undefined {
	const d = post.data;
	if (!d?.id || !d.title || typeof d.created_utc !== "number") return undefined;
	const externalId = `reddit-${d.id}`;
	const fetchedAt = new Date().toISOString();
	return {
		sourceType: "reddit",
		sourceName: sourceLabel,
		externalId,
		title: d.title,
		summary: d.selftext ? d.selftext.slice(0, 500) : d.title,
		url: d.permalink ? `https://www.reddit.com${d.permalink}` : d.url,
		author: d.author,
		publishedAt: new Date(d.created_utc * 1000).toISOString(),
		metadata: { score: d.score ?? 0, numComments: d.num_comments ?? 0, subreddit: d.subreddit },
		trust: UNTRUSTED_EXTERNAL_CONTENT,
		raw: { externalId, body: post, fetchedAt },
	};
}

export const redditCollector: Collector = {
	id: "reddit",
	sourceType: "reddit",
	requiredSecrets: [],

	async check(ctx: CollectorContext) {
		const hasClientId = await ctx.hasSecret("REDDIT_CLIENT_ID");
		const hasSecret = await ctx.hasSecret("REDDIT_CLIENT_SECRET");
		if (hasClientId !== hasSecret) {
			return { ok: true, detail: "only one of REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET is set; falling back to public .json endpoints" };
		}
		return { ok: true, detail: hasClientId ? "OAuth credentials present" : "using public .json endpoints (no OAuth)" };
	},

	async collect(ctx: CollectorContext): Promise<CollectorResult> {
		const startedAt = ctx.now().toISOString();
		const items: CollectedItem[] = [];
		const warnings: string[] = [];
		let itemsFetched = 0;

		const subreddits = ctx.watchlists.subreddits;
		const hasClientId = await ctx.hasSecret("REDDIT_CLIENT_ID");
		const hasClientSecret = await ctx.hasSecret("REDDIT_CLIENT_SECRET");
		const useOAuth = hasClientId && hasClientSecret;

		const bucket = new TokenBucket({ capacity: 1, refillPerSecond: useOAuth ? 1 : 0.5 });
		const get = (url: string, headers: Record<string, string>) =>
			fetchWithRetry(url, { headers }, { fetchImpl: ctx.fetch, timeoutMs: 15_000, maxAttempts: 3, signal: ctx.signal, bucket });

		let token: string | undefined;
		let health: "OK" | "DEGRADED" | "FAILED" = "OK";

		if (useOAuth) {
			try {
				token = await fetchOAuthToken(
					ctx.fetch,
					await ctx.secret("REDDIT_CLIENT_ID"),
					await ctx.secret("REDDIT_CLIENT_SECRET"),
					DEFAULT_USER_AGENT,
				);
				if (!token) warnings.push("OAuth token request failed; degrading to public .json endpoints");
			} catch (err) {
				warnings.push(`OAuth token request failed: ${(err as Error).message}; degrading to public .json endpoints`);
			}
		}

		const base = token ? "https://oauth.reddit.com" : "https://www.reddit.com";
		const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

		if (subreddits.length === 0) warnings.push("no subreddits configured");

		for (const subreddit of subreddits) {
			const url = `${base}/r/${subreddit}/new.json?limit=25`;
			try {
				const res = await get(url, { ...authHeaders, "User-Agent": DEFAULT_USER_AGENT });
				const body = (await res.json()) as RedditListing;
				const children = body.data?.children;
				if (!Array.isArray(children)) {
					warnings.push(`r/${subreddit}: malformed listing payload`);
					continue;
				}
				for (const post of children) {
					const item = toItem(post, `r/${subreddit}`);
					if (!item) {
						warnings.push(`r/${subreddit}: malformed post entry, skipped`);
						continue;
					}
					itemsFetched++;
					items.push(item);
				}
			} catch (err) {
				warnings.push(
					err instanceof HttpError ? `r/${subreddit} returned ${err.status}` : `r/${subreddit} request failed: ${(err as Error).message}`,
				);
			}
		}

		for (const query of SEARCH_QUERIES) {
			const url = `${base}/search.json?q=${encodeURIComponent(query)}&sort=new&limit=25`;
			try {
				const res = await get(url, { ...authHeaders, "User-Agent": DEFAULT_USER_AGENT });
				const body = (await res.json()) as RedditListing;
				const children = body.data?.children;
				if (!Array.isArray(children)) {
					warnings.push(`search "${query}": malformed listing payload`);
					continue;
				}
				for (const post of children) {
					const item = toItem(post, `Reddit search: ${query}`);
					if (!item) {
						warnings.push(`search "${query}": malformed post entry, skipped`);
						continue;
					}
					itemsFetched++;
					items.push(item);
				}
			} catch (err) {
				warnings.push(
					err instanceof HttpError ? `search "${query}" returned ${err.status}` : `search "${query}" request failed: ${(err as Error).message}`,
				);
			}
		}

		// De-duplicate exact repeats (same post can surface via both a subreddit
		// listing and a keyword search) — this is the one permitted drop reason.
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
		if (duplicates > 0) warnings.push(`dropped ${duplicates} exact duplicate post(s) seen via multiple listings`);

		if (!useOAuth && (hasClientId || hasClientSecret)) {
			warnings.push("only one of REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET configured; both are required for OAuth");
		}
		if (warnings.length > 0) health = deduped.length > 0 ? "DEGRADED" : "FAILED";

		const finishedAt = ctx.now().toISOString();
		return {
			collectorId: "reddit",
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
