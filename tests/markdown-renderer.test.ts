import { describe, expect, it } from "vitest";
import { renderBriefMarkdown } from "../src/renderer/markdown.ts";
import type { DailyBrief, DailyBriefStory } from "../src/schemas/brief.ts";
import type { StructuredFact } from "../src/schemas/fact.ts";
import type { NormalizedItem } from "../src/schemas/item.ts";

const items: NormalizedItem[] = [
	{
		id: "item-1",
		sourceType: "rss",
		sourceName: "The Verge",
		title: "Model launch",
		summary: "",
		url: "https://example.com/a",
		publishedAt: "2026-09-13T00:00:00.000Z",
		metadata: {},
	},
	{
		id: "item-2",
		sourceType: "github",
		sourceName: "GitHub",
		title: "Repo release",
		summary: "",
		publishedAt: "2026-09-13T00:00:00.000Z",
		metadata: {},
	},
];

const facts: StructuredFact[] = [
	{
		factId: "fact-btc",
		kind: "crypto",
		label: "BTC 收盤價",
		value: 64250.5,
		unit: "USD",
		asOf: "2026-09-13T00:00:00.000Z",
		sourceItemId: "item-1",
		previousValue: 61000,
		changePct: 5.33,
	},
];

function story(over: Partial<DailyBriefStory>): DailyBriefStory {
	return {
		storyId: "s1",
		section: "AI_LLM",
		mustKnow: false,
		title: "標題",
		whatHappened: "發生了什麼",
		whyItMatters: "為何重要",
		whatChanged: "有什麼變化",
		impact: "影響",
		confidence: "HIGH",
		sourceItemIds: ["item-1"],
		factRefs: [],
		...over,
	};
}

function brief(stories: DailyBriefStory[], over: Partial<DailyBrief> = {}): DailyBrief {
	return {
		date: "2026-09-13",
		producedAt: "2026-09-13T02:00:00.000Z",
		stories,
		emergingSignals: [],
		dailyAnalysis: "今日總結",
		watchNext: ["觀察 A", "觀察 B"],
		...over,
	};
}

const ALL_SECTION_HEADINGS = [
	"## Must Know",
	"## AI / LLM",
	"## Developer / Open Source",
	"## Research",
	"## Crypto / Market",
	"## Macro",
	"## Companies",
	"## Emerging Signals",
	"## Daily Analysis",
	"## Watch Next",
];

describe("renderBriefMarkdown", () => {
	it("emits sections in the fixed order", () => {
		const stories = [
			story({ storyId: "s1", section: "COMPANIES", title: "公司" }),
			story({ storyId: "s2", section: "AI_LLM", title: "模型", mustKnow: true }),
			story({ storyId: "s3", section: "MACRO", title: "宏觀" }),
			story({ storyId: "s4", section: "RESEARCH", title: "研究" }),
			story({ storyId: "s5", section: "CRYPTO_MARKET", title: "加密" }),
			story({ storyId: "s6", section: "DEVELOPER_OSS", title: "開源" }),
		];
		const md = renderBriefMarkdown(
			brief(stories, {
				emergingSignals: [{ label: "訊號", body: "內容", storyIds: ["s1"] }],
			}),
			{ facts, items },
		);
		const positions = ALL_SECTION_HEADINGS.map((h) => md.indexOf(h));
		expect(positions.every((p) => p >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});

	it("omits a section that has no story instead of padding it", () => {
		const md = renderBriefMarkdown(
			brief([story({ storyId: "s1", section: "AI_LLM", mustKnow: true })]),
			{ facts, items },
		);
		expect(md).toContain("## AI / LLM");
		expect(md).not.toContain("## Research");
		expect(md).not.toContain("## Macro");
		expect(md).not.toContain("## Companies");
		expect(md).not.toContain("## Emerging Signals");
	});

	it("renders Must Know as a compact anchor list and keeps the story in its topical section", () => {
		const md = renderBriefMarkdown(
			brief([
				story({ storyId: "s1", section: "AI_LLM", title: "模型上線", mustKnow: true }),
				story({ storyId: "s2", section: "MACRO", title: "利率決議" }),
			]),
			{ facts, items },
		);
		expect(md).toContain("## Must Know\n\n- [模型上線](#模型上線)");
		// The full entry lives under its topical heading, not duplicated in Must Know.
		const mustKnowBlock = md.slice(md.indexOf("## Must Know"), md.indexOf("## AI / LLM"));
		expect(mustKnowBlock).not.toContain("### 模型上線");
		expect(md).toContain("## AI / LLM\n\n### 模型上線");
		expect(md).not.toContain("- [利率決議]");
	});

	it("renders every sub-label for a story", () => {
		const md = renderBriefMarkdown(
			brief([story({ mustKnow: true, sourceItemIds: ["item-1", "item-2"] })]),
			{ facts, items },
		);
		expect(md).toContain("**什麼發生了**：發生了什麼");
		expect(md).toContain("**為何重要**：為何重要");
		expect(md).toContain("**有什麼變化**：有什麼變化");
		expect(md).toContain("**影響**：影響");
		expect(md).toContain("**信心**：高");
		expect(md).toContain("**來源**：");
		expect(md).toContain("- The Verge：Model launch (https://example.com/a)");
		expect(md).toContain("- GitHub：Repo release");
		expect(md).not.toContain("Repo release (");
	});

	it("renders numeric facts from the store, not from story prose", () => {
		const md = renderBriefMarkdown(
			brief([
				story({
					section: "CRYPTO_MARKET",
					mustKnow: true,
					whatHappened: "BTC 大漲到 99999 美元",
					factRefs: ["fact-btc"],
				}),
			]),
			{ facts, items },
		);
		expect(md).toContain("- BTC 收盤價: 64250.5USD (as of 2026-09-13T00:00:00.000Z)");
		expect(md).toContain("前值 61000USD");
		expect(md).toContain("變化 5.33%");
		// The prose number is echoed verbatim but is never the source of the fact line.
		expect(md).not.toContain("99999USD");
		expect(md.match(/64250\.5/g)).toHaveLength(1);
	});

	it("throws on an unknown factRef", () => {
		expect(() =>
			renderBriefMarkdown(brief([story({ mustKnow: true, factRefs: ["fact-missing"] })]), {
				facts,
				items,
			}),
		).toThrow(/unknown factRef "fact-missing"/);
	});

	it("is deterministic across repeated renders", () => {
		const input = brief([
			story({ storyId: "s1", section: "AI_LLM", title: "模型", mustKnow: true, factRefs: ["fact-btc"] }),
			story({ storyId: "s2", section: "MACRO", title: "宏觀" }),
		]);
		const a = renderBriefMarkdown(input, { facts, items });
		const b = renderBriefMarkdown(input, { facts, items });
		expect(a).toBe(b);
		expect(a).not.toMatch(/2026-09-13T02:00:00/);
	});
});
