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
		expect(html).toContain("SEP 13 · SUNDAY");
		expect(html).toContain("Today in 60 seconds");
		expect(html).toContain("HERO_OPENING_SENTENCE.");
		expect(html).toMatch(/<strong>3<\/strong> stories/);
		expect(html).toMatch(/<strong>2<\/strong> must know/);
		expect(html).toMatch(/<strong>1<\/strong> update/);
		expect(html).toMatch(/<strong>1<\/strong> signal/);
	});

	it("puts hero, must know, what changed and the signal before anything else", () => {
		const order = [
			html.indexOf("Today in 60 seconds"),
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
		expect(html).toContain("Importance </span>HIGH");
		expect(html).toContain(">New<");
		expect(html).toContain(">Update<");
		expect(html).toContain("External evaluation may become the norm.");
		expect(html).toContain("3 sources");
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
		expect(block).toContain(">Update<");
		expect(block).toContain(">New<");
	});

	it("links into the section on the full brief when a section overflows", () => {
		const many = Array.from({ length: 6 }, (_, i) =>
			story({ storyId: `r${i}`, section: "RESEARCH", mustKnow: false, title: `Paper ${i}` }),
		);
		const out = render({ brief: { ...brief, stories: [...brief.stories, ...many] } });
		expect(out).toContain('href="/brief/2026-09-13#section-RESEARCH"');
		expect(out).toContain("View all 6");
	});

	it("has no link into /admin", () => {
		expect(html).not.toContain("/admin");
	});
});

describe("Today page empty states", () => {
	it("says so when nothing changed and omits the signal block when there is none", () => {
		const out = render({
			brief: { ...brief, emergingSignals: [] },
			ledger: [ledger({ changeType: "NO_MATERIAL_CHANGE" })],
		});
		expect(out).toContain("No material changes since the previous brief.");
		expect(out).not.toContain('id="emerging-signals"');
		expect(out).not.toContain("Emerging signal");
	});

	it("shows a capped late-item count as a floor", () => {
		const items = Array.from({ length: 200 }, (_, i) => late({ itemId: `l${i}` }));
		const out = render({ lateItems: items });
		expect(out).toContain("200+");
		expect(out).toContain("At least 197 more collected");
	});

	it("omits the inbox entirely when nothing arrived after the morning run", () => {
		const out = render({ lateItems: [] });
		expect(out).not.toContain('id="new-since-morning"');
		expect(out).not.toContain("new since morning");
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
