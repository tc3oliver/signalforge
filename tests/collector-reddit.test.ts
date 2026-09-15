import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redditCollector } from "../src/collectors/reddit.ts";
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
			fred_series: [],
			subreddits: ["LocalLLaMA", "MachineLearning", "singularity"],
			youtube_channels: [],
			arxiv_categories: [],
		},
		sourceConfig: overrides.sourceConfig ?? { enabled: true, rateLimitPerMinute: 30, timeoutMs: 10_000, pageSize: 25, requiredSecrets: [] },
		config: overrides.config ?? (async () => undefined),
		fetch: overrides.fetch ?? (vi.fn() as unknown as typeof fetch),
		signal: overrides.signal,
		log: overrides.log ?? vi.fn(),
	};
}

async function runCollect(ctx: CollectorContext): Promise<CollectorResult> {
	const promise = redditCollector.collect(ctx);
	await vi.runAllTimersAsync();
	return promise;
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

function listing(posts: { id: string; title: string }[]) {
	return {
		data: {
			children: posts.map((p) => ({
				data: {
					id: p.id,
					title: p.title,
					selftext: "",
					author: "someone",
					permalink: `/r/test/comments/${p.id}/`,
					created_utc: 1735689600,
					score: 10,
					num_comments: 2,
					subreddit: "test",
				},
			})),
		},
	};
}

describe("redditCollector", () => {
	it("collects posts from public .json endpoints without OAuth (optional credentials)", async () => {
		// Each subreddit/query gets a distinct post id so nothing collides in de-dup,
		// keeping this fixture a clean OK-health case.
		let n = 0;
		const fetchMock = vi.fn(async (url: string) => {
			expect(url).toContain("www.reddit.com");
			n++;
			return jsonResponse(listing([{ id: `post-${n}`, title: "New LLM release" }]));
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch });

		const check = await redditCollector.check(ctx);
		expect(check.detail).toMatch(/public/);

		const result = await runCollect(ctx);
		expect(result.health).toBe("OK");
		expect(result.items.length).toBeGreaterThan(0);
		expect(result.items[0]?.metadata.score).toBe(10);
	});

	it("uses OAuth when both client credentials are present", async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.includes("access_token")) return jsonResponse({ access_token: "tok-123" });
			expect(url).toContain("oauth.reddit.com");
			expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer tok-123");
			if (url.includes("/new.json")) return jsonResponse(listing([{ id: "xyz", title: "OAuth post" }]));
			return jsonResponse(listing([]));
		});
		const ctx = makeCtx({
			fetch: fetchMock as unknown as typeof fetch,
			secrets: { REDDIT_CLIENT_ID: "id", REDDIT_CLIENT_SECRET: "secret" },
		});

		const result = await runCollect(ctx);
		expect(result.items.some((i) => i.externalId === "reddit-xyz")).toBe(true);
	});

	it("degrades to public endpoints (DEGRADED) when only one OAuth credential is set", async () => {
		let n = 0;
		const fetchMock = vi.fn(async (url: string) => {
			expect(url).not.toContain("oauth.reddit.com");
			n++;
			return jsonResponse(listing([{ id: `post-${n}`, title: "Public fallback post" }]));
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: { REDDIT_CLIENT_ID: "id-only" } });

		const result = await runCollect(ctx);
		expect(result.health).toBe("DEGRADED");
		expect(result.warnings.some((w) => w.includes("only one of"))).toBe(true);
		expect(result.items.length).toBeGreaterThan(0);
	});

	it("retries a 429 via the shared http client", async () => {
		let calls = 0;
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes("/r/LocalLLaMA/new.json")) {
				calls++;
				if (calls === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
				return jsonResponse(listing([{ id: "r1", title: "Retried post" }]));
			}
			return jsonResponse(listing([]));
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch });

		const result = await runCollect(ctx);
		expect(result.items.some((i) => i.externalId === "reddit-r1")).toBe(true);
		expect(calls).toBe(2);
	});

	it("treats a persistent failure on one subreddit as a warning, not a crash", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes("/r/LocalLLaMA/")) throw new Error("dns failure");
			return jsonResponse(listing([{ id: "ok1", title: "Fine post" }]));
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch });

		const result = await runCollect(ctx);
		expect(result.warnings.some((w) => w.includes("LocalLLaMA"))).toBe(true);
		expect(result.items.length).toBeGreaterThan(0);
		expect(result.health).toBe("DEGRADED");
	});

	it("counts a malformed post entry without crashing", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ data: { children: [{ data: { id: "bad" } }] } }), // missing title/created_utc
		);
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch });

		const result = await runCollect(ctx);
		expect(result.warnings.some((w) => w.includes("malformed post entry"))).toBe(true);
	});

	it("de-duplicates the same post seen via multiple listings", async () => {
		const dupe = listing([{ id: "dupe1", title: "Seen twice" }]);
		const fetchMock = vi.fn(async () => jsonResponse(dupe));
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch });

		const result = await runCollect(ctx);
		const dupeItems = result.items.filter((i) => i.externalId === "reddit-dupe1");
		expect(dupeItems.length).toBe(1);
		expect(result.warnings.some((w) => w.includes("duplicate"))).toBe(true);
	});
});

describe("redditCollector concurrency", () => {
	const subreddits = Array.from({ length: 8 }, (_, i) => `sub${i}`);

	function watchlistsFor() {
		return {
			github_repos: [],
			sec_companies: [],
			crypto_assets: [],
			fred_series: [],
			subreddits,
			youtube_channels: [],
			arxiv_categories: [],
		};
	}

	function nameOf(url: string): string {
		return url.match(/\/r\/([^/]+)\//)?.[1] ?? "search";
	}

	it("reads several subreddit listings at once, capped at the collector concurrency limit", async () => {
		let inFlight = 0;
		let peak = 0;
		const fetchImpl = vi.fn(async (input: unknown) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5_000));
			inFlight--;
			const name = nameOf(String(input));
			return jsonResponse(listing([{ id: `p-${name}`, title: `post from ${name}` }]));
		});

		const result = await runCollect(makeCtx({ watchlists: watchlistsFor(), fetch: fetchImpl as unknown as typeof fetch }));

		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThanOrEqual(4);
		expect(result.items.length).toBeGreaterThanOrEqual(subreddits.length);
	});

	it("keeps subreddit items in watchlist order when listings answer out of order", async () => {
		const fetchImpl = vi.fn(async (input: unknown) => {
			const name = nameOf(String(input));
			const index = subreddits.indexOf(name);
			// Later subreddits answer sooner, so completion order is the reverse of input order.
			await new Promise((resolve) => setTimeout(resolve, (subreddits.length - index) * 1_000));
			return jsonResponse(listing([{ id: `p-${name}`, title: `post from ${name}` }]));
		});

		const result = await runCollect(makeCtx({ watchlists: watchlistsFor(), fetch: fetchImpl as unknown as typeof fetch }));

		const fromSubreddits = result.items.filter((i) => i.sourceName.startsWith("r/"));
		expect(fromSubreddits.map((i) => i.sourceName)).toEqual(subreddits.map((s) => `r/${s}`));
	});
});
