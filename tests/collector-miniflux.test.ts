import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { minifluxCollector } from "../src/collectors/miniflux.ts";
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

async function runCollect(ctx: CollectorContext): Promise<CollectorResult> {
	const promise = minifluxCollector.collect(ctx);
	await vi.runAllTimersAsync();
	return promise;
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const CREDS = { MINIFLUX_URL: "https://miniflux.example.com", MINIFLUX_API_KEY: "top-secret-miniflux-key" };

function entry(id: number, title: string) {
	return {
		id,
		title,
		url: `https://example.com/${id}`,
		author: "Author",
		content: `<p>Body ${id}</p>`,
		published_at: "2026-01-01T12:00:00Z",
		feed: { title: "Example Feed" },
	};
}

describe("minifluxCollector", () => {
	it("returns DISABLED, not thrown, when required credentials are missing", async () => {
		const ctx = makeCtx({ secrets: {} });
		const check = await minifluxCollector.check(ctx);
		expect(check.ok).toBe(false);

		const result = await runCollect(ctx);
		expect(result.health).toBe("DISABLED");
		expect(result.items).toEqual([]);
	});

	it("returns DISABLED when only one of URL/API key is set", async () => {
		const ctx = makeCtx({ secrets: { MINIFLUX_URL: "https://miniflux.example.com" } });
		const result = await runCollect(ctx);
		expect(result.health).toBe("DISABLED");
	});

	it("collects entries and sends the API key as X-Auth-Token", async () => {
		let seenAuth: string | null = null;
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			seenAuth = (init?.headers as Record<string, string> | undefined)?.["X-Auth-Token"] ?? null;
			expect(url).toContain("https://miniflux.example.com/v1/entries");
			return jsonResponse({ total: 1, entries: [entry(1, "First post")] });
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: CREDS });

		const result = await runCollect(ctx);
		expect(result.health).toBe("OK");
		expect(seenAuth).toBe(CREDS.MINIFLUX_API_KEY);
		expect(result.items[0]?.externalId).toBe("miniflux-1");
		expect(result.cursor).toBe("1");
	});

	it("paginates via offset until entries are exhausted", async () => {
		// First page is a full PAGE_LIMIT (100) batch, forcing a second request for
		// the remainder — realistic pagination rather than an under-sized fixture.
		const fullPage = Array.from({ length: 100 }, (_, i) => entry(i + 1, `Post ${i + 1}`));
		const secondPage = [entry(101, "Last one")];
		const pages = [
			{ total: 101, entries: fullPage },
			{ total: 101, entries: secondPage },
		];
		let call = 0;
		const fetchMock = vi.fn(async () => jsonResponse(pages[call++] ?? { total: 101, entries: [] }));
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: CREDS });

		const result = await runCollect(ctx);
		expect(result.items.length).toBe(101);
		expect(result.items[100]?.externalId).toBe("miniflux-101");
		expect(result.cursor).toBe("101");
	});

	it("advances after_entry_id cursor across runs without skipping or repeating entries", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			const u = new URL(url);
			const after = u.searchParams.get("after_entry_id");
			if (after === "2") return jsonResponse({ total: 1, entries: [entry(3, "C")] });
			return jsonResponse({ total: 2, entries: [entry(1, "A"), entry(2, "B")] });
		});
		const ctx1 = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: CREDS });
		const r1 = await runCollect(ctx1);
		expect(r1.cursor).toBe("2");

		const ctx2 = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: CREDS, cursor: r1.cursor });
		const r2 = await runCollect(ctx2);
		expect(r2.items.map((i) => i.externalId)).toEqual(["miniflux-3"]);
	});

	it("retries a 429 via the shared http client", async () => {
		let calls = 0;
		const fetchMock = vi.fn(async () => {
			calls++;
			if (calls === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
			return jsonResponse({ total: 1, entries: [entry(1, "A")] });
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: CREDS });

		const result = await runCollect(ctx);
		expect(result.items.length).toBe(1);
		expect(calls).toBe(2);
	});

	it("treats a persistent transport failure as a warning, stopping cleanly without crashing", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("connection reset");
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: CREDS });

		const result = await runCollect(ctx);
		expect(result.health).toBe("FAILED");
		expect(result.warnings.length).toBeGreaterThan(0);
	});

	it("counts a malformed entry without crashing", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ total: 2, entries: [{ id: 1 }, entry(2, "Good entry")] }), // first entry missing title
		);
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: CREDS });

		const result = await runCollect(ctx);
		expect(result.warnings.some((w) => w.includes("malformed entry"))).toBe(true);
		expect(result.items.some((i) => i.externalId === "miniflux-2")).toBe(true);
	});

	it("is idempotent: identical entries produce identical externalIds across runs", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ total: 1, entries: [entry(1, "Same")] }));
		const ctx1 = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: CREDS });
		const ctx2 = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: CREDS });

		const r1 = await runCollect(ctx1);
		const r2 = await runCollect(ctx2);
		expect(r1.items.map((i) => i.externalId)).toEqual(r2.items.map((i) => i.externalId));
	});

	it("never lets the API key reach the stored raw payload or warnings", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ total: 1, entries: [entry(1, "A")] }));
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: CREDS });

		const result = await runCollect(ctx);
		expect(JSON.stringify(result)).not.toContain(CREDS.MINIFLUX_API_KEY);
	});
});
