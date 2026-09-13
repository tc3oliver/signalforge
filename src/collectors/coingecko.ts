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
import type { Collector, CollectorContext, CollectorResult, CollectedItem, CollectedFact } from "./types.ts";
import { UNTRUSTED_EXTERNAL_CONTENT } from "./types.ts";

/**
 * Assets we track by default. CoinGecko's free/demo tier has no per-project
 * config surface here yet, so this is a fixed watchlist rather than something
 * read from src/config — widen it there once collector config lands.
 */
const ASSETS: { id: string; symbol: string }[] = [
	{ id: "bitcoin", symbol: "BTC" },
	{ id: "ethereum", symbol: "ETH" },
	{ id: "solana", symbol: "SOL" },
];

const API_BASE = "https://api.coingecko.com/api/v3";

/** CoinGecko demo keys are passed as a query param; never let one reach a log or raw payload. */
function redactUrl(url: string): string {
	return url.replace(/([?&]x_cg_demo_api_key=)[^&]+/i, "$1REDACTED");
}

interface SimplePriceEntry {
	usd?: number;
	usd_market_cap?: number;
	usd_24h_vol?: number;
	usd_24h_change?: number;
}

interface GlobalData {
	total_market_cap?: Record<string, number>;
	market_cap_percentage?: Record<string, number>;
}

interface TrendingCoin {
	item?: { id?: string; symbol?: string; name?: string; market_cap_rank?: number };
}

