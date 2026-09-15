import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DailyBrief, DailyBriefStory } from "../src/schemas/brief.ts";
import type { StoryLedgerEntry } from "../src/schemas/story.ts";
import type { LateItem } from "../src/db/items.ts";
import { buildDashboard } from "../web/lib/dashboard.ts";
import { TodayDashboard } from "../web/components/dashboard/today-dashboard.tsx";

/*
 * Renders the real Today components to static HTML and checks the page's
 * shape: what comes first, what is absent, and that the markup has nothing a
 * narrow screen cannot wrap. The view model is tested separately; this is
 * about what a reader actually receives.
 */

function story(over: Partial<DailyBriefStory> = {}): DailyBriefStory {
	return {
		storyId: "st-1",
		section: "AI_LLM",
		mustKnow: true,
		title: "Labs agree to slow frontier development",
		whatHappened: "FULL_WHAT_HAPPENED_TEXT that belongs on the story page only.",
		whyItMatters: "External evaluation may become the norm. And a second sentence.",
		whatChanged: "FULL_WHAT_CHANGED_TEXT",
		impact: "FULL_IMPACT_TEXT",
		confidence: "HIGH",
		sourceItemIds: ["it-1", "it-2", "it-3"],
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
		changeType: "NEW",
		relevance: 0.9,
		novelty: 0.9,
		importance: 0.85,
		confidence: 0.9,
		reason: "reason",
		factRefs: [],
		...over,
	};
}

function late(over: Partial<LateItem> = {}): LateItem {
	return {
		itemId: "late-1",
		title: "LATE_ITEM_TITLE",
		summary: "LATE_ITEM_SUMMARY_MUST_NOT_RENDER",
		sourceName: "Example Feed",
		sourceType: "rss",
		url: "https://example.com/a",
		publishedAt: "2026-09-13T12:00:00.000Z",
		fetchedAt: "2026-09-13T12:29:00.000Z",
		disposition: undefined,
		storyId: undefined,
		importance: 0.7,
		changeType: undefined,
		...over,
	};
}

const brief: DailyBrief = {
	date: "2026-09-13",
	producedAt: "2026-09-13T06:10:30.000Z",
	stories: [
		story(),
		story({ storyId: "st-2", section: "DEVELOPER_OSS", title: "GitHub outage root cause", mustKnow: true }),
		story({ storyId: "st-3", section: "COMPANIES", title: "IPO timeline moves out", mustKnow: false }),
	],
	emergingSignals: [{ label: "Safety coordination is becoming institutional", body: "Three labs now share evaluators.", storyIds: ["st-1"] }],
	dailyAnalysis: "HERO_OPENING_SENTENCE. A second sentence of analysis.",
	watchNext: ["Watch for formal adoption by other labs."],
};

function render(over: Partial<Parameters<typeof buildDashboard>[0]> = {}): string {
	const view = buildDashboard({
		brief,
		ledger: [ledger(), ledger({ storyId: "st-2", changeType: "UPDATE" }), ledger({ storyId: "st-3" })],
		signalRecords: [],
		lateItems: [late()],
		...over,
	});
	return renderToStaticMarkup(createElement(TodayDashboard, { view }));
}

describe("Today page markup", () => {
	const html = render();

	it("opens with the hero: date, label, the analysis opening, and counts", () => {
		expect(html).toContain("9 月 13 日 · 星期日");
		expect(html).toContain("60 秒掌握今天");
		expect(html).toContain("HERO_OPENING_SENTENCE.");
		expect(html).toMatch(/<strong>3<\/strong> 則事件/);
		expect(html).toMatch(/<strong>2<\/strong> 則必看/);
		expect(html).toMatch(/<strong>1<\/strong> 則有新進展/);
		expect(html).toMatch(/<strong>1<\/strong> 個值得觀察的趨勢/);
	});

	it("puts hero, must know, what changed and the signal before anything else", () => {
		const order = [
			html.indexOf("60 秒掌握今天"),
			html.indexOf('id="must-know"'),
			html.indexOf('id="what-changed"'),
			html.indexOf('id="emerging-signals"'),
			html.indexOf('id="section-AI_LLM"'),
			html.indexOf('id="new-since-morning"'),
		];
		for (let i = 1; i < order.length; i++) {
			expect(order[i - 1]).toBeGreaterThanOrEqual(0);
			expect(order[i]).toBeGreaterThan(order[i - 1] ?? -1);
		}
	});

	it("keeps the inbox after the brief content and shows no summaries or scores in it", () => {
		expect(html.indexOf('id="new-since-morning"')).toBeGreaterThan(html.indexOf('id="watch-next"'));
		expect(html).toContain("LATE_ITEM_TITLE");
		expect(html).not.toContain("LATE_ITEM_SUMMARY_MUST_NOT_RENDER");
		expect(html).toContain("12:29");
	});

	it("renders must-know as ranked cards with badges, one takeaway and a source count", () => {
		expect(html).toContain(">01<");
		expect(html).toContain(">02<");
		// Every card here is already one of the day's most important, so an
		// importance chip on each one says nothing. The reader pages do not show it.
		expect(html).not.toContain("重要程度");
		expect(html).toContain(">新<");
		expect(html).toContain(">更新<");
		expect(html).toContain("External evaluation may become the norm.");
		expect(html).toContain("3 個來源");
		expect(html).toContain('href="/story/st-1#story-sources"');
	});

	it("never expands full story prose on the dashboard", () => {
		expect(html).not.toContain("FULL_WHAT_HAPPENED_TEXT");
		expect(html).not.toContain("FULL_WHAT_CHANGED_TEXT");
		expect(html).not.toContain("FULL_IMPACT_TEXT");
		// Individual sources are counted, not listed.
		expect(html).not.toContain('class="sources"');
		expect(html).not.toContain(">trace<");
	});

	it("shows what changed as one line per change with a text badge", () => {
		const block = html.slice(html.indexOf('id="what-changed"'), html.indexOf('id="emerging-signals"'));
		expect(block).toContain("GitHub outage root cause");
		expect(block).toContain(">更新<");
		expect(block).toContain(">新<");
	});

	it("links into the section on the full brief when a section overflows", () => {
		const many = Array.from({ length: 6 }, (_, i) =>
			story({ storyId: `r${i}`, section: "RESEARCH", mustKnow: false, title: `Paper ${i}` }),
		);
		const out = render({ brief: { ...brief, stories: [...brief.stories, ...many] } });
		expect(out).toContain('href="/brief/2026-09-13#section-RESEARCH"');
		expect(out).toContain("全部 6 則");
	});

	it("has no link into /admin", () => {
		expect(html).not.toContain("/admin");
	});
});

