import { describe, expect, it, vi } from "vitest";
import { GitHubCollector } from "../src/collectors/github.ts";
import type { CollectorContext } from "../src/collectors/types.ts";

function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function makeCtx(overrides: Partial<CollectorContext> = {}, fetchImpl: typeof fetch): CollectorContext {
	return {
		since: new Date("2026-09-01T00:00:00Z"),
		now: () => new Date("2026-09-13T00:00:00Z"),
		cursor: undefined,
		secret: async (name: string) => {
			if (name === "GITHUB_TOKEN") return "ghp_test_token";
			throw new Error(`unknown secret ${name}`);
		},
		hasSecret: async () => false,
		fetch: fetchImpl,
		log: () => {},
		...overrides,
	};
}

const REPO = "acme/widgets";

function baseHandlers(opts: { rateLimited?: boolean } = {}) {
	return vi.fn().mockImplementation(async (url: string) => {
		if (url.includes("/releases")) {
			return jsonResponse(
				[{ id: 1, tag_name: "v1.0.0", name: "v1.0.0", html_url: "https://x/release/1", body: "notes", published_at: "2026-09-10T00:00:00Z", author: { login: "alice" } }],
				{ etag: '"releases-etag-1"', "x-ratelimit-remaining": "100" },
			);
		}
		if (url.includes("/tags")) {
			return jsonResponse([{ name: "v1.0.0", commit: { sha: "abc123" } }], { etag: '"tags-etag-1"', "x-ratelimit-remaining": "100" });
		}
		if (url.includes("/events")) {
			return jsonResponse([{ id: "e1", type: "WatchEvent", created_at: "2026-09-11T00:00:00Z", actor: { login: "bob" } }], { etag: '"events-etag-1"', "x-ratelimit-remaining": "100" });
		}
		if (url.includes("/issues")) {
			return jsonResponse(
				[
					{
						id: 100,
						number: 5,
						title: "Important bug",
						body: "details",
						html_url: "https://x/issues/5",
						state: "open",
						user: { login: "carol" },
						created_at: "2026-09-12T00:00:00Z",
						updated_at: "2026-09-12T00:00:00Z",
						labels: ["security"],
						reactions: { total_count: 2 },
					},
					{
						id: 101,
						number: 6,
						title: "Minor typo",
						body: "typo",
						html_url: "https://x/issues/6",
						state: "open",
						user: { login: "dave" },
						created_at: "2026-09-12T00:00:00Z",
						updated_at: "2026-09-12T00:00:00Z",
						labels: [],
						reactions: { total_count: 0 },
					},
				],
				{ "x-ratelimit-remaining": opts.rateLimited ? "0" : "100" },
			);
		}
		throw new Error(`unexpected url ${url}`);
	});
}

describe("GitHubCollector", () => {
	it("collects releases, tags, events, and mechanically-important issues only", async () => {
		const collector = new GitHubCollector({ repos: [REPO] });
		const fetchImpl = baseHandlers();
		const ctx = makeCtx({ hasSecret: async () => true }, fetchImpl as unknown as typeof fetch);
		const result = await collector.collect(ctx);

		expect(result.health).toBe("OK");
		const kinds = result.items.map((i) => i.metadata["kind"]);
		expect(kinds).toContain("release");
		expect(kinds).toContain("tag");
		expect(kinds).toContain("event");
		// "Important bug" has a security label -> included; "Minor typo" has none -> excluded.
		expect(result.items.some((i) => i.title === "Important bug")).toBe(true);
		expect(result.items.some((i) => i.title === "Minor typo")).toBe(false);
	});

	it("degrades rather than fails when GITHUB_TOKEN is missing", async () => {
		const collector = new GitHubCollector({ repos: [REPO] });
		const fetchImpl = baseHandlers();
		const ctx = makeCtx({ hasSecret: async () => false }, fetchImpl as unknown as typeof fetch);
		const result = await collector.collect(ctx);

		expect(result.health).toBe("DEGRADED");
		expect(result.warnings.some((w) => w.includes("GITHUB_TOKEN"))).toBe(true);
		expect(result.items.length).toBeGreaterThan(0);
	});

	it("reports DEGRADED when rate limit is nearly exhausted", async () => {
		const collector = new GitHubCollector({ repos: [REPO] });
		const fetchImpl = baseHandlers({ rateLimited: true });
		const ctx = makeCtx({ hasSecret: async () => true }, fetchImpl as unknown as typeof fetch);
		const result = await collector.collect(ctx);
		expect(result.health).toBe("DEGRADED");
	});

	it("honours ETag conditional requests: a 304 yields no new items for that endpoint", async () => {
		const fetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string> | undefined;
			if (url.includes("/releases")) {
				if (headers?.["if-none-match"] === '"releases-etag-1"') {
					return new Response(null, { status: 304 });
				}
				return jsonResponse([{ id: 1, tag_name: "v1.0.0", name: "v1.0.0", html_url: "https://x/release/1", body: "", published_at: "2026-09-10T00:00:00Z" }], { etag: '"releases-etag-1"' });
			}
			if (url.includes("/tags")) return jsonResponse([]);
			if (url.includes("/events")) return jsonResponse([]);
			if (url.includes("/issues")) return jsonResponse([], { "x-ratelimit-remaining": "100" });
			throw new Error(`unexpected url ${url}`);
		});
		const collector = new GitHubCollector({ repos: [REPO] });
		const first = await collector.collect(makeCtx({ hasSecret: async () => true }, fetchImpl as unknown as typeof fetch));
		expect(first.items.some((i) => i.metadata["kind"] === "release")).toBe(true);

		const second = await collector.collect(makeCtx({ hasSecret: async () => true, cursor: first.cursor }, fetchImpl as unknown as typeof fetch));
		expect(second.items.some((i) => i.metadata["kind"] === "release")).toBe(false);
	});

	it("continues to other repos when one repo's request fails", async () => {
		const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
			if (url.includes("bad-repo")) throw new Error("network down");
			if (url.includes("/releases")) return jsonResponse([]);
			if (url.includes("/tags")) return jsonResponse([]);
			if (url.includes("/events")) return jsonResponse([]);
			if (url.includes("/issues")) return jsonResponse([], { "x-ratelimit-remaining": "100" });
			throw new Error(`unexpected url ${url}`);
		});
		const collector = new GitHubCollector({ repos: ["acme/bad-repo", REPO] });
		const ctx = makeCtx({ hasSecret: async () => true }, fetchImpl as unknown as typeof fetch);
		const result = await collector.collect(ctx);
		expect(result.warnings.some((w) => w.includes("bad-repo"))).toBe(true);
	});

	it("is idempotent: the same fixtures collected twice produce the same external ids", async () => {
		const collector1 = new GitHubCollector({ repos: [REPO] });
		const result1 = await collector1.collect(makeCtx({ hasSecret: async () => true }, baseHandlers() as unknown as typeof fetch));

		const collector2 = new GitHubCollector({ repos: [REPO] });
		const result2 = await collector2.collect(makeCtx({ hasSecret: async () => true }, baseHandlers() as unknown as typeof fetch));

		expect(result1.items.map((i) => i.externalId).sort()).toEqual(result2.items.map((i) => i.externalId).sort());
	});
});