export const coingeckoCollector: Collector = {
	id: "coingecko",
	sourceType: "coingecko",
	requiredSecrets: [],

	async check(ctx: CollectorContext) {
		const hasKey = await ctx.hasSecret("COINGECKO_API_KEY");
		return { ok: true, detail: hasKey ? "demo API key present" : "using public tier (no API key)" };
	},

	async collect(ctx: CollectorContext): Promise<CollectorResult> {
		const startedAt = ctx.now().toISOString();
		const items: CollectedItem[] = [];
		const facts: CollectedFact[] = [];
		const warnings: string[] = [];
		let health: "OK" | "DEGRADED" | "DISABLED" | "FAILED" = "OK";
		let itemsFetched = 0;

		const hasKey = await ctx.hasSecret("COINGECKO_API_KEY");
		// Public tier is heavily throttled (~5-15 calls/min); a demo key raises that
		// somewhat but is still far from the paid pro tier, so we stay conservative.
		const perSecond = hasKey ? 0.5 : 0.2;
		const client = createHttpClient(ctx.fetch, {
			timeoutMs: 15_000,
			retries: 3,
			rateLimit: { perSecond },
			signal: ctx.signal,
		});

		const keyParam = hasKey ? `&x_cg_demo_api_key=${await ctx.secret("COINGECKO_API_KEY")}` : "";

		try {
			const fetchedAt = ctx.now().toISOString();

			// --- per-asset price/volume/market cap facts ---
			const ids = ASSETS.map((a) => a.id).join(",");
			const priceUrl = `${API_BASE}/simple/price?ids=${ids}&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true${keyParam}`;
			let priceJson: Record<string, SimplePriceEntry> | undefined;
			try {
				const res = await client.get(priceUrl);
				if (!res.ok) {
					warnings.push(`simple/price returned ${res.status} for ${redactUrl(priceUrl)}`);
				} else {
					priceJson = (await res.json()) as Record<string, SimplePriceEntry>;
				}
			} catch (err) {
				warnings.push(`simple/price request failed: ${(err as Error).message}`);
			}

			if (priceJson) {
				for (const asset of ASSETS) {
					const entry = priceJson[asset.id];
					if (!entry || typeof entry.usd !== "number") {
						warnings.push(`malformed or missing price entry for ${asset.id}`);
						continue;
					}
					itemsFetched++;
					facts.push({
						kind: "crypto",
						label: `${asset.symbol} price`,
						value: entry.usd,
						unit: "usd",
						asOf: fetchedAt,
						externalId: `coingecko-price-${asset.id}-${fetchedAt}`,
						metadata: { asset: asset.symbol },
					});
					if (typeof entry.usd_market_cap === "number") {
						facts.push({
							kind: "crypto",
							label: `${asset.symbol} market cap`,
							value: entry.usd_market_cap,
							unit: "usd",
							asOf: fetchedAt,
							externalId: `coingecko-mcap-${asset.id}-${fetchedAt}`,
							metadata: { asset: asset.symbol },
						});
					}
					if (typeof entry.usd_24h_vol === "number") {
						facts.push({
							kind: "crypto",
							label: `${asset.symbol} 24h volume`,
							value: entry.usd_24h_vol,
							unit: "usd",
							asOf: fetchedAt,
							externalId: `coingecko-vol-${asset.id}-${fetchedAt}`,
							metadata: { asset: asset.symbol },
						});
					}
				}
			}

			// --- global market data (total mcap, BTC dominance) ---
			const globalUrl = `${API_BASE}/global${keyParam ? `?${keyParam.slice(1)}` : ""}`;
			try {
				const res = await client.get(globalUrl);
				if (!res.ok) {
					warnings.push(`global endpoint returned ${res.status} for ${redactUrl(globalUrl)}`);
				} else {
					const body = (await res.json()) as { data?: GlobalData };
					const data = body.data;
					const totalMcapUsd = data?.total_market_cap?.usd;
					const btcDominance = data?.market_cap_percentage?.btc;
					if (typeof totalMcapUsd === "number") {
						itemsFetched++;
						facts.push({
							kind: "crypto",
							label: "Total crypto market cap",
							value: totalMcapUsd,
							unit: "usd",
							asOf: fetchedAt,
							externalId: `coingecko-global-mcap-${fetchedAt}`,
							metadata: {},
						});
					}
					if (typeof btcDominance === "number") {
						itemsFetched++;
						facts.push({
							kind: "crypto",
							label: "BTC dominance",
							value: btcDominance,
							unit: "percent",
							asOf: fetchedAt,
							externalId: `coingecko-btc-dominance-${fetchedAt}`,
							metadata: {},
						});
					}
					if (!data) warnings.push("malformed global payload: missing data field");
				}
			} catch (err) {
				warnings.push(`global request failed: ${(err as Error).message}`);
			}

			// --- trending: a genuine "event", so this becomes an item, not just a fact ---
			const trendingUrl = `${API_BASE}/search/trending${keyParam ? `?${keyParam.slice(1)}` : ""}`;
			try {
				const res = await client.get(trendingUrl);
				if (!res.ok) {
					warnings.push(`trending endpoint returned ${res.status} for ${redactUrl(trendingUrl)}`);
				} else {
					const body = (await res.json()) as { coins?: TrendingCoin[] };
					const coins = (body.coins ?? [])
						.map((c) => c.item)
						.filter((c): c is NonNullable<TrendingCoin["item"]> => !!c?.id && !!c.symbol);
					if (coins.length > 0) {
						itemsFetched++;
						const externalId = `coingecko-trending-${fetchedAt}`;
						const names = coins.map((c) => c.symbol?.toUpperCase()).join(", ");
						items.push({
							sourceType: "coingecko",
							sourceName: "CoinGecko Trending",
							externalId,
							title: `Trending on CoinGecko: ${names}`,
							summary: `Coins currently trending by search volume: ${names}`,
							url: "https://www.coingecko.com/en/coins/trending",
							publishedAt: fetchedAt,
							metadata: { coins: coins.map((c) => ({ id: c.id, symbol: c.symbol, rank: c.market_cap_rank })) },
							trust: UNTRUSTED_EXTERNAL_CONTENT,
							raw: { externalId, body, fetchedAt },
						});
					} else {
						warnings.push("malformed trending payload: no coins array");
					}
				}
			} catch (err) {
				warnings.push(`trending request failed: ${(err as Error).message}`);
			}
		} catch (err) {
			const finishedAt = ctx.now().toISOString();
			return {
				collectorId: "coingecko",
				health: "FAILED",
				items,
				facts,
				itemsFetched,
				warnings,
				error: (err as Error).message,
				startedAt,
				finishedAt,
				latencyMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
			};
		}

		if (warnings.length > 0 && facts.length === 0 && items.length === 0) health = "DEGRADED";
		else if (warnings.length > 0) health = "DEGRADED";

		const finishedAt = ctx.now().toISOString();
		return {
			collectorId: "coingecko",
			health,
			items,
			facts,
			itemsFetched,
			warnings,
			startedAt,
			finishedAt,
			latencyMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
		};
	},
};
