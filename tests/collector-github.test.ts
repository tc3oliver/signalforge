import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
		watchlists: { github_repos: [], sec_companies: [], crypto_assets: [], fred_series: [], subreddits: [], youtube_channels: [], arxiv_categories: [] },
		sourceConfig: { enabled: true, rateLimitPerMinute: 30, timeoutMs: 10_000, pageSize: 50, requiredSecrets: [] },
		config: async () => undefined,
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
	it("collects releases and mechanically-important issues, and never the repository-event firehose", async () => {
		const collector = new GitHubCollector({ repos: [REPO] });
		const fetchImpl = baseHandlers();
		const ctx = makeCtx({ hasSecret: async () => true }, fetchImpl as unknown as typeof fetch);
		const result = await collector.collect(ctx);

		expect(result.health).toBe("OK");
		const kinds = result.items.map((i) => i.metadata["kind"]);
		expect(kinds).toContain("release");
		// /events is no longer fetched at all: no item may come from it, and no request
		// may be spent on it.
		expect(kinds).not.toContain("event");
		expect(fetchImpl.mock.calls.some((call) => String(call[0]).includes("/events"))).toBe(false);
		// The tag mirrors the release we already collected, so it is not a second item.
		expect(kinds).not.toContain("tag");
		// "Important bug" has a security label -> included; "Minor typo" has none -> excluded.
		expect(result.items.some((i) => i.title === "Important bug")).toBe(true);
		expect(result.items.some((i) => i.title === "Minor typo")).toBe(false);
	});

	it("does not treat every merged pull request as important", async () => {
		/*
		 * Measured against the live API, this one clause was most of what survived
		 * after the event firehose was dropped: on a busy watched repo it admitted
		 * every CI tweak and test-size adjustment. What actually shipped is
		 * collected from /releases instead.
		 */
		const collector = new GitHubCollector({ repos: [REPO] });
		const fetchImpl = vi.fn(async (url: string) => {
			if (url.includes("/issues")) {
				return jsonResponse([
					{
						id: 200,
						number: 10,
						title: "ci : cap parallel jobs",
						body: "",
						html_url: `https://github.com/${REPO}/pull/10`,
						state: "closed",
						user: { login: "someone" },
						created_at: "2026-09-12T00:00:00Z",
						updated_at: "2026-09-12T00:00:00Z",
						labels: [],
						reactions: { total_count: 1 },
						pull_request: { url: "x" },
					},
					{
						id: 201,
						number: 11,
						title: "fix a breaking API change",
						body: "",
						html_url: `https://github.com/${REPO}/pull/11`,
						state: "closed",
						user: { login: "someone" },
						created_at: "2026-09-12T00:00:00Z",
						updated_at: "2026-09-12T00:00:00Z",
						labels: ["breaking-change"],
						reactions: { total_count: 0 },
						pull_request: { url: "x" },
					},
				]);
			}
			return jsonResponse([]);
		});
		const ctx = makeCtx({ hasSecret: async () => true }, fetchImpl as unknown as typeof fetch);
		const result = await collector.collect(ctx);

		expect(result.items.some((i) => i.title === "ci : cap parallel jobs")).toBe(false);
		// A PR clears the same bar as an issue: a label somebody applied, or reactions.
		expect(result.items.some((i) => i.title === "fix a breaking API change")).toBe(true);
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
		expect(result.error).toBeTruthy();
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
			if (url.includes("/issues")) return jsonResponse([], { "x-ratelimit-remaining": "100" });
			throw new Error(`unexpected url ${url}`);
		});
		const collector = new GitHubCollector({ repos: [REPO] });
		const first = await collector.collect(makeCtx({ hasSecret: async () => true }, fetchImpl as unknown as typeof fetch));
		expect(first.items.some((i) => i.metadata["kind"] === "release")).toBe(true);

		const second = await collector.collect(makeCtx({ hasSecret: async () => true, cursor: first.cursor }, fetchImpl as unknown as typeof fetch));
		expect(second.items.some((i) => i.metadata["kind"] === "release")).toBe(false);
	});

	it("continues to other repos when one repo's request fails, and says so in health", async () => {
		const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
			if (url.includes("bad-repo")) throw new Error("network down");
			if (url.includes("/releases")) return jsonResponse([]);
			if (url.includes("/tags")) return jsonResponse([]);
			if (url.includes("/issues")) return jsonResponse([], { "x-ratelimit-remaining": "100" });
			throw new Error(`unexpected url ${url}`);
		});
		const collector = new GitHubCollector({ repos: ["acme/bad-repo", REPO] });
		const ctx = makeCtx({ hasSecret: async () => true }, fetchImpl as unknown as typeof fetch);
		const result = await collector.collect(ctx);
		expect(result.warnings.some((w) => w.includes("bad-repo"))).toBe(true);
		expect(result.health).toBe("DEGRADED");
	});

	it("reports FAILED, not OK, when every watched repo fails", async () => {
		const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse({ message: "Bad credentials" }, {}, 401));
		const collector = new GitHubCollector({ repos: ["acme/a", "acme/b"] });
		const result = await collector.collect(makeCtx({ hasSecret: async () => true }, fetchImpl as unknown as typeof fetch));
		expect(result.items).toHaveLength(0);
		expect(result.health).toBe("FAILED");
		expect(result.error).toContain("2/2");
	});

	it("is idempotent: the same fixtures collected twice produce the same external ids", async () => {
		const collector1 = new GitHubCollector({ repos: [REPO] });
		const result1 = await collector1.collect(makeCtx({ hasSecret: async () => true }, baseHandlers() as unknown as typeof fetch));

		const collector2 = new GitHubCollector({ repos: [REPO] });
		const result2 = await collector2.collect(makeCtx({ hasSecret: async () => true }, baseHandlers() as unknown as typeof fetch));

		expect(result1.items.map((i) => i.externalId).sort()).toEqual(result2.items.map((i) => i.externalId).sort());
	});
});

