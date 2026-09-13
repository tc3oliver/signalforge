import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fredCollector } from "../src/collectors/fred.ts";
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
		watchlists: overrides.watchlists ?? {
			github_repos: [],
			sec_companies: [],
			crypto_assets: [],
			fred_series: [
				{ id: "FEDFUNDS", label: "Federal Funds Effective Rate" },
				{ id: "DGS2", label: "2-Year Treasury Constant Maturity Rate" },
				{ id: "DGS10", label: "10-Year Treasury Constant Maturity Rate" },
				{ id: "T10Y2Y", label: "10-Year minus 2-Year Treasury Yield Spread" },
				{ id: "CPIAUCSL", label: "Consumer Price Index for All Urban Consumers" },
				{ id: "UNRATE", label: "Unemployment Rate" },
				{ id: "M2SL", label: "M2 Money Stock" },
				{ id: "WALCL", label: "Federal Reserve Total Assets" },
			],
			subreddits: [],
			youtube_channels: [],
			arxiv_categories: [],
		},
		sourceConfig: overrides.sourceConfig ?? { enabled: true, rateLimitPerMinute: 60, timeoutMs: 10_000, pageSize: 100, requiredSecrets: ["FRED_API_KEY"] },
		config: overrides.config ?? (async () => undefined),
		fetch: overrides.fetch ?? (vi.fn() as unknown as typeof fetch),
		signal: overrides.signal,
		log: overrides.log ?? vi.fn(),
	};
}

async function runCollect(ctx: CollectorContext): Promise<CollectorResult> {
	const promise = fredCollector.collect(ctx);
	await vi.runAllTimersAsync();
	return promise;
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

function obsBody(observations: { date: string; value: string }[]) {
	return { observations };
}

describe("fredCollector", () => {
	it("returns DISABLED, not thrown, when the required API key is missing", async () => {
		const ctx = makeCtx({ secrets: {} });
		const check = await fredCollector.check(ctx);
		expect(check.ok).toBe(false);

		const result = await runCollect(ctx);
		expect(result.health).toBe("DISABLED");
		expect(result.facts).toEqual([]);
		expect(result.error).toBeTruthy();
	});

	it("collects macro facts with asOf set to the real observation date, not fetch time", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes("series_id=FEDFUNDS")) {
				return jsonResponse(obsBody([{ date: "2025-12-01", value: "5.25" }]));
			}
			return jsonResponse(obsBody([]));
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: { FRED_API_KEY: "shh" } });

		const result = await runCollect(ctx);

		// The other tracked series return no observations in this fixture. That is
		// recorded as a note, not a fault: an incremental series with nothing new is
		// a collector that worked, so health stays OK.
		expect(result.health).toBe("OK");
		expect(result.warnings.some((w) => w.includes("no new observations"))).toBe(true);
		const fedFunds = result.facts.find((f) => f.label === "FEDFUNDS");
		expect(fedFunds?.asOf).toBe("2025-12-01");
		expect(fedFunds?.value).toBe(5.25);
		expect(fedFunds?.kind).toBe("macro");
	});

	it("advances the per-series cursor incrementally via observation_start", async () => {
		const requestedStarts: string[] = [];
		const fetchMock = vi.fn(async (url: string) => {
			const u = new URL(url);
			requestedStarts.push(u.searchParams.get("observation_start") ?? "");
			if (u.searchParams.get("series_id") === "FEDFUNDS") {
				return jsonResponse(obsBody([{ date: "2025-12-01", value: "5.25" }]));
			}
			return jsonResponse(obsBody([]));
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: { FRED_API_KEY: "shh" } });

		const result = await runCollect(ctx);
		const cursor = JSON.parse(result.cursor ?? "{}");
		expect(cursor.FEDFUNDS).toBe("2025-12-02"); // day after last observation

		// second run should request from the advanced cursor date
		const ctx2 = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: { FRED_API_KEY: "shh" }, cursor: result.cursor });
		await runCollect(ctx2);
		expect(requestedStarts).toContain("2025-12-02");
	});

	it("retries on 429 with Retry-After via the shared http client", async () => {
		let calls = 0;
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes("series_id=FEDFUNDS")) {
				calls++;
				if (calls === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
				return jsonResponse(obsBody([{ date: "2025-12-01", value: "5.25" }]));
			}
			return jsonResponse(obsBody([]));
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: { FRED_API_KEY: "shh" } });

		const result = await runCollect(ctx);

		expect(result.facts.some((f) => f.label === "FEDFUNDS")).toBe(true);
		expect(calls).toBe(2);
	});

	it("records a warning and keeps going after a request that exhausts retries", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes("series_id=FEDFUNDS")) throw new Error("network down");
			return jsonResponse(obsBody([{ date: "2025-12-05", value: "2.5" }]));
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: { FRED_API_KEY: "shh" } });

		const result = await runCollect(ctx);

		expect(result.warnings.some((w) => w.includes("FEDFUNDS"))).toBe(true);
		expect(result.facts.some((f) => f.label === "DGS2")).toBe(true);
		expect(result.health).toBe("DEGRADED");
	});

	it("counts a malformed observation payload without crashing", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ notObservations: true }));
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: { FRED_API_KEY: "shh" } });

		const result = await runCollect(ctx);

		expect(result.health).toBe("FAILED");
		expect(result.warnings.length).toBeGreaterThan(0);
		expect(result.facts).toEqual([]);
	});

	it("never lets the API key reach the stored raw payload, warnings, or cursor", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(obsBody([{ date: "2025-12-01", value: "5.25" }])));
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: { FRED_API_KEY: "super-secret-fred-key" } });

		const result = await runCollect(ctx);

		expect(JSON.stringify(result)).not.toContain("super-secret-fred-key");
	});

	it("is idempotent: re-running with the same cursor and data yields the same fact externalIds", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(obsBody([{ date: "2025-12-01", value: "5.25" }])));
		const ctx1 = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: { FRED_API_KEY: "shh" } });
		const ctx2 = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: { FRED_API_KEY: "shh" } });

		const r1 = await runCollect(ctx1);
		const r2 = await runCollect(ctx2);

		expect(r1.facts.map((f) => f.externalId).sort()).toEqual(r2.facts.map((f) => f.externalId).sort());
	});
});

describe("fredCollector health", () => {
	it("stays OK when every series is simply up to date", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(obsBody([])));
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: { FRED_API_KEY: "shh" } });

		const result = await runCollect(ctx);

		expect(result.health).toBe("OK");
		expect(result.facts).toEqual([]);
		expect(result.warnings.every((w) => w.includes("no new observations"))).toBe(true);
	});

	it("reports FAILED when a real fault leaves it with nothing", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("network down");
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: { FRED_API_KEY: "shh" } });

		const result = await runCollect(ctx);

		expect(result.health).toBe("FAILED");
	});
});
