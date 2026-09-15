import { describe, expect, it, vi } from "vitest";
import { ArxivCollector } from "../src/collectors/arxiv.ts";
import type { CollectorContext } from "../src/collectors/types.ts";

/*
 * The export API (`export.arxiv.org/api/query`) answered every request from this
 * machine with `429 Rate exceeded.` for three days straight -- 27 consecutive
 * FAILED runs, no items, no Retry-After -- while already pacing at the 3 seconds
 * arXiv's own guidance asks for. These tests pin the announcement feeds it was
 * moved to, and the behaviours that had to survive the move.
 */

interface FeedItem {
	id: string;
	title: string;
	description?: string;
	pubDate?: string;
	announceType?: string;
	creators?: string;
	categories?: string[];
}

function rssFeed(category: string, items: FeedItem[]): string {
	const itemXml = items
		.map(
			(i) => `  <item>
      <title>${i.title}</title>
      <link>https://arxiv.org/abs/${i.id}</link>
      <description>${i.description ?? `arXiv:${i.id} Announce Type: new \nAbstract: An abstract.`}</description>
      <guid isPermaLink="false">oai:arXiv.org:${i.id}</guid>
${(i.categories ?? [category]).map((c) => `      <category>${c}</category>`).join("\n")}
      <pubDate>${i.pubDate ?? "Tue, 15 Sep 2026 00:00:00 -0400"}</pubDate>
      <arxiv:announce_type>${i.announceType ?? "new"}</arxiv:announce_type>
      <dc:creator>${i.creators ?? "Ada Lovelace, Grace Hopper"}</dc:creator>
    </item>`,
		)
		.join("\n");
	return `<?xml version='1.0' encoding='UTF-8'?>
<rss xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
  <channel>
    <title>${category} updates on arXiv.org</title>
${itemXml}
  </channel>
</rss>`;
}

function xmlResponse(xml: string): Response {
	return new Response(xml, { status: 200, headers: { "content-type": "application/rss+xml" } });
}

function makeCtx(overrides: Partial<CollectorContext>, fetchImpl: typeof fetch): CollectorContext {
	return {
		since: new Date("2026-09-01T00:00:00Z"),
		now: () => new Date("2026-09-16T00:00:00Z"),
		cursor: undefined,
		secret: async () => {
			throw new Error("no secrets needed");
		},
		hasSecret: async () => false,
		watchlists: {
			github_repos: [],
			sec_companies: [],
			crypto_assets: [],
			fred_series: [],
			subreddits: [],
			youtube_channels: [],
			arxiv_categories: ["cs.CL"],
		},
		sourceConfig: { enabled: true, rateLimitPerMinute: 20, timeoutMs: 15_000, pageSize: 50, requiredSecrets: [] },
		config: async () => undefined,
		fetch: fetchImpl,
		log: () => {},
		...overrides,
	};
}

const noSleep = async () => {};
/*
 * The token bucket paces requests for real, so a suite using the production
 * 3-second interval would spend half a minute asleep. The default is asserted
 * on its own below; everywhere else the interval is only in the way.
 */
const FAST_MS = 1;