/**
 * The regression this whole change exists for: a same-day release of a watched repo
 * must survive narrowing, while the page of release history around it must not be
 * re-reported. Shape taken from vllm-project/vllm v0.27.1.
 */
const VLLM = "vllm-project/vllm";
const VLLM_RELEASES = [
	{ id: 9001, tag_name: "v0.27.1", name: "v0.27.1", html_url: `https://github.com/${VLLM}/releases/tag/v0.27.1`, body: "## Highlights\nFixes a regression in the V1 engine.", published_at: "2026-09-13T09:00:00Z", author: { login: "simon-mo" } },
	{ id: 9000, tag_name: "v0.27.0", name: "v0.27.0", html_url: `https://github.com/${VLLM}/releases/tag/v0.27.0`, body: "older", published_at: "2026-08-20T09:00:00Z", author: { login: "simon-mo" } },
	{ id: 8999, tag_name: "v0.26.0", name: "v0.26.0", html_url: `https://github.com/${VLLM}/releases/tag/v0.26.0`, body: "much older", published_at: "2026-07-01T09:00:00Z", author: { login: "simon-mo" } },
];

function vllmHandlers(opts: { tags?: Array<{ name: string; commit: { sha: string } }>; commitDates?: Record<string, string>; releasesEtag?: string } = {}) {
	const tags = opts.tags ?? VLLM_RELEASES.map((r) => ({ name: r.tag_name, commit: { sha: `sha-${r.tag_name}` } }));
	return vi.fn().mockImplementation(async (url: string) => {
		if (url.includes("/releases")) return jsonResponse(VLLM_RELEASES, { etag: opts.releasesEtag ?? '"rel-1"', "x-ratelimit-remaining": "100" });
		if (url.includes("/tags")) return jsonResponse(tags, { etag: '"tags-1"', "x-ratelimit-remaining": "100" });
		if (url.includes("/commits/")) {
			const sha = url.split("/commits/")[1] as string;
			const date = opts.commitDates?.[sha];
			if (!date) return jsonResponse({ message: "Not Found" }, {}, 404);
			return jsonResponse({ commit: { committer: { date } } }, { "x-ratelimit-remaining": "100" });
		}
		if (url.includes("/issues")) return jsonResponse([], { "x-ratelimit-remaining": "100" });
		throw new Error(`unexpected url ${url}`);
	});
}

