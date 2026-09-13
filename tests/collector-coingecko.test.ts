import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coingeckoCollector } from "../src/collectors/coingecko.ts";
import type { CollectorContext, CollectorResult } from "../src/collectors/types.ts";

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
	return new Response(JSON.stringify(body), {
		status: init?.status ?? 200,
		headers: { "content-type": "application/json", ...init?.headers },
	});
}

function makeCtx(overrides: Partial<CollectorContext> & { secrets?: Record<string, string> } = {}): CollectorContext {
	const secrets = overrides.secrets ?? {};
	return {
		since: overrides.since ?? new Date("2026-01-01T00:00:00.000Z"),
		now: overrides.now ?? (() => new Date("2026-01-02T00:00:00.000Z")),
		cursor: overrides.cursor,
		secret: overrides.secret ?? (async (name: string) => {
			const v = secrets[name];
			if (v === undefined) throw new Error(`missing secret ${name}`);
			return v;
		}),
		hasSecret: overrides.hasSecret ?? (async (name: string) => secrets[name] !== undefined),
		fetch: overrides.fetch ?? (vi.fn() as unknown as typeof fetch),
		signal: overrides.signal,
		log: overrides.log ?? vi.fn(),
	};
}

/** Runs collect() under fake timers so rate-limit/backoff sleeps resolve instantly. */
async function runCollect(ctx: CollectorContext): Promise<CollectorResult> {
	const promise = coingeckoCollector.collect(ctx);
	await vi.runAllTimersAsync();
	return promise;
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const priceBody = {
	bitcoin: { usd: 65000, usd_market_cap: 1.2e12, usd_24h_vol: 3e10, usd_24h_change: 1.2 },
	ethereum: { usd: 3400, usd_market_cap: 4e11, usd_24h_vol: 1.5e10, usd_24h_change: -0.5 },
	solana: { usd: 150, usd_market_cap: 6e10, usd_24h_vol: 2e9, usd_24h_change: 3.1 },
};
const globalBody = { data: { total_market_cap: { usd: 2.5e12 }, market_cap_percentage: { btc: 51.2 } } };
const trendingBody = { coins: [{ item: { id: "pepe", symbol: "pepe", name: "Pepe", market_cap_rank: 42 } }] };

describe("coingeckoCollector", () => {
	it("collects prices, global data, and trending as facts + one event item", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes("/simple/price")) return jsonResponse(priceBody);
			if (url.includes("/global")) return jsonResponse(globalBody);
			if (url.includes("/search/trending")) return jsonResponse(trendingBody);
			return new Response("not found", { status: 404 });
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch });

		const result = await runCollect(ctx);

		expect(result.health).toBe("OK");
		expect(result.warnings).toEqual([]);
		// 3 assets * 3 facts (price/mcap/vol) + 2 global facts = 11
		expect(result.facts.length).toBe(11);
		expect(result.facts.every((f) => f.kind === "crypto")).toBe(true);
		expect(result.items.length).toBe(1);
		expect(result.items[0]?.title).toContain("PEPE");
	});

	it("degrades to public tier when COINGECKO_API_KEY is absent (optional secret)", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			expect(url).not.toContain("x_cg_demo_api_key");
			if (url.includes("/simple/price")) return jsonResponse(priceBody);
			if (url.includes("/global")) return jsonResponse(globalBody);
			return jsonResponse(trendingBody);
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: {} });
		const check = await coingeckoCollector.check(ctx);
		expect(check.ok).toBe(true);
		expect(check.detail).toMatch(/public tier/);

		const result = await runCollect(ctx);
		expect(result.health).toBe("OK");
	});

	it("uses the demo key when present and never leaks it into raw payload or warnings", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes("/simple/price")) return jsonResponse(priceBody);
			if (url.includes("/global")) return jsonResponse(globalBody);
			return jsonResponse(trendingBody);
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: { COINGECKO_API_KEY: "top-secret-demo-key" } });

		const result = await runCollect(ctx);

		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("top-secret-demo-key");
	});

	it("handles a 429 with Retry-After by retrying via the shared http client", async () => {
		let calls = 0;
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes("/simple/price")) {
				calls++;
				if (calls === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
				return jsonResponse(priceBody);
			}
			if (url.includes("/global")) return jsonResponse(globalBody);
			return jsonResponse(trendingBody);
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch });

		const result = await runCollect(ctx);

		expect(result.health).toBe("OK");
		expect(result.facts.length).toBeGreaterThan(0);
		expect(calls).toBe(2);
	});

	it("treats a persistent transport failure as a warning, not a crash", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes("/simple/price")) throw new DOMException("The operation timed out", "TimeoutError");
			if (url.includes("/global")) return jsonResponse(globalBody);
			return jsonResponse(trendingBody);
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch });

		const result = await runCollect(ctx);

		expect(result.health).toBe("DEGRADED");
		expect(result.warnings.some((w) => w.includes("simple/price"))).toBe(true);
		expect(result.facts.length).toBeGreaterThan(0); // global/trending still collected
	});

	it("counts a malformed price entry without crashing", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes("/simple/price")) return jsonResponse({ bitcoin: { usd: "not-a-number" }, ethereum: priceBody.ethereum, solana: priceBody.solana });
			if (url.includes("/global")) return jsonResponse(globalBody);
			return jsonResponse(trendingBody);
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch });

		const result = await runCollect(ctx);

		expect(result.warnings.some((w) => w.includes("bitcoin"))).toBe(true);
		expect(result.facts.some((f) => f.metadata.asset === "ETH")).toBe(true);
	});

	it("is idempotent: identical input yields identical externalIds across two runs", async () => {
		const fixedNow = () => new Date("2026-01-02T00:00:00.000Z");
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes("/simple/price")) return jsonResponse(priceBody);
			if (url.includes("/global")) return jsonResponse(globalBody);
			return jsonResponse(trendingBody);
		});
		const ctx1 = makeCtx({ fetch: fetchMock as unknown as typeof fetch, now: fixedNow });
		const ctx2 = makeCtx({ fetch: fetchMock as unknown as typeof fetch, now: fixedNow });

		const r1 = await runCollect(ctx1);
		const r2 = await runCollect(ctx2);

		expect(r1.facts.map((f) => f.externalId).sort()).toEqual(r2.facts.map((f) => f.externalId).sort());
	});
});
