import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { secCollector } from "../src/collectors/sec.ts";
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
			sec_companies: [
				{ ticker: "AAPL", name: "Apple Inc.", cik: "0000320193" },
				{ ticker: "MSFT", name: "Microsoft Corp.", cik: "0000789019" },
				{ ticker: "GOOGL", name: "Alphabet Inc.", cik: "0001652044" },
			],
			crypto_assets: [],
			fred_series: [],
			subreddits: [],
			youtube_channels: [],
			arxiv_categories: [],
		},
		sourceConfig: overrides.sourceConfig ?? { enabled: true, rateLimitPerMinute: 10, timeoutMs: 15_000, pageSize: 40, requiredSecrets: [] },
		config: overrides.config ?? (async (name: string) => (name === "SEC_USER_AGENT" ? secrets["SEC_USER_AGENT"] : undefined)),
		fetch: overrides.fetch ?? (vi.fn() as unknown as typeof fetch),
		signal: overrides.signal,
		log: overrides.log ?? vi.fn(),
	};
}

async function runCollect(ctx: CollectorContext): Promise<CollectorResult> {
	const promise = secCollector.collect(ctx);
	await vi.runAllTimersAsync();
	return promise;
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const UA_SECRET = { SEC_USER_AGENT: "daily-intelligence contact@example.com" };

function submissionsBody() {
	return {
		name: "Apple Inc.",
		filings: {
			recent: {
				form: ["8-K", "SC 13G", "10-Q"],
				filingDate: ["2026-01-01", "2026-01-01", "2025-06-01"],
				accessionNumber: ["0000320193-26-000001", "0000320193-26-000002", "0000320193-25-000050"],
				primaryDocument: ["a8k.htm", "sc13g.htm", "q1.htm"],
			},
		},
	};
}

describe("secCollector", () => {
	it("returns DISABLED, not thrown, when the required User-Agent is missing", async () => {
		const ctx = makeCtx({ secrets: {} });
		const check = await secCollector.check(ctx);
		expect(check.ok).toBe(false);

		const result = await runCollect(ctx);
		expect(result.health).toBe("DISABLED");
		expect(result.items).toEqual([]);
	});

	it("collects only tracked forms within the since window as items + filing facts", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(submissionsBody()));
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: UA_SECRET });

		const result = await runCollect(ctx);

		expect(result.health).toBe("OK");
		// 8-K is tracked and within window; SC 13G is not a tracked form; 10-Q is tracked but before `since`.
		// The same fixture is served for all three watchlisted companies, so one 8-K item each.
		expect(result.items.length).toBe(3);
		expect(result.items.every((i) => i.metadata.form === "8-K")).toBe(true);
		expect(result.facts.length).toBe(3);
		expect(result.facts.every((f) => f.kind === "filing")).toBe(true);
	});

	it("sends the configured User-Agent on every request (SEC policy)", async () => {
		let seenUa: string | null = null;
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			seenUa = (init?.headers as Record<string, string> | undefined)?.["User-Agent"] ?? null;
			return jsonResponse(submissionsBody());
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: UA_SECRET });

		await runCollect(ctx);
		expect(seenUa).toBe(UA_SECRET.SEC_USER_AGENT);
	});

	it("retries a 429 honouring Retry-After via the shared http client", async () => {
		let calls = 0;
		const fetchMock = vi.fn(async () => {
			calls++;
			if (calls === 1) return new Response("throttled", { status: 429, headers: { "retry-after": "0" } });
			return jsonResponse(submissionsBody());
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: UA_SECRET });

		const result = await runCollect(ctx);
		expect(result.items.length).toBe(3);
		expect(calls).toBeGreaterThanOrEqual(4);
	});

	it("treats a persistent per-company failure as a warning, not a crash, and keeps going", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes("0000320193")) throw new Error("connection reset");
			return jsonResponse(submissionsBody());
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: UA_SECRET });

		const result = await runCollect(ctx);
		expect(result.warnings.some((w) => w.includes("0000320193"))).toBe(true);
		expect(result.items.length).toBeGreaterThan(0); // other companies still collected
		expect(result.health).toBe("DEGRADED");
	});

	it("counts a malformed submissions payload without crashing", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ name: "Apple Inc." })); // missing filings.recent
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: UA_SECRET });

		const result = await runCollect(ctx);
		expect(result.health).toBe("FAILED");
		expect(result.warnings.length).toBeGreaterThan(0);
		expect(result.items).toEqual([]);
	});

	it("is idempotent: re-running the same window yields identical externalIds", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(submissionsBody()));
		const ctx1 = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: UA_SECRET });
		const ctx2 = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: UA_SECRET });

		const r1 = await runCollect(ctx1);
		const r2 = await runCollect(ctx2);
		expect(r1.items.map((i) => i.externalId)).toEqual(r2.items.map((i) => i.externalId));
	});
});