describe("GitHubCollector narrowing", () => {
	it("collects a major watched-repo release (vLLM v0.27.1) while dropping the release history around it", async () => {
		const collector = new GitHubCollector({ repos: [VLLM] });
		const result = await collector.collect(makeCtx({ hasSecret: async () => true, since: new Date("2026-09-12T00:00:00Z") }, vllmHandlers() as unknown as typeof fetch));

		const releases = result.items.filter((i) => i.metadata["kind"] === "release");
		expect(releases.map((i) => i.metadata["tag"])).toEqual(["v0.27.1"]);
		const v = releases[0]!;
		expect(v.url).toBe(`https://github.com/${VLLM}/releases/tag/v0.27.1`);
		expect(v.publishedAt).toBe("2026-09-13T09:00:00Z");
		// The curator must be able to read it, not merely disposition it.
		expect(v.summary.length).toBeGreaterThan(0);
	});

	it("does not re-emit a release already reported on an earlier run", async () => {
		const collector = new GitHubCollector({ repos: [VLLM] });
		const ctxOpts = { hasSecret: async () => true, since: new Date("2026-09-12T00:00:00Z") };
		const first = await collector.collect(makeCtx(ctxOpts, vllmHandlers() as unknown as typeof fetch));
		expect(first.items.some((i) => i.metadata["tag"] === "v0.27.1")).toBe(true);

		// A different ETag forces the full page to be returned again, as GitHub does
		// whenever anything on it changes.
		const second = await collector.collect(
			makeCtx({ ...ctxOpts, cursor: first.cursor }, vllmHandlers({ releasesEtag: '"rel-2"' }) as unknown as typeof fetch),
		);
		expect(second.items.filter((i) => i.metadata["kind"] === "release")).toHaveLength(0);
	});

	it("never emits generic repository events", async () => {
		const eventTypes = ["WatchEvent", "ForkEvent", "IssueCommentEvent", "PushEvent", "CreateEvent"];
		const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
			if (url.includes("/events")) {
				return jsonResponse(
					eventTypes.map((type, i) => ({ id: `e${i}`, type, created_at: "2026-09-13T00:00:00Z", actor: { login: "bob" } })),
					{ "x-ratelimit-remaining": "100" },
				);
			}
			if (url.includes("/releases")) return jsonResponse([], { "x-ratelimit-remaining": "100" });
			if (url.includes("/tags")) return jsonResponse([], { "x-ratelimit-remaining": "100" });
			if (url.includes("/issues")) return jsonResponse([], { "x-ratelimit-remaining": "100" });
			throw new Error(`unexpected url ${url}`);
		});
		const collector = new GitHubCollector({ repos: [REPO] });
		const result = await collector.collect(makeCtx({ hasSecret: async () => true }, fetchImpl as unknown as typeof fetch));

		expect(result.items).toHaveLength(0);
		for (const type of eventTypes) {
			expect(result.items.some((i) => i.title.includes(type))).toBe(false);
		}
		expect(fetchImpl.mock.calls.some((call) => String(call[0]).includes("/events"))).toBe(false);
	});

	it("treats tag history as backfill on the first run and only reports a genuinely new tag afterwards", async () => {
		const repo = "acme/tagged";
		const history = [
			{ name: "v2.0.0", commit: { sha: "sha-2.0.0" } },
			{ name: "v1.9.0", commit: { sha: "sha-1.9.0" } },
			{ name: "nightly", commit: { sha: "sha-nightly" } },
		];
		const commitDates = {
			"sha-2.0.0": "2026-08-01T00:00:00Z",
			"sha-1.9.0": "2026-07-01T00:00:00Z",
			"sha-nightly": "2026-09-13T00:00:00Z",
			"sha-2.1.0": "2026-09-13T08:00:00Z",
		};
		const handlers = (tags: typeof history) =>
			vi.fn().mockImplementation(async (url: string) => {
				if (url.includes("/releases")) return jsonResponse([], { "x-ratelimit-remaining": "100" });
				if (url.includes("/tags")) return jsonResponse(tags, { "x-ratelimit-remaining": "100" });
				if (url.includes("/commits/")) {
					const sha = url.split("/commits/")[1] as string;
					return jsonResponse({ commit: { committer: { date: commitDates[sha as keyof typeof commitDates] } } }, { "x-ratelimit-remaining": "100" });
				}
				if (url.includes("/issues")) return jsonResponse([], { "x-ratelimit-remaining": "100" });
				throw new Error(`unexpected url ${url}`);
			});

		const collector = new GitHubCollector({ repos: [repo] });
		const first = await collector.collect(makeCtx({ hasSecret: async () => true }, handlers(history) as unknown as typeof fetch));
		// Seeding run: the whole tag history is remembered, none of it is news.
		expect(first.items).toHaveLength(0);

		const second = await collector.collect(makeCtx({ hasSecret: async () => true, cursor: first.cursor }, handlers(history) as unknown as typeof fetch));
		expect(second.items).toHaveLength(0);

		const withNew = [{ name: "v2.1.0", commit: { sha: "sha-2.1.0" } }, ...history];
		const third = await collector.collect(makeCtx({ hasSecret: async () => true, cursor: second.cursor }, handlers(withNew) as unknown as typeof fetch));
		const tagItems = third.items.filter((i) => i.metadata["kind"] === "tag");
		expect(tagItems).toHaveLength(1);
		expect(tagItems[0]!.externalId).toBe(`${repo}#tag-v2.1.0`);
		// The real commit date, never the fetch time.
		expect(tagItems[0]!.publishedAt).toBe("2026-09-13T08:00:00Z");
		// "nightly" is not version-shaped and is never a publication event.
		expect(third.items.some((i) => i.externalId.includes("nightly"))).toBe(false);
	});

	it("does not advance the issues watermark when the issues fetch was rate limited", async () => {
		const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
			if (url.includes("/issues")) return jsonResponse({ message: "rate limited" }, { "retry-after": "0" }, 429);
			if (url.includes("/releases")) return jsonResponse([], { "x-ratelimit-remaining": "100" });
			if (url.includes("/tags")) return jsonResponse([], { "x-ratelimit-remaining": "100" });
			throw new Error(`unexpected url ${url}`);
		});
		const collector = new GitHubCollector({ repos: [REPO] });
		const since = new Date("2026-09-01T00:00:00Z");
		const result = await collector.collect(makeCtx({ hasSecret: async () => true, since }, fetchImpl as unknown as typeof fetch));

		const cursor = JSON.parse(result.cursor as string) as Record<string, { issuesSince?: string }>;
		// The window was never read, so it must still be open next run.
		expect(cursor[REPO]?.issuesSince).toBeUndefined();
		expect(result.health).toBe("DEGRADED");
		expect(result.warnings.some((w) => w.includes("rate limited fetching issues"))).toBe(true);
	});

	it("advances the issues watermark only after a window was actually read", async () => {
		const collector = new GitHubCollector({ repos: [REPO] });
		const result = await collector.collect(makeCtx({ hasSecret: async () => true }, baseHandlers() as unknown as typeof fetch));
		const cursor = JSON.parse(result.cursor as string) as Record<string, { issuesSince?: string }>;
		// Advanced, but never past what the page actually contained: the newest
		// updated_at on it, not the local clock at the moment the cursor was written.
		expect(cursor[REPO]?.issuesSince).toBe("2026-09-12T00:00:00.000Z");
	});

	it("stamps the issues watermark from the response's own clock, not the local one", async () => {
		const SERVER_DATE = "Sat, 12 Sep 2026 12:00:00 GMT";
		const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
			if (url.includes("/releases")) return jsonResponse([], { "x-ratelimit-remaining": "100" });
			if (url.includes("/tags")) return jsonResponse([], { "x-ratelimit-remaining": "100" });
			if (url.includes("/issues")) {
				return jsonResponse([], { "x-ratelimit-remaining": "100", date: SERVER_DATE });
			}
			throw new Error(`unexpected url ${url}`);
		});
		const collector = new GitHubCollector({ repos: [REPO] });
		// The local clock is most of a day ahead of GitHub's. The old code wrote the local
		// clock, so everything GitHub updated in that span was skipped forever.
		const result = await collector.collect(
			makeCtx({ hasSecret: async () => true, now: () => new Date("2026-09-13T00:00:00Z") }, fetchImpl as unknown as typeof fetch),
		);

		const cursor = JSON.parse(result.cursor as string) as Record<string, { issuesSince?: string }>;
		expect(cursor[REPO]?.issuesSince).toBe(new Date(SERVER_DATE).toISOString());
		expect(Date.parse(cursor[REPO]?.issuesSince as string)).toBeLessThanOrEqual(Date.parse(SERVER_DATE));
	});

	it("collects an issue updated between the response and the cursor write on the next run", async () => {
		// GitHub builds the page at 12:00. The issue is updated at 12:00:30, i.e. after
		// that page existed but before this process gets around to writing the cursor,
		// which it does at 12:05 local time (a long body read, or the per-repo fan-out
		// descheduling this task). The next run must still see the issue.
		const PAGE_BUILT_AT = "Sat, 12 Sep 2026 12:00:00 GMT";
		const LATE_UPDATE = "2026-09-12T12:00:30.000Z";
		const CURSOR_WRITTEN_AT = new Date("2026-09-12T12:05:00Z");

		const lateIssue = {
			id: 200,
			number: 7,
			title: "Security hole",
			body: "details",
			html_url: "https://x/issues/7",
			state: "open",
			user: { login: "erin" },
			created_at: "2026-09-12T11:00:00Z",
			updated_at: LATE_UPDATE,
			labels: ["security"],
			reactions: { total_count: 0 },
		};

		const sinceParams: string[] = [];
		const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
			if (url.includes("/releases")) return jsonResponse([], { "x-ratelimit-remaining": "100" });
			if (url.includes("/tags")) return jsonResponse([], { "x-ratelimit-remaining": "100" });
			if (url.includes("/issues")) {
				const since = decodeURIComponent(new URL(url).searchParams.get("since") ?? "");
				sinceParams.push(since);
				// The server honours `since`: the late issue is only returned when the
				// watermark did not already step over it.
				const body = Date.parse(LATE_UPDATE) >= Date.parse(since) ? [lateIssue] : [];
				return jsonResponse(body, { "x-ratelimit-remaining": "100", date: PAGE_BUILT_AT });
			}
			throw new Error(`unexpected url ${url}`);
		});

		const collector = new GitHubCollector({ repos: [REPO] });
		const first = await collector.collect(
			makeCtx({ hasSecret: async () => true, now: () => CURSOR_WRITTEN_AT }, fetchImpl as unknown as typeof fetch),
		);

		const cursor = JSON.parse(first.cursor as string) as Record<string, { issuesSince?: string }>;
		const watermark = cursor[REPO]?.issuesSince as string;
		// The watermark may never be ahead of the moment the server generated the page.
		expect(Date.parse(watermark)).toBeLessThanOrEqual(Date.parse(PAGE_BUILT_AT));
		expect(Date.parse(watermark)).toBeLessThanOrEqual(Date.parse(LATE_UPDATE));

		const second = await collector.collect(
			makeCtx(
				{ hasSecret: async () => true, now: () => CURSOR_WRITTEN_AT, cursor: first.cursor },
				fetchImpl as unknown as typeof fetch,
			),
		);
		expect(second.items.map((i) => i.externalId)).toContain(`${REPO}#issue-7`);
		expect(sinceParams[1]).toBe(watermark);
	});

	it("falls back to the time captured before the request when the response carries no usable clock", async () => {
		const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
			if (url.includes("/releases")) return jsonResponse([], { "x-ratelimit-remaining": "100" });
			if (url.includes("/tags")) return jsonResponse([], { "x-ratelimit-remaining": "100" });
			// No usable Date header, and an empty page, so there is no updated_at either.
			if (url.includes("/issues")) return jsonResponse([], { "x-ratelimit-remaining": "100", date: "not-a-date" });
			throw new Error(`unexpected url ${url}`);
		});

		// now() advances on every call. A watermark taken after the body would land on a
		// later tick than the one captured before the request went out.
		const ticks = ["2026-09-13T00:00:00.000Z", "2026-09-13T00:10:00.000Z", "2026-09-13T00:20:00.000Z", "2026-09-13T00:30:00.000Z"];
		let tick = 0;
		const now = () => new Date(ticks[Math.min(tick++, ticks.length - 1)] as string);

		const collector = new GitHubCollector({ repos: [REPO] });
		const result = await collector.collect(makeCtx({ hasSecret: async () => true, now }, fetchImpl as unknown as typeof fetch));

		const cursor = JSON.parse(result.cursor as string) as Record<string, { issuesSince?: string }>;
		// startedAt consumes the first tick, so the pre-request capture is the second one.
		// The old code took a tick after the body instead, landing on 00:20 or later.
		expect(cursor[REPO]?.issuesSince).toBe("2026-09-13T00:10:00.000Z");
	});
});

