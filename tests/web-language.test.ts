import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DailyBrief, DailyBriefStory } from "../src/schemas/brief.ts";
import type { StoryLedgerEntry } from "../src/schemas/story.ts";
import type { EmergingSignal } from "../src/db/signals.ts";
import type { LateItem } from "../src/db/items.ts";
import { buildDashboard } from "../web/lib/dashboard.ts";
import { TodayDashboard } from "../web/components/dashboard/today-dashboard.tsx";
import { FullBriefView } from "../web/components/brief-view.tsx";
import type { BriefPageData } from "../web/lib/queries.ts";
import {
	changeTypeLabel,
	changeTypeShortLabel,
	confidenceLabel,
	formatDateKey,
	formatInstant,
	importanceLabel,
	sectionLabel,
	signalStateLabel,
	storyStatusLabel,
} from "../web/lib/format.ts";
import { buildBriefFeedXml } from "../web/lib/feed.ts";

/*
 * The reader is Traditional Chinese for a Taiwanese engineer. These tests pin
 * the section labels a reader sees and forbid the English working names and
 * raw enum values from leaking onto public pages. They check labels, not the
 * whole page: a full-page snapshot would break on every layout change and
 * prove nothing about wording.
 *
 * Admin pages are out of scope on purpose: they may show raw enums.
 */

