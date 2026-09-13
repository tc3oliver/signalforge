import { describe, expect, it, vi } from "vitest";
import { ArxivCollector } from "../src/collectors/arxiv.ts";
import type { CollectorContext } from "../src/collectors/types.ts";

function atomFeed(entries: { id: string; title: string; summary: string; published: string; updated: string; authors?: string[] }[], total: number): string {
	const entryXml = entries
		.map(
			(e) => `<entry>
  <id>${e.id}</id>
  <title>${e.title}</title>
  <summary>${e.summary}</summary>
  <published>${e.published}</published>
  <updated>${e.updated}</updated>
  ${(e.authors ?? ["Ada Lovelace"]).map((a) => `<author><name>${a}</name></author>`).join("\n")}
  <category term="cs.CL"/>
  <link href="${e.id}" rel="alternate" type="text/html"/>
</entry>`,
		)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>${total}</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>${entries.length}</opensearch:itemsPerPage>
  ${entryXml}
</feed>`;
}

function xmlResponse(xml: string): Response {
	return new Response(xml, { status: 200, headers: { "content-type": "application/atom+xml" } });
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
		sourceConfig: { enabled: true, rateLimitPerMinute: 20, timeoutMs: 15_000, pageSize: 50, requiredSecrets: [] },
		config: async () => undefined,
		fetch: fetchImpl,
		log: () => {},
		...overrides,
	};
}

const noSleep = async () => {};

describe("ArxivCollector", () => {
	it("parses entries from the Atom feed", async () => {
		const feed = atomFeed(
			[
				{
					id: "https://arxiv.org/abs/2509.00001v1",
					title: "A Great Paper",
					summary: "This paper is great.",
					published: "2026-09-05T00:00:00Z",
					updated: "2026-09-06T00:00:00Z",
				},
			],
			1,
		);
		const fetchImpl = vi.fn().mockResolvedValue(xmlResponse(feed));
		const collector = new ArxivCollector({ sleep: noSleep });
		const result = await collector.collect(makeCtx({}, fetchImpl as unknown as typeof fetch));

		expect(result.health).toBe("OK");
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.externalId).toBe("2509.00001v1");
		expect(result.items[0]?.title).toBe("A Great Paper");
		expect(result.items[0]?.trust).toBe("UNTRUSTED_EXTERNAL_CONTENT");
	});

	it("paginates using start/max_results until totalResults is reached", async () => {
		const page1 = atomFeed(
			[{ id: "https://arxiv.org/abs/1", title: "P1", summary: "s", published: "2026-09-05T00:00:00Z", updated: "2026-09-05T00:00:00Z" }],
			2,
		);
		const page2 = atomFeed(
			[{ id: "https://arxiv.org/abs/2", title: "P2", summary: "s", published: "2026-09-04T00:00:00Z", updated: "2026-09-04T00:00:00Z" }],
			2,
		);
		const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
			if (url.includes("start=0")) return xmlResponse(page1);
			if (url.includes("start=1")) return xmlResponse(page2);
			return xmlResponse(atomFeed([], 2));
		});
		const collector = new ArxivCollector({ sleep: noSleep });
		const result = await collector.collect(makeCtx({}, fetchImpl as unknown as typeof fetch));
		expect(result.items.map((i) => i.externalId)).toEqual(["1", "2"]);
	});

	it("advances the cursor and skips already-seen entries on the next run", async () => {
		const feed = atomFeed(
			[{ id: "https://arxiv.org/abs/1", title: "P1", summary: "s", published: "2026-09-05T00:00:00Z", updated: "2026-09-05T00:00:00Z" }],
			1,
		);
		const collector = new ArxivCollector({ sleep: noSleep });
		const first = await collector.collect(makeCtx({}, vi.fn().mockResolvedValue(xmlResponse(feed)) as unknown as typeof fetch));
		expect(first.items).toHaveLength(1);

		const second = await collector.collect(makeCtx({ cursor: first.cursor }, vi.fn().mockResolvedValue(xmlResponse(feed)) as unknown as typeof fetch));
		expect(second.items).toHaveLength(0);
	});

	it("drops a malformed entry (missing id) without crashing", async () => {
		const malformed = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>1</opensearch:totalResults>
  <entry><title>No id here</title><summary>s</summary><published>2026-09-01T00:00:00Z</published><updated>2026-09-01T00:00:00Z</updated></entry>
</feed>`;
		const fetchImpl = vi.fn().mockResolvedValue(xmlResponse(malformed));
		const collector = new ArxivCollector({ sleep: noSleep });
		const result = await collector.collect(makeCtx({}, fetchImpl as unknown as typeof fetch));
		expect(result.health).toBe("OK");
		expect(result.items).toEqual([]);
	});

	it("waits at least the configured interval between paginated requests", async () => {
		const page1 = atomFeed(
			[{ id: "https://arxiv.org/abs/1", title: "P1", summary: "s", published: "2026-09-05T00:00:00Z", updated: "2026-09-05T00:00:00Z" }],
			2,
		);
		const page2 = atomFeed(
			[{ id: "https://arxiv.org/abs/2", title: "P2", summary: "s", published: "2026-09-04T00:00:00Z", updated: "2026-09-04T00:00:00Z" }],
			2,
		);
		const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
			if (url.includes("start=0")) return xmlResponse(page1);
			return xmlResponse(page2);
		});
		const sleep = vi.fn().mockResolvedValue(undefined);
		const collector = new ArxivCollector({ sleep });
		await collector.collect(makeCtx({}, fetchImpl as unknown as typeof fetch));
		expect(sleep).toHaveBeenCalledWith(3_000, undefined);
	});
});
