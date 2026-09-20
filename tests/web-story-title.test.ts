import { describe, expect, it } from "vitest";
import type { BriefAppearance } from "../src/db/briefs.ts";
import type { StoryLedgerEntry } from "../src/schemas/index.ts";
import {
	storyDisplayDescription,
	storyDisplayTitle,
	timelineDisplayTitle,
} from "../web/lib/story-title.ts";

/*
 * The defect these cover, observed on production on 2026-09-20: the story page
 * for `us-military-ai-hallucination-aborted-china-operation` rendered its <h1>,
 * its <title> and its share card as "AI-hallucinated intelligence nearly
 * triggered a US operation against China" -- the curator's internal handle --
 * while every brief that published it, and the dashboard link the reader
 * followed to get there, read "AI 幻覺情報險觸發美軍對中行動".
 */

function appearance(over: Partial<BriefAppearance> = {}): BriefAppearance {
	return {
		date: "2026-09-20",
		section: "AI_LLM",
		mustKnow: true,
		title: "AI 幻覺情報險觸發美軍對中行動",
		whatHappened: "未標示不確定性的模型輸出進入正式決策流程，險些觸發行動。",
		whyItMatters: "這不是一般回答錯誤。",
		whatChanged: "首次公開。",
		impact: "決策鏈需要獨立驗證。",
		confidence: "HIGH",
		sourceItemIds: ["itm-1"],
		factRefs: [],
		...over,
	};
}

const LEDGER = {
	canonicalTitle: "AI-hallucinated intelligence nearly triggered a US operation against China",
	reason: "Cluster kept: model output reached a decision chain without an uncertainty marker.",
} satisfies Pick<StoryLedgerEntry, "canonicalTitle" | "reason">;

describe("storyDisplayTitle", () => {
	it("prefers the published editorial title over the ledger handle", () => {
		expect(storyDisplayTitle([appearance()], LEDGER)).toBe("AI 幻覺情報險觸發美軍對中行動");
	});

	it("uses the newest appearance when the framing changed across days", () => {
		// briefAppearancesForStory orders by date desc, so [0] is the newest.
		const newest = appearance({ date: "2026-09-20", title: "第四天的說法" });
		const oldest = appearance({ date: "2026-09-17", title: "第一天的說法" });
		expect(storyDisplayTitle([newest, oldest], LEDGER)).toBe("第四天的說法");
	});

	it("falls back to the ledger handle for a story no brief ever published", () => {
		expect(storyDisplayTitle([], LEDGER)).toBe(LEDGER.canonicalTitle);
	});
});

describe("storyDisplayDescription", () => {
	it("prefers the brief's account of the event over the curator's note", () => {
		expect(storyDisplayDescription([appearance()], LEDGER)).toBe(
			"未標示不確定性的模型輸出進入正式決策流程，險些觸發行動。",
		);
	});

	it("falls back to the ledger reason when the story was never published", () => {
		expect(storyDisplayDescription([], LEDGER)).toBe(LEDGER.reason);
	});
});

describe("timelineDisplayTitle", () => {
	it("shows how each day was published, not how the story reads now", () => {
		const dayOne = appearance({ date: "2026-09-17", title: "第一天的說法" });
		expect(timelineDisplayTitle(dayOne, LEDGER)).toBe("第一天的說法");
	});

	it("keeps the ledger handle for a day the story was tracked but not published", () => {
		expect(timelineDisplayTitle(undefined, LEDGER)).toBe(LEDGER.canonicalTitle);
	});
});

describe("identity is not presentation", () => {
	it("never lets a display title stand in for the id a URL is built from", async () => {
		const source = await import("node:fs/promises").then((fs) =>
			fs.readFile(new URL("../web/app/story/[id]/page.tsx", import.meta.url), "utf8"),
		);
		// The canonical URL and every story link must be built from the id.
		expect(source).toContain("canonical: `/story/${encodeURIComponent(storyId)}`");
		expect(source).toContain("href={`/story/${encodeURIComponent(entry.storyId)}`}");
		// And the raw ledger handle must no longer be rendered as the page heading.
		expect(source).not.toContain("<h1>{latest.canonicalTitle}</h1>");
	});
});