function story(over: Partial<DailyBriefStory> = {}): DailyBriefStory {
	return {
		storyId: "st-1",
		section: "AI_LLM",
		mustKnow: true,
		title: "vLLM 0.12 釋出，FP8 KV cache 預設開啟",
		whatHappened: "WHAT_HAPPENED_TEXT",
		whyItMatters: "自架推論的記憶體壓力下降。",
		whatChanged: "WHAT_CHANGED_TEXT",
		impact: "IMPACT_TEXT",
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

const signalRecord: EmergingSignal = {
	signalId: "sg-1",
	label: "Agent 安全治理開始跨公司對齊",
	rationale: "rationale",
	storyIds: ["st-1"],
	state: "emerging",
	confidence: 0.3,
	firstSeenAt: "2026-09-13T05:00:00.000Z",
	lastSeenAt: "2026-09-13T05:00:00.000Z",
};

const lateItems: LateItem[] = Array.from({ length: 40 }, (_, i) => ({
	itemId: `late-${i}`,
	title: `LATE_${i}`,
	summary: "s",
	sourceName: "Feed",
	sourceType: "rss",
	url: "https://example.com/x",
	publishedAt: "2026-09-13T12:00:00.000Z",
	fetchedAt: "2026-09-13T12:29:00.000Z",
	disposition: undefined,
	storyId: undefined,
	importance: undefined,
	changeType: undefined,
}));

const brief: DailyBrief = {
	date: "2026-09-13",
	producedAt: "2026-09-13T06:00:00.000Z",
	stories: [
		story(),
		story({ storyId: "st-2", section: "CRYPTO_MARKET", mustKnow: false, title: "CLARITY Act 修正案進入表決" }),
		story({ storyId: "st-3", section: "COMPANIES", mustKnow: false, title: "智譜完成 50 億美元融資" }),
	],
	emergingSignals: [{ label: signalRecord.label, body: "Signal body.", storyIds: ["st-1"] }],
	dailyAnalysis: "今天沒有重大模型發布。Agent 安全研究是最值得看的主題。",
	watchNext: ["GitHub 是否發布事後分析"],
} as DailyBrief;

const view = buildDashboard({
	brief,
	ledger: [ledger(), ledger({ storyId: "st-2", changeType: "ESCALATION", importance: 0.5 })],
	signalRecords: [signalRecord],
	lateItems,
});
const today = renderToStaticMarkup(createElement(TodayDashboard, { view }));

const fullData: BriefPageData = {
	brief,
	facts: [],
	items: [],
	lateItems,
	ledger: [ledger()],
	signalRecords: [signalRecord],
	neighbours: { previous: undefined, next: undefined },
} as unknown as BriefPageData;
const full = renderToStaticMarkup(createElement(FullBriefView, { data: fullData }));

const ENGLISH_WORKING_NAMES = [
	"Must Know",
	"Must know",
	"What Happened",
	"What happened",
	"Why It Matters",
	"Why it matters",
	"Emerging Signal",
	"Emerging signal",
	"New Since Morning",
	"New since morning",
	"High confidence",
	"Medium confidence",
	"Low confidence",
	"Today in 60 seconds",
	"Daily analysis",
	"Watch next",
	"Full brief",
];

/** Raw enum values that must stay behind the admin gate. */
const RAW_ENUMS = [">HIGH<", ">MEDIUM<", ">LOW<", ">NEW<", ">UPDATE<", ">ESCALATION<", "NO_MATERIAL_CHANGE"];

describe("public reader wording", () => {
	it("uses the agreed Chinese section labels on Today", () => {
		for (const label of ["60 秒掌握今天", "今日必看", "最新變化", "值得觀察的趨勢", "今日觀察", "接下來關注", "今日新增"]) {
			expect(today).toContain(label);
		}
	});

	it("shows no English working names on Today or the full day page", () => {
		for (const name of ENGLISH_WORKING_NAMES) {
			expect(today).not.toContain(name);
			expect(full).not.toContain(name);
		}
	});

	it("never calls the product a 簡報 in its own copy", () => {
		expect(today).not.toContain("簡報");
		expect(full).not.toContain("簡報");
	});

	it("keeps raw enum values off the public pages", () => {
		for (const raw of RAW_ENUMS) {
			expect(today).not.toContain(raw);
			expect(full).not.toContain(raw);
		}
	});

	it("keeps established technical terms in English inside section names", () => {
		expect(sectionLabel("AI_LLM")).toBe("AI / LLM");
		expect(sectionLabel("DEVELOPER_OSS")).toBe("開發工具 / Open Source");
		expect(sectionLabel("CRYPTO_MARKET")).toBe("Crypto / Web3");
		expect(sectionLabel("MACRO")).toBe("總體經濟");
		expect(sectionLabel("COMPANIES")).toBe("產業動態");
		expect(today).toContain("Crypto / Web3");
	});

	it("shows the hero without a late-item backlog count", () => {
		const hero = today.slice(today.indexOf('class="hero"'), today.indexOf('id="must-know"'));
		expect(hero).not.toContain("40");
		expect(hero).not.toContain("new since morning");
		expect(hero).not.toContain("今日新增");
		expect(hero).not.toContain('href="#new-since-morning"');
	});

	it("caps the inbox at three items and does not state the remainder as a number", () => {
		const inbox = today.slice(today.indexOf('id="new-since-morning"'));
		expect(inbox.match(/LATE_\d+/g)?.length).toBe(3);
		expect(inbox).toContain("其餘項目會在下一次整理時處理。");
		expect(inbox).not.toMatch(/\b37\b/);
	});

	it("labels the signal with 可信度 and its evidence, not with a confidence enum", () => {
		const card = today.slice(today.indexOf('class="signal-card"'), today.indexOf('id="section-AI_LLM"'));
		expect(card).toContain("可信度");
		expect(card).toContain("目前依據");
		expect(card).toContain("1 個事件");
		expect(card).toContain("1 天");
		expect(card).not.toContain("Confidence");
		expect(card).not.toContain("Evidence");
	});
});

describe("presentation mappings", () => {
	it("maps every change type to natural Chinese, long and short", () => {
		expect(changeTypeLabel("NEW")).toBe("新事件");
		expect(changeTypeLabel("UPDATE")).toBe("新進展");
		expect(changeTypeLabel("ESCALATION")).toBe("情勢升高");
		expect(changeTypeLabel("RESOLUTION")).toBe("已告一段落");
		expect(changeTypeLabel("REVERSAL")).toBe("出現反轉");
		expect(changeTypeLabel("CONFIRMATION")).toBe("已確認");
		expect(changeTypeLabel("RUMOR")).toBe("尚未證實");
		expect(changeTypeLabel("NO_MATERIAL_CHANGE")).toBe("無實質新進展");
		expect(changeTypeShortLabel("ESCALATION")).toBe("升溫");
		expect(changeTypeShortLabel("RUMOR")).toBe("未證實");
		// The badge carries the full wording as a tooltip.
		expect(today).toContain('title="情勢升高">升溫<');
	});

	it("maps importance and confidence to reader words, never 信心", () => {
		expect(importanceLabel("HIGH")).toBe("重要");
		expect(importanceLabel("MEDIUM")).toBe("一般");
		expect(importanceLabel("LOW")).toBe("次要");
		expect(confidenceLabel("HIGH")).toBe("可信度高");
		expect(confidenceLabel("MEDIUM")).toBe("可信度中等");
		expect(confidenceLabel("LOW")).toBe("可信度低");
		expect(today).not.toContain("信心");
	});

	it("maps story status and signal state", () => {
		expect(storyStatusLabel("OPEN")).toBe("追蹤中");
		expect(signalStateLabel("emerging")).toBe("剛浮現");
		expect(signalStateLabel("fading")).toBe("逐漸淡出");
	});

	it("formats dates the way a Taiwanese reader writes them", () => {
		expect(formatDateKey("2026-09-13")).toBe("2026 年 9 月 13 日（日）");
		expect(formatInstant("2026-09-13T06:05:00.000Z")).toBe("2026-09-13 06:05 UTC");
	});

	it("keeps the feed summary in Chinese", () => {
		const xml = buildBriefFeedXml(
			[{ date: "2026-09-13", producedAt: brief.producedAt, storyCount: 3, mustKnowCount: 1, signalCount: 1, headline: "h", sections: [] }],
			{ baseUrl: "http://127.0.0.1:3300" },
		);
		expect(xml).toContain("3 則事件，1 則必看：h");
		expect(xml).not.toContain("must-know");
	});
});

describe("sentence joining", () => {
	it("does not insert a half-width space after a full-width terminator", async () => {
		const { leadSentences } = await import("../web/lib/dashboard.ts");
		expect(leadSentences("第一句。第二句。", 200)).toBe("第一句。第二句。");
		expect(leadSentences("First. Second.", 200)).toBe("First. Second.");
	});
});

describe("short lead-in openers", () => {
	it("clips the second sentence in when the first is a short lead-in that says nothing", async () => {
		const { leadSentences, SHORT_LEAD_CHARS } = await import("../web/lib/dashboard.ts");
		const lead = "今日呈現出強烈對比。";
		const body = "一方面，前沿 AI 競爭出現重大轉折：".repeat(12) + "結束。";
		expect(lead.length).toBeLessThan(SHORT_LEAD_CHARS);
		const out = leadSentences(`${lead}${body}`, 200);
		expect(out.startsWith(`${lead}一方面，前沿 AI`)).toBe(true);
		expect(out.endsWith("…")).toBe(true);
		expect(out.length).toBeLessThanOrEqual(200);
	});

	it("leaves a first sentence alone when it already carries content or is the only one", async () => {
		const { leadSentences } = await import("../web/lib/dashboard.ts");
		const full = "今天沒有重大模型發布，較值得注意的是 Agent 安全研究與 GitHub 的基礎設施事故。";
		expect(leadSentences(`${full}${"很長的第二句".repeat(40)}。`, 200)).toBe(full);
		expect(leadSentences("短句。", 200)).toBe("短句。");
	});
});