describe("GitHubCollector concurrency", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	const repos = Array.from({ length: 8 }, (_, i) => `acme/repo-${i}`);

	function repoOf(url: string): string {
		return url.match(/\/repos\/([^/]+\/[^/?]+)/)?.[1] ?? "";
	}

	function slowHandlers(delayFor: (repo: string) => number) {
		let inFlight = 0;
		let peak = 0;
		const fetchImpl = vi.fn(async (url: string) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			const repo = repoOf(url);
			await new Promise((resolve) => setTimeout(resolve, delayFor(repo)));
			inFlight--;
			if (url.includes("/releases")) {
				return jsonResponse(
					[
						{
							id: 1,
							tag_name: "v1.0.0",
							name: `${repo} v1.0.0`,
							html_url: `https://x/${repo}/release/1`,
							body: "notes",
							published_at: "2026-09-10T00:00:00Z",
							author: { login: "alice" },
						},
					],
					{ "x-ratelimit-remaining": "100" },
				);
			}
			if (url.includes("/tags")) return jsonResponse([], { "x-ratelimit-remaining": "100" });
			return jsonResponse([], { "x-ratelimit-remaining": "100" });
		});
		return { fetchImpl, peak: () => peak };
	}

	it("polls several repos at once, capped at the collector concurrency limit", async () => {
		const { fetchImpl, peak } = slowHandlers(() => 20);
		const collector = new GitHubCollector({ repos });

		const promise = collector.collect(makeCtx({}, fetchImpl as unknown as typeof fetch));
		await vi.runAllTimersAsync();
		const result = await promise;

		expect(peak()).toBeGreaterThan(1);
		expect(peak()).toBeLessThanOrEqual(4);
		expect(result.items).toHaveLength(repos.length);
	});

	it("keeps items and the cursor in watchlist order when repos answer out of order", async () => {
		// Later repos answer sooner, so completion order is the reverse of input order.
		const { fetchImpl } = slowHandlers((repo) => (repos.length - repos.indexOf(repo)) * 5);
		const collector = new GitHubCollector({ repos });

		const promise = collector.collect(makeCtx({}, fetchImpl as unknown as typeof fetch));
		await vi.runAllTimersAsync();
		const result = await promise;

		expect(result.items.map((i) => i.metadata?.["repo"])).toEqual(repos);
		expect(Object.keys(JSON.parse(result.cursor ?? "{}"))).toEqual(repos);
	});
});
