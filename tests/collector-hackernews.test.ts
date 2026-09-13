import { describe, expect, it, vi } from "vitest";
import { HackerNewsCollector } from "../src/collectors/hackernews.ts";
import type { CollectorContext } from "../src/collectors/types.ts";

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function makeCtx(overrides: Partial<CollectorContext> = {}, fetchImpl: typeof fetch): CollectorContext {
	return {
		since: new Date("2026-09-01T00:00:00Z"),
		now: () => new Date("2026-09-13T00:00:00Z"),
		cursor: undefined,
		secret: async () => {
			throw new Error("no secrets needed");
		},
		hasSecret: async () => false,
		watchlists: { github_repos: [], sec_companies: [], crypto_assets: [], fred_series: [], subreddits: [], youtube_channels: [], arxiv_categories: [] },
		sourceConfig: { enabled: true, rateLimitPerMinute: 60, timeoutMs: 10_000, pageSize: 50, requiredSecrets: [] },
		config: async () => undefined,
		fetch: fetchImpl,
		log: () => {},
		...overrides,
	};
}

const HN_ITEMS: Record<number, unknown> = {
	1: { id: 1, type: "story", title: "Item one", url: "https://a.test", by: "alice", time: 1_757_000_000, score: 42 },
	2: { id: 2, type: "story", title: "Item two", by: "bob", time: 1_757_000_100, score: 7, text: "some text" },
	3: { id: 3, type: "story", by: "carol", time: 1_757_000_200, deleted: true },
	4: { id: 4, type: "story", by: "dave", time: 1_757_000_300 }, // missing title -> malformed, dropped
};

function mockFetch(): ReturnType<typeof vi.fn> {
	return vi.fn().mockImplementation(async (url: string) => {
		if (url.includes("topstories.json")) return jsonResponse([1, 2]);
		if (url.includes("beststories.json")) return jsonResponse([2, 3]);
		if (url.includes("newstories.json")) return jsonResponse([4]);
		const match = url.match(/item\/(\d+)\.json/);
		if (match) {
			const id = Number(match[1]);
			const item = HN_ITEMS[id];
			if (!item) return jsonResponse(null);
			return jsonResponse(item);
		}
		throw new Error(`unexpected url ${url}`);
	});
}

describe("HackerNewsCollector", () => {
	it("collects stories across all three lists and drops invalid/dead items with warnings", async () => {
		const collector = new HackerNewsCollector();
		const fetchImpl = mockFetch();
		const ctx = makeCtx({}, fetchImpl as unknown as typeof fetch);
		const result = await collector.collect(ctx);

		expect(result.health).toBe("OK");
		expect(result.items.map((i) => i.externalId).sort()).toEqual(["1", "2"]);
		expect(result.warnings.some((w) => w.includes("3"))).toBe(true); // dead item dropped
		expect(result.warnings.some((w) => w.includes("4"))).toBe(true); // missing title dropped
		expect(result.items[0]?.trust).toBe("UNTRUSTED_EXTERNAL_CONTENT");
		expect(result.cursor).toBeDefined();
	});

	it("is idempotent: collecting the same input twice yields the same external ids", async () => {
		const collector = new HackerNewsCollector();
		const ctx1 = makeCtx({}, mockFetch() as unknown as typeof fetch);
		const result1 = await collector.collect(ctx1);

		const collector2 = new HackerNewsCollector();
		const ctx2 = makeCtx({}, mockFetch() as unknown as typeof fetch);
		const result2 = await collector2.collect(ctx2);

		expect(result1.items.map((i) => i.externalId).sort()).toEqual(result2.items.map((i) => i.externalId).sort());
	});

	it("skips ids already seen via the cursor on the next run", async () => {
		const collector = new HackerNewsCollector();
		const first = await collector.collect(makeCtx({}, mockFetch() as unknown as typeof fetch));

		const fetchImpl = mockFetch();
		const second = await collector.collect(makeCtx({ cursor: first.cursor }, fetchImpl as unknown as typeof fetch));

		// All previously-seen ids (1 and 2) should not be re-fetched as items.
		const itemFetchUrls = fetchImpl.mock.calls.map((c) => c[0] as string).filter((u) => u.includes("/item/"));
		expect(itemFetchUrls.some((u) => u.includes("/item/1.json"))).toBe(false);
		expect(itemFetchUrls.some((u) => u.includes("/item/2.json"))).toBe(false);
		expect(second.items).toEqual([]);
	});

	it("handles a persistently failing individual item fetch (e.g. timeout) without failing the whole run", async () => {
		const collector = new HackerNewsCollector();
		const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
			if (url.includes("topstories.json")) return jsonResponse([1]);
			if (url.includes("beststories.json")) return jsonResponse([]);
			if (url.includes("newstories.json")) return jsonResponse([]);
			if (url.includes("/item/1.json")) {
				throw new DOMException("Aborted", "TimeoutError");
			}
			throw new Error(`unexpected url ${url}`);
		});
		const ctx = makeCtx({}, fetchImpl as unknown as typeof fetch);
		const result = await collector.collect(ctx);
		expect(result.health).toBe("OK");
		expect(result.items).toEqual([]);
		expect(result.warnings.length).toBeGreaterThan(0);
	});

	it("rejects a malformed list payload as a failed collection, not a crash", async () => {
		const collector = new HackerNewsCollector();
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ not: "an array" }));
		const ctx = makeCtx({}, fetchImpl as unknown as typeof fetch);
		const result = await collector.collect(ctx);
		expect(result.health).toBe("FAILED");
		expect(result.error).toBeDefined();
	});
});

describe("HackerNewsCollector work ceiling", () => {
	it("takes only the head of each ranked list, so one poll stays bounded", async () => {
		// Each HN list is up to 500 ids and every item is its own request. Taking
		// all three whole is ~1500 requests behind a 5/sec bucket -- five minutes
		// for a source meant to be cheap enough to poll hourly, which is how it
		// came to be silently missing from finished runs.
		const listIds = (offset: number) => Array.from({ length: 500 }, (_, i) => offset + i);
		const itemRequests: number[] = [];
		const fetchImpl = vi.fn(async (url: string) => {
			if (url.includes("topstories.json")) return jsonResponse(listIds(1_000));
			if (url.includes("beststories.json")) return jsonResponse(listIds(2_000));
			if (url.includes("newstories.json")) return jsonResponse(listIds(3_000));
			const id = Number(url.match(/item\/(\d+)\.json/)?.[1]);
			itemRequests.push(id);
			return jsonResponse({ id, type: "story", title: `Story ${id}`, by: "someone", time: 1_757_000_000, score: 1 });
		}) as unknown as typeof fetch;

		const result = await new HackerNewsCollector().collect(
			makeCtx(
				{ sourceConfig: { enabled: true, rateLimitPerMinute: 60, timeoutMs: 10_000, pageSize: 5, requiredSecrets: [] } },
				fetchImpl,
			),
		);

		// Three lists, five each, no overlap between these ranges.
		expect(itemRequests).toHaveLength(15);
		expect(result.items).toHaveLength(15);
		// And it is the head of each list that was taken, not an arbitrary slice.
		expect(itemRequests).toContain(1_000);
		expect(itemRequests).not.toContain(1_005);
		expect(result.health).toBe("OK");
	});
})
