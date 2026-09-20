import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBriefFeedXml } from "../web/lib/feed.ts";
import type { BriefSummary } from "../src/db/briefs.ts";

/*
 * These cover the four things a crawler reads before it reads any content, all
 * of which were wrong in production on 2026-09-20: robots.txt and sitemap.xml
 * both answered 404, the share card's absolute image URL resolved to
 * `http://localhost:3300`, and every Atom entry id was `https://0.0.0.0:3300/…`.
 *
 * `web/lib/site.ts` reads the environment once at module load, so each case
 * that needs a different origin resets the module registry and re-imports it.
 */
async function siteModule(origin: string | undefined) {
	vi.resetModules();
	if (origin === undefined) delete process.env["SIGNALFORGE_SITE_URL"];
	else process.env["SIGNALFORGE_SITE_URL"] = origin;
	return import("../web/lib/site.ts");
}

const ORIGINAL = process.env["SIGNALFORGE_SITE_URL"];

afterEach(() => {
	if (ORIGINAL === undefined) delete process.env["SIGNALFORGE_SITE_URL"];
	else process.env["SIGNALFORGE_SITE_URL"] = ORIGINAL;
	vi.resetModules();
});

describe("site origin", () => {
	it("uses the configured public origin for absolute URLs", async () => {
		const { SITE_ORIGIN, absoluteUrl } = await siteModule("https://signal.meowcoder.com");
		expect(SITE_ORIGIN).toBe("https://signal.meowcoder.com");
		expect(absoluteUrl("/sitemap.xml")).toBe("https://signal.meowcoder.com/sitemap.xml");
	});

	it("strips a trailing slash or path so URLs never double up", async () => {
		const { absoluteUrl } = await siteModule("https://signal.meowcoder.com/");
		expect(absoluteUrl("/feed.xml")).toBe("https://signal.meowcoder.com/feed.xml");
	});

	it("falls back to the dev origin rather than throwing on a malformed value", async () => {
		const { SITE_ORIGIN } = await siteModule("not a url");
		expect(SITE_ORIGIN).toBe("http://localhost:3300");
	});

	it("recognises the bind addresses that are legal to listen on and useless to publish", async () => {
		const { isLoopbackOrigin } = await siteModule("https://signal.meowcoder.com");
		// 0.0.0.0 is the one that actually shipped: a valid URL, and unreachable
		// for every reader who received it in a feed.
		expect(isLoopbackOrigin("https://0.0.0.0:3300")).toBe(true);
		expect(isLoopbackOrigin("http://127.0.0.1:3300")).toBe(true);
		expect(isLoopbackOrigin("http://localhost:3300")).toBe(true);
		expect(isLoopbackOrigin("https://signal.meowcoder.com")).toBe(false);
	});
});

describe("robots.txt", () => {
	it("allows crawling, points at the sitemap, and keeps /search and /admin out", async () => {
		await siteModule("https://signal.meowcoder.com");
		const robots = (await import("../web/app/robots.ts")).default();
		const rule = robots.rules;
		expect(rule.allow).toBe("/");
		expect(rule.disallow).toContain("/search");
		expect(rule.disallow).toContain("/admin");
		expect(robots.sitemap).toBe("https://signal.meowcoder.com/sitemap.xml");
		// The route must resolve the origin at request time: built statically it
		// baked in the dev fallback and shipped a localhost sitemap pointer.
		const mod = await import("../web/app/robots.ts");
		expect(mod.dynamic).toBe("force-dynamic");
	});
});

describe("feed absolute URLs", () => {
	const briefs: BriefSummary[] = [
		{
			date: "2026-09-20",
			producedAt: "2026-09-19T21:49:16.596Z",
			storyCount: 11,
			mustKnowCount: 5,
			sections: ["AI_LLM"],
			signalCount: 3,
			headline: "AI 幻覺情報險觸發美軍對中行動",
		},
	];

	it("builds entry ids on the configured public origin", () => {
		const xml = buildBriefFeedXml(briefs, { baseUrl: "https://signal.meowcoder.com" });
		expect(xml).toContain("<id>https://signal.meowcoder.com/brief/2026-09-20</id>");
		expect(xml).toContain('href="https://signal.meowcoder.com/feed.xml"');
		// The exact string that shipped, and that a subscriber would have stored.
		expect(xml).not.toContain("0.0.0.0");
		expect(xml).not.toContain("localhost");
	});
});
