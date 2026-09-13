import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { youtubeCollector } from "../src/collectors/youtube.ts";
import type { CollectorContext, CollectorResult } from "../src/collectors/types.ts";

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
	const promise = youtubeCollector.collect(ctx);
	await vi.runAllTimersAsync();
	return promise;
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

function atomFeed(entries: { id: string; title: string }[]): string {
	const items = entries
		.map(
			(e) => `<entry>
	<yt:videoId>${e.id}</yt:videoId>
	<title>${e.title}</title>
	<link href="https://www.youtube.com/watch?v=${e.id}"/>
	<published>2026-01-01T00:00:00+00:00</published>
	<author><name>Channel Name</name></author>
</entry>`,
		)
		.join("\n");
	return `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">${items}</feed>`;
}

function textResponse(body: string, init?: { status?: number }): Response {
	return new Response(body, { status: init?.status ?? 200, headers: { "content-type": "application/atom+xml" } });
}

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
	return new Response(JSON.stringify(body), {
		status: init?.status ?? 200,
		headers: { "content-type": "application/json", ...init?.headers },
	});
}

describe("youtubeCollector", () => {
	it("collects videos via per-channel RSS with no API key (optional credential)", async () => {
		let n = 0;
		const fetchMock = vi.fn(async (url: string) => {
			expect(url).toContain("feeds/videos.xml");
			n++;
			return textResponse(atomFeed([{ id: `vid${n}`, title: "New model drop" }]));
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch });

		const check = await youtubeCollector.check(ctx);
		expect(check.detail).toMatch(/RSS only/);

		const result = await runCollect(ctx);
		expect(result.health).toBe("OK");
		expect(result.items.some((i) => i.externalId.startsWith("youtube-vid"))).toBe(true);
	});

	it("enables Data API discovery only when YOUTUBE_API_KEY is present", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes("feeds/videos.xml")) return textResponse(atomFeed([]));
			if (url.includes("googleapis.com")) {
				return jsonResponse({
					items: [{ id: { videoId: "disc1" }, snippet: { title: "Discovered video", channelTitle: "X", publishedAt: "2026-01-01T00:00:00Z" } }],
				});
			}
			return textResponse(atomFeed([]));
		});
		const ctxNoKey = makeCtx({ fetch: fetchMock as unknown as typeof fetch });
		const r1 = await runCollect(ctxNoKey);
		expect(r1.items.some((i) => i.externalId === "youtube-disc1")).toBe(false);

		const ctxWithKey = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: { YOUTUBE_API_KEY: "key123" } });
		const r2 = await runCollect(ctxWithKey);
		expect(r2.items.some((i) => i.externalId === "youtube-disc1")).toBe(true);
	});

	it("retries a 429 on the Data API via the shared http client", async () => {
		let calls = 0;
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes("feeds/videos.xml")) return textResponse(atomFeed([]));
			calls++;
			if (calls === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
			return jsonResponse({ items: [{ id: { videoId: "r1" }, snippet: { title: "Retried" } }] });
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: { YOUTUBE_API_KEY: "key123" } });

		const result = await runCollect(ctx);
		expect(result.items.some((i) => i.externalId === "youtube-r1")).toBe(true);
	});

	it("treats a persistent RSS failure for one channel as a warning, not a crash", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes("feeds/videos.xml") && url.includes("UCbY9xX3_jW5c5aH7C6-Y7Hg")) {
				throw new Error("dns failure");
			}
			return textResponse(atomFeed([{ id: "ok1", title: "Fine video" }]));
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch });

		const result = await runCollect(ctx);
		expect(result.warnings.length).toBeGreaterThan(0);
		expect(result.items.length).toBeGreaterThan(0);
		expect(result.health).toBe("DEGRADED");
	});

	it("counts an unparsable feed without crashing", async () => {
		const fetchMock = vi.fn(async () => textResponse("not xml at all"));
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch });

		const result = await runCollect(ctx);
		expect(result.warnings.some((w) => w.includes("no parsable entries"))).toBe(true);
	});

	it("never lets the Data API key reach the stored raw payload or warnings", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes("feeds/videos.xml")) return textResponse(atomFeed([]));
			return jsonResponse({ items: [] });
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: { YOUTUBE_API_KEY: "super-secret-yt-key" } });

		const result = await runCollect(ctx);
		expect(JSON.stringify(result)).not.toContain("super-secret-yt-key");
	});

	it("de-duplicates a video seen via both RSS and discovery", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes("feeds/videos.xml")) return textResponse(atomFeed([{ id: "shared1", title: "Seen twice" }]));
			return jsonResponse({ items: [{ id: { videoId: "shared1" }, snippet: { title: "Seen twice" } }] });
		});
		const ctx = makeCtx({ fetch: fetchMock as unknown as typeof fetch, secrets: { YOUTUBE_API_KEY: "key123" } });

		const result = await runCollect(ctx);
		const matches = result.items.filter((i) => i.externalId === "youtube-shared1");
		expect(matches.length).toBe(1);
		expect(result.warnings.some((w) => w.includes("duplicate"))).toBe(true);
	});

	it("is idempotent across two runs with the same feed", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes("feeds/videos.xml")) return textResponse(atomFeed([{ id: "stable1", title: "Stable" }]));
			return jsonResponse({ items: [] });
		});
		const ctx1 = makeCtx({ fetch: fetchMock as unknown as typeof fetch });
		const ctx2 = makeCtx({ fetch: fetchMock as unknown as typeof fetch });

		const r1 = await runCollect(ctx1);
		const r2 = await runCollect(ctx2);
		expect(r1.items.map((i) => i.externalId).sort()).toEqual(r2.items.map((i) => i.externalId).sort());
	});
});