describe("Today page day in review", () => {
	it("closes the page with what the run read, from recorded counts only", () => {
		const out = render({
			workload: {
				itemsScanned: 1243,
				sources: 9,
				dispositions: { IRRELEVANT: 1180, DUPLICATE: 41, CANDIDATE: 22 },
			},
			ledger: [ledger(), ledger({ storyId: "st-9", changeType: "NO_MATERIAL_CHANGE" })],
		});
		expect(out).toContain('id="day-in-review"');
		expect(out).toContain("<strong>1,243</strong> 則項目");
		expect(out).toContain("<strong>9</strong> 個來源");
		expect(out).toContain("<strong>1,180</strong> 則與追蹤的主題無關");
		expect(out).toContain("<strong>41</strong> 則是重複報導");
		expect(out).toContain("<strong>3</strong> 則事件");
		expect(out).toContain("<strong>1</strong> 則只是舊聞再報導");
		// 3 of 1,243, rounded up so a tiny share never reads as 0%.
		expect(out).toContain("<strong>1%</strong>");
		// It is the last section: after the inbox, before the full-brief link.
		expect(out.indexOf('id="day-in-review"')).toBeGreaterThan(out.indexOf("watch-next"));
		expect(out.indexOf('id="day-in-review"')).toBeLessThan(out.indexOf('class="full-brief"'));
	});

	it("omits the paragraph when the day left no run record", () => {
		expect(render()).not.toContain('id="day-in-review"');
		expect(render({ workload: { itemsScanned: 0, sources: 0, dispositions: {} } })).not.toContain(
			'id="day-in-review"',
		);
	});
});

describe("Today page empty states", () => {
	it("says so when nothing changed and omits the signal block when there is none", () => {
		const out = render({
			brief: { ...brief, emergingSignals: [] },
			ledger: [ledger({ changeType: "NO_MATERIAL_CHANGE" })],
		});
		expect(out).toContain("與前一天相比，沒有實質變化。");
		expect(out).not.toContain('id="emerging-signals"');
		expect(out).not.toContain("值得觀察的趨勢");
	});

	it("never shows the late-item backlog as a number, however large it is", () => {
		const items = Array.from({ length: 200 }, (_, i) => late({ itemId: `l${i}` }));
		const out = render({ lateItems: items });
		expect(out).not.toContain("200");
		expect(out).not.toContain("197");
		expect(out).toContain("其餘項目會在下一次整理時處理。");
		// Only the first few items are listed.
		expect(out.match(/class="inbox-time"/g)?.length).toBe(3);
	});

	it("omits the inbox entirely when nothing arrived after the morning run", () => {
		const out = render({ lateItems: [] });
		expect(out).not.toContain('id="new-since-morning"');
		expect(out).not.toContain("今日新增");
	});
});

describe("Today page mobile-safe markup", () => {
	const html = render();

	it("uses no fixed pixel widths, tables or inline styles that would prevent wrapping", () => {
		expect(html).not.toMatch(/style="[^"]*width:\s*\d+px/);
		expect(html).not.toContain("<table");
		expect(html).not.toContain("<iframe");
	});

	it("keeps a single h1 and a sensible heading hierarchy", () => {
		expect(html.match(/<h1\b/g)?.length).toBe(1);
		expect(html.indexOf("<h2")).toBeGreaterThan(html.indexOf("<h1"));
		expect(html.indexOf("<h3")).toBeGreaterThan(html.indexOf("<h2"));
	});
});
