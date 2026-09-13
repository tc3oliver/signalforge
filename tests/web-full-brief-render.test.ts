import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DailyBrief, DailyBriefStory } from "../src/schemas/brief.ts";
import type { StoryLedgerEntry } from "../src/schemas/story.ts";
import { UNTRUSTED_EXTERNAL_CONTENT, type NormalizedItem } from "../src/schemas/item.ts";
import { FullBriefView } from "../web/components/brief-view.tsx";
import { TodayDashboard } from "../web/components/dashboard/today-dashboard.tsx";
import { buildDashboard } from "../web/lib/dashboard.ts";
import type { BriefPageData } from "../web/lib/queries.ts";

/*
 * The Today page is a dashboard; /brief/[date] is the archive. This checks the
 * two remain different views of the same rows: the full brief keeps every
 * long-form field the dashboard deliberately withholds, and both open the
 * same way. The other reader routes are checked to still exist with their
 * own page modules, so a redesign of Today cannot quietly take them along.
 */

function story(over: Partial<DailyBriefStory> = {}): DailyBriefStory {
	return {
		storyId: "st-1",
		section: "AI_LLM",
		mustKnow: true,
		title: "Labs agree to slow frontier development",
		whatHappened: "FULL_WHAT_HAPPENED_TEXT.",
		whyItMatters: "External evaluation may become the norm. And a second sentence.",
		whatChanged: "FULL_WHAT_CHANGED_TEXT.",
		impact: "FULL_IMPACT_TEXT.",
		confidence: "HIGH",
		sourceItemIds: ["it-1", "it-2"],
		factRefs: [],
		...over,
	};
}

function ledger(over: Partial<StoryLedgerEntry> = {}): StoryLedgerEntry {
	return {
		storyId: "st-1",
		date: "2026-09-13",
		canonicalTitle: "x",
		sourceItemIds: ["it-1"],
		primarySourceIds: ["it-1"],
		firstSeenAt: "2026-09-13T05:00:00.000Z",
		lastSeenAt: "2026-09-13T05:00:00.000Z",
		status: "OPEN",
		changeType: "UPDATE",
		relevance: 0.9,
		novelty: 0.9,
		importance: 0.85,
		confidence: 0.9,
		reason: "reason",
		factRefs: [],
		...over,
	};
}

function item(id: string): NormalizedItem {
	return {
		id,
		sourceType: "rss",
		sourceName: "Example Feed",
		title: `ITEM_TITLE_${id}`,
		summary: "s",
		url: `https://example.com/${id}`,
		publishedAt: "2026-09-13T01:00:00.000Z",
		metadata: {},
		trust: UNTRUSTED_EXTERNAL_CONTENT,
	};
}

const brief: DailyBrief = {
	date: "2026-09-13",
	producedAt: "2026-09-13T06:10:30.000Z",
	stories: [story(), story({ storyId: "st-2", section: "COMPANIES", mustKnow: false, title: "IPO timeline moves out" })],
	emergingSignals: [{ label: "Safety coordination is becoming institutional", body: "Three labs now share evaluators.", storyIds: ["st-1"] }],
	dailyAnalysis: "HERO_OPENING_SENTENCE. Second sentence.",
	watchNext: ["Watch for formal adoption by other labs."],
};

const data: BriefPageData = {
	brief,
	facts: [],
	items: [item("it-1"), item("it-2")],
	lateItems: [],
	ledger: [ledger(), ledger({ storyId: "st-2", changeType: "NEW" })],
	signalRecords: [],
	neighbours: { previous: "2026-09-12", next: undefined },
};

describe("full brief view", () => {
	const html = renderToStaticMarkup(createElement(FullBriefView, { data }));

	it("opens like the dashboard: hero, then must know", () => {
		const hero = html.indexOf('id="today-hero"');
		const mustKnow = html.indexOf('class="must-know"');
		const firstArticle = html.indexOf('class="story"');
		expect(hero).toBeGreaterThan(-1);
		expect(mustKnow).toBeGreaterThan(hero);
		expect(firstArticle).toBeGreaterThan(mustKnow);
	});

	it("still renders every long-form field per story", () => {
		for (const text of ["FULL_WHAT_HAPPENED_TEXT", "FULL_WHAT_CHANGED_TEXT", "FULL_IMPACT_TEXT"]) {
			expect(html).toContain(text);
		}
		for (const label of ["What happened", "Why it matters", "What changed", "Impact", "Sources"]) {
			expect(html).toContain(label);
		}
		expect(html).toContain("ITEM_TITLE_it-1");
		expect(html).toContain("ITEM_TITLE_it-2");
	});

	it("keeps the pager to neighbouring published briefs only", () => {
		expect(html).toContain('href="/brief/2026-09-12"');
		expect(html).not.toContain('href="/brief/2026-09-14"');
	});
});

describe("dashboard and full brief are distinct views", () => {
	it("withholds on Today what the full brief shows", () => {
		const view = buildDashboard({ brief, ledger: data.ledger, signalRecords: [], lateItems: [] });
		const today = renderToStaticMarkup(createElement(TodayDashboard, { view }));
		const full = renderToStaticMarkup(createElement(FullBriefView, { data }));
		expect(today).not.toContain("FULL_WHAT_HAPPENED_TEXT");
		expect(today).not.toContain("ITEM_TITLE_it-1");
		expect(full).toContain("FULL_WHAT_HAPPENED_TEXT");
		expect(today).toContain('href="/brief/2026-09-13"');
	});
});

describe("reader routes survive the redesign", () => {
	const root = new URL("../web/app/", import.meta.url).pathname;
	const routes: Record<string, string> = {
		"/": "page.tsx",
		"/brief/[date]": "brief/[date]/page.tsx",
		"/story/[id]": "story/[id]/page.tsx",
		"/history": "history/page.tsx",
		"/signals": "signals/page.tsx",
		"/search": "search/page.tsx",
		"/admin": "admin/page.tsx",
		"/feed.xml": "feed.xml/route.ts",
	};

	for (const [route, file] of Object.entries(routes)) {
		it(`${route} has its own module`, () => {
			const path = root + file;
			expect(existsSync(path), path).toBe(true);
			const source = readFileSync(path, "utf8");
			expect(source).toMatch(/export (default|async function GET|function GET)/);
		});
	}

	it("only the full brief page uses the full brief view", () => {
		const users = ["page.tsx", "brief/[date]/page.tsx"].map((f) => readFileSync(root + f, "utf8"));
		expect(users[0]).toContain("TodayDashboard");
		expect(users[0]).not.toContain("FullBriefView");
		expect(users[1]).toContain("FullBriefView");
		expect(users[1]).not.toContain("TodayDashboard");
	});
});
