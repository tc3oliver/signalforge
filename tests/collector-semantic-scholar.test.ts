import { describe, expect, it, vi } from "vitest";
import { SemanticScholarCollector } from "../src/collectors/semantic-scholar.ts";
import type { CollectorContext } from "../src/collectors/types.ts";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function makeCtx(overrides: Partial<CollectorContext> = {}, fetchImpl: typeof fetch): CollectorContext {
	return {
		since: new Date("2026-09-01T00:00:00Z"),
		now: () => new Date("2026-09-13T00:00:00Z"),
		cursor: undefined,
		secret: async (name: string) => {
			if (name === "SEMANTIC_SCHOLAR_API_KEY") return "s2-test-key";
			throw new Error(`unknown secret ${name}`);
		},
		hasSecret: async () => false,
		fetch: fetchImpl,
		log: () => {},
		...overrides,
	};
}

const PAPER = {
	paperId: "abc123",
	title: "A Great Paper",
	abstract: "abstract text",
	url: "https://semanticscholar.org/paper/abc123",
	venue: "NeurIPS",
	year: 2026,
	publicationDate: "2026-09-01",
	authors: [{ name: "Ada Lovelace" }],
	citationCount: 42,
	externalIds: { ArXiv: "2509.00001" },
};

describe("SemanticScholarCollector", () => {
	it("batches arXiv ids and enriches with citation counts, authors, venue", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([PAPER]));
		const collector = new SemanticScholarCollector({ arxivIds: ["2509.00001"] });
		const result = await collector.collect(makeCtx({ hasSecret: async () => true }, fetchImpl as unknown as typeof fetch));

		expect(result.health).toBe("OK");
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.metadata["citationCount"]).toBe(42);
		expect(result.items[0]?.trust).toBe("UNTRUSTED_EXTERNAL_CONTENT");
		const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(init.body as string).ids).toEqual(["ArXiv:2509.00001"]);
	});

	it("degrades without an API key rather than failing", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([PAPER]));
		const collector = new SemanticScholarCollector({ arxivIds: ["2509.00001"] });
		const result = await collector.collect(makeCtx({ hasSecret: async () => false }, fetchImpl as unknown as typeof fetch));
		expect(result.health).toBe("DEGRADED");
		expect(result.warnings.some((w) => w.includes("SEMANTIC_SCHOLAR_API_KEY"))).toBe(true);
	});

	it("backs off hard on 429 and reports DEGRADED rather than crashing", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "rate limited" }, 429, { "retry-after": "0" }));
		const collector = new SemanticScholarCollector({ arxivIds: ["2509.00001"] });
		const result = await collector.collect(makeCtx({ hasSecret: async () => true }, fetchImpl as unknown as typeof fetch));
		expect(result.health).toBe("DEGRADED");
		expect(result.warnings.some((w) => /rate.?limit/i.test(w))).toBe(true);
	}, 20_000);

	it("counts a null enrichment result (not found) as a warning, not an error", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([null]));
		const collector = new SemanticScholarCollector({ arxivIds: ["9999.99999"] });
		const result = await collector.collect(makeCtx({ hasSecret: async () => true }, fetchImpl as unknown as typeof fetch));
		expect(result.health).toBe("OK");
		expect(result.items).toEqual([]);
		expect(result.warnings.some((w) => w.includes("9999.99999"))).toBe(true);
	});

	it("rejects a malformed batch payload without crashing", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ not: "an array" }));
		const collector = new SemanticScholarCollector({ arxivIds: ["2509.00001"] });
		const result = await collector.collect(makeCtx({ hasSecret: async () => true }, fetchImpl as unknown as typeof fetch));
		expect(result.items).toEqual([]);
		expect(result.warnings.length).toBeGreaterThan(0);
	});

	it("is idempotent: enriching the same ids twice yields the same external ids", async () => {
		const collector1 = new SemanticScholarCollector({ arxivIds: ["2509.00001"] });
		const result1 = await collector1.collect(
			makeCtx({ hasSecret: async () => true }, vi.fn().mockResolvedValue(jsonResponse([PAPER])) as unknown as typeof fetch),
		);
		const collector2 = new SemanticScholarCollector({ arxivIds: ["2509.00001"] });
		const result2 = await collector2.collect(
			makeCtx({ hasSecret: async () => true }, vi.fn().mockResolvedValue(jsonResponse([PAPER])) as unknown as typeof fetch),
		);
		expect(result1.items.map((i) => i.externalId)).toEqual(result2.items.map((i) => i.externalId));
	});
});