describe("ArxivCollector", () => {
	it("reads the announcement feed rather than the throttled export API", async () => {
		const urls: string[] = [];
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			urls.push(String(input));
			return xmlResponse(rssFeed("cs.CL", [{ id: "2609.13151v1", title: "A Great Paper" }]));
		});
		const result = await new ArxivCollector({ sleep: noSleep, minRequestIntervalMs: FAST_MS }).collect(
			makeCtx({}, fetchImpl as unknown as typeof fetch),
		);

		expect(urls[0]).toBe("https://rss.arxiv.org/rss/cs.CL");
		expect(urls[0]).not.toContain("export.arxiv.org");
		expect(result.health).toBe("OK");
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.externalId).toBe("2609.13151v1");
		expect(result.items[0]?.title).toBe("A Great Paper");
		expect(result.items[0]?.trust).toBe("UNTRUSTED_EXTERNAL_CONTENT");
	});

	it("keeps the abstract and drops the preamble the feed repeats in every description", async () => {
		const feed = rssFeed("cs.CL", [
			{
				id: "2609.00001v1",
				title: "P",
				description: "arXiv:2609.00001v1 Announce Type: new \nAbstract: The actual abstract.",
			},
		]);
		const result = await new ArxivCollector({ sleep: noSleep, minRequestIntervalMs: FAST_MS }).collect(
			makeCtx({}, (async () => xmlResponse(feed)) as unknown as typeof fetch),
		);
		expect(result.items[0]?.summary).toBe("The actual abstract.");
	});

	it("carries every author and the announce type, and filters neither", async () => {
		const feed = rssFeed("cs.CL", [
			{ id: "2609.00002v2", title: "A Revision", announceType: "replace", creators: "Ada Lovelace, Grace Hopper" },
		]);
		const result = await new ArxivCollector({ sleep: noSleep, minRequestIntervalMs: FAST_MS }).collect(
			makeCtx({}, (async () => xmlResponse(feed)) as unknown as typeof fetch),
		);
		// A replacement is an announcement like any other. Deciding a revision is
		// not worth reading is the curator's call; dropping it here would be
		// editorial filtering before Pi.
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.metadata["announceType"]).toBe("replace");
		expect(result.items[0]?.metadata["authors"]).toEqual(["Ada Lovelace", "Grace Hopper"]);
		expect(result.items[0]?.author).toBe("Ada Lovelace");
	});

	it("keeps the version suffix so a replacement does not collide with the original", async () => {
		const feed = rssFeed("cs.CL", [{ id: "2609.00003v2", title: "V2" }]);
		const result = await new ArxivCollector({ sleep: noSleep, minRequestIntervalMs: FAST_MS }).collect(
			makeCtx({}, (async () => xmlResponse(feed)) as unknown as typeof fetch),
		);
		expect(result.items[0]?.externalId).toBe("2609.00003v2");
	});

	it("requests each configured category, spaced by the polite interval", async () => {
		const urls: string[] = [];
		const sleep = vi.fn().mockResolvedValue(undefined);
		const ctx = makeCtx(
			{
				watchlists: {
					github_repos: [],
					sec_companies: [],
					crypto_assets: [],
					fred_series: [],
					subreddits: [],
					youtube_channels: [],
					arxiv_categories: ["cs.DB", "stat.ME"],
				},
			},
			(async (input: string | URL | Request) => {
				urls.push(String(input));
				return xmlResponse(rssFeed("cs.DB", []));
			}) as unknown as typeof fetch,
		);

		await new ArxivCollector({ sleep }).collect(ctx);

		expect(urls).toEqual(["https://rss.arxiv.org/rss/cs.DB", "https://rss.arxiv.org/rss/stat.ME"]);
		expect(urls.some((u) => u.includes("cs.LG"))).toBe(false);
		// Once, between the two requests -- not before the first.
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(sleep).toHaveBeenCalledWith(3_000, undefined);
	});

	it("announces a cross-listed paper once, not once per category", async () => {
		const ctx = makeCtx(
			{
				watchlists: {
					github_repos: [],
					sec_companies: [],
					crypto_assets: [],
					fred_series: [],
					subreddits: [],
					youtube_channels: [],
					arxiv_categories: ["cs.CL", "cs.LG"],
				},
			},
			(async (input: string | URL | Request) =>
				xmlResponse(
					rssFeed(String(input).endsWith("cs.CL") ? "cs.CL" : "cs.LG", [
						{ id: "2609.00004v1", title: "Cross Listed", categories: ["cs.CL", "cs.LG"] },
					]),
				)) as unknown as typeof fetch,
		);

		const result = await new ArxivCollector({ sleep: noSleep, minRequestIntervalMs: FAST_MS }).collect(ctx);
		expect(result.items).toHaveLength(1);
	});

	it("advances the cursor and skips announcements already consumed", async () => {
		const older = rssFeed("cs.CL", [{ id: "2609.00005v1", title: "Monday", pubDate: "Mon, 14 Sep 2026 00:00:00 -0400" }]);
		const collector = new ArxivCollector({ sleep: noSleep, minRequestIntervalMs: FAST_MS });

		const first = await collector.collect(makeCtx({}, (async () => xmlResponse(older)) as unknown as typeof fetch));
		expect(first.items).toHaveLength(1);

		const second = await collector.collect(
			makeCtx({ cursor: first.cursor }, (async () => xmlResponse(older)) as unknown as typeof fetch),
		);
		expect(second.items).toHaveLength(0);

		// A later build of the same feed is new work, not a repeat.
		const newer = rssFeed("cs.CL", [{ id: "2609.00006v1", title: "Tuesday", pubDate: "Tue, 15 Sep 2026 00:00:00 -0400" }]);
		const third = await collector.collect(
			makeCtx({ cursor: second.cursor }, (async () => xmlResponse(newer)) as unknown as typeof fetch),
		);
		expect(third.items.map((i) => i.externalId)).toEqual(["2609.00006v1"]);
	});

	it("starts over rather than failing on a cursor left by the export-API collector", async () => {
		const feed = rssFeed("cs.CL", [{ id: "2609.00007v1", title: "P" }]);
		const result = await new ArxivCollector({ sleep: noSleep, minRequestIntervalMs: FAST_MS }).collect(
			makeCtx(
				{ cursor: JSON.stringify({ lastUpdated: "2026-09-10T00:00:00Z", nextStart: 50 }) },
				(async () => xmlResponse(feed)) as unknown as typeof fetch,
			),
		);
		expect(result.items).toHaveLength(1);
	});

	it("drops a malformed item without losing the rest of the feed", async () => {
		const xml = `<?xml version='1.0' encoding='UTF-8'?>
<rss xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
  <channel>
    <item><title>No id and no date here</title><description>d</description></item>
    <item>
      <title>Fine</title>
      <link>https://arxiv.org/abs/2609.00008v1</link>
      <description>Abstract: ok</description>
      <guid isPermaLink="false">oai:arXiv.org:2609.00008v1</guid>
      <pubDate>Tue, 15 Sep 2026 00:00:00 -0400</pubDate>
    </item>
  </channel>
</rss>`;
		const result = await new ArxivCollector({ sleep: noSleep, minRequestIntervalMs: FAST_MS }).collect(
			makeCtx({}, (async () => xmlResponse(xml)) as unknown as typeof fetch),
		);
		expect(result.items.map((i) => i.externalId)).toEqual(["2609.00008v1"]);
		expect(result.health).toBe("DEGRADED");
		expect(result.warnings.join(" ")).toContain("malformed");
	});

	it("is DEGRADED, not FAILED, when one category is unavailable and another is not", async () => {
		const ctx = makeCtx(
			{
				watchlists: {
					github_repos: [],
					sec_companies: [],
					crypto_assets: [],
					fred_series: [],
					subreddits: [],
					youtube_channels: [],
					arxiv_categories: ["cs.CL", "cs.LG"],
				},
			},
			(async (input: string | URL | Request) => {
				if (String(input).endsWith("cs.LG")) return new Response("Rate exceeded.", { status: 429 });
				return xmlResponse(rssFeed("cs.CL", [{ id: "2609.00009v1", title: "Survived" }]));
			}) as unknown as typeof fetch,
		);

		const result = await new ArxivCollector({ sleep: noSleep, minRequestIntervalMs: FAST_MS }).collect(ctx);
		expect(result.health).toBe("DEGRADED");
		expect(result.items).toHaveLength(1);
		expect(result.warnings.join(" ")).toContain("cs.LG");
	});

	it("is FAILED when no category could be read at all", async () => {
		// The shape this collector was rewritten to escape: arXiv answering
		// nothing must not be reported as the same thing as a partial run.
		const result = await new ArxivCollector({ sleep: noSleep, minRequestIntervalMs: FAST_MS }).collect(
			makeCtx({}, (async () => new Response("Rate exceeded.", { status: 429 })) as unknown as typeof fetch),
		);
		expect(result.health).toBe("FAILED");
		expect(result.items).toEqual([]);
		expect(result.error).toBeDefined();
	});

	it("uses the timeout configured in sources.yaml, not a hardcoded constant", async () => {
		// A collector that ignores its own sourceConfig turns config editing into
		// a no-op -- the failure shape this guards against.
		let observedTimeoutMs: number | undefined;
		const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const signal = init?.signal;
			if (signal) {
				const startedAt = Date.now();
				await new Promise<void>((resolve) => {
					const done = () => {
						observedTimeoutMs = Date.now() - startedAt;
						resolve();
					};
					signal.addEventListener("abort", done, { once: true });
				});
			}
			return new Response("", { status: 504 });
		});

		const result = await new ArxivCollector({ sleep: noSleep, minRequestIntervalMs: FAST_MS }).collect(
			makeCtx(
				{ sourceConfig: { enabled: true, rateLimitPerMinute: 20, timeoutMs: 30, pageSize: 50, requiredSecrets: [] } },
				fetchImpl as unknown as typeof fetch,
			),
		);

		expect(observedTimeoutMs).toBeDefined();
		// The 30ms ceiling was honoured; the generous bound only rules out the
		// old hardcoded 15s.
		expect(observedTimeoutMs!).toBeLessThan(5_000);
		expect(result.health).toBe("FAILED");
	});
});
