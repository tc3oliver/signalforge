import { describe, expect, it } from "vitest";
import type { DailyBrief, DailyBriefStory } from "../src/schemas/brief.ts";
import type { StructuredFact } from "../src/schemas/fact.ts";
import {
	buildAnchors,
	buildBriefSections,
	collectFactRefs,
	collectSourceItemIds,
	SECTION_ORDER,
	slugify,
} from "../web/lib/sections.ts";
import { factLine, formatFactValue, resolveFactRefs } from "../web/lib/facts.ts";
import {
	changeTypeLabel,
	confidenceDisplay,
	confidenceLevelFromScore,
	dispositionLabel,
	formatDateKey,
	formatDuration,
	formatInstant,
	formatScore,
	sectionLabel,
	shiftDateKey,
	signalStateLabel,
} from "../web/lib/format.ts";
import { displayHost, escapeHtml, escapeXmlText, preview, safeExternalUrl } from "../web/lib/untrusted.ts";
import { buildBriefFeedXml } from "../web/lib/feed.ts";

function story(over: Partial<DailyBriefStory> = {}): DailyBriefStory {
	return {
		storyId: "st-1",
		section: "AI_LLM",
		mustKnow: false,
		title: "A story",
		whatHappened: "something happened",
		whyItMatters: "it matters",
		whatChanged: "it changed",
		impact: "impact",
		confidence: "HIGH",
		sourceItemIds: ["it-1"],
		factRefs: [],
		...over,
	};
}

function brief(over: Partial<DailyBrief> = {}): DailyBrief {
	return {
		date: "2026-09-13",
		producedAt: "2026-09-13T06:10:30.000Z",
		stories: [story()],
		emergingSignals: [],
		dailyAnalysis: "analysis",
		watchNext: ["watch this"],
		...over,
	};
}

describe("brief section assembly", () => {
	it("emits sections in the fixed published order", () => {
		const sections = buildBriefSections(
			brief({
				stories: [
					story({ storyId: "c", section: "COMPANIES", title: "Companies story" }),
					story({ storyId: "a", section: "AI_LLM", title: "AI story" }),
					story({ storyId: "m", section: "MACRO", title: "Macro story" }),
					story({ storyId: "k", section: "MUST_KNOW", mustKnow: true, title: "Headline" }),
					story({ storyId: "d", section: "DEVELOPER_OSS", title: "Dev story" }),
					story({ storyId: "r", section: "RESEARCH", title: "Research story" }),
					story({ storyId: "x", section: "CRYPTO_MARKET", title: "Crypto story" }),
				],
				emergingSignals: [{ label: "Signal", body: "body", storyIds: ["a"] }],
			}),
		);
		expect(sections.map((s) => s.key)).toEqual([...SECTION_ORDER]);
	});

	it("omits a section with no stories entirely rather than rendering it empty", () => {
		const sections = buildBriefSections(
			brief({ stories: [story({ section: "AI_LLM" })] }),
		);
		const keys = sections.map((s) => s.key);
		expect(keys).toContain("AI_LLM");
		// Every other topical section had no story and must not appear at all.
		expect(keys).not.toContain("RESEARCH");
		expect(keys).not.toContain("COMPANIES");
		expect(keys).not.toContain("MACRO");
		expect(keys).not.toContain("CRYPTO_MARKET");
		expect(keys).not.toContain("DEVELOPER_OSS");
		expect(keys).not.toContain("MUST_KNOW");
		// And no section view is ever emitted with an empty story list.
		for (const section of sections) {
			if (section.kind === "stories") expect(section.stories.length).toBeGreaterThan(0);
		}
	});

	it("omits emerging signals, analysis and watch-next when they have no content", () => {
		const sections = buildBriefSections(
			brief({ emergingSignals: [], dailyAnalysis: "   ", watchNext: ["  "] }),
		);
		const keys = sections.map((s) => s.key);
		expect(keys).not.toContain("EMERGING_SIGNALS");
		expect(keys).not.toContain("DAILY_ANALYSIS");
		expect(keys).not.toContain("WATCH_NEXT");
	});

	it("shows must-know as links plus full text only for stories filed under MUST_KNOW", () => {
		const sections = buildBriefSections(
			brief({
				stories: [
					story({ storyId: "k", section: "MUST_KNOW", mustKnow: true, title: "Filed must know" }),
					story({ storyId: "a", section: "AI_LLM", mustKnow: true, title: "Flagged must know" }),
					story({ storyId: "b", section: "AI_LLM", title: "Ordinary" }),
				],
			}),
		);
		const mustKnow = sections.find((s) => s.kind === "must-know");
		expect(mustKnow).toBeDefined();
		if (mustKnow?.kind !== "must-know") throw new Error("expected a must-know section");
		expect(mustKnow.highlights.map((h) => h.storyId)).toEqual(["k", "a"]);
		// The flagged AI story keeps its topical home; only MUST_KNOW-filed stories
		// are rendered in full here, matching src/renderer/markdown.ts.
		expect(mustKnow.stories.map((s) => s.storyId)).toEqual(["k"]);
		const ai = sections.find((s) => s.key === "AI_LLM");
		if (ai?.kind !== "stories") throw new Error("expected an AI section");
		expect(ai.stories.map((s) => s.storyId)).toEqual(["a", "b"]);
	});

	it("gives colliding titles distinct anchors", () => {
		const anchors = buildAnchors([
			story({ storyId: "one", title: "Same Title" }),
			story({ storyId: "two", title: "Same Title" }),
		]);
		expect(anchors.get("one")).toBe("same-title");
		expect(anchors.get("two")).toBe("same-title-1");
		expect(slugify("!!!")).toBe("story");
	});

	it("collects fact refs and source ids without duplicates", () => {
		const b = brief({
			stories: [
				story({ storyId: "a", factRefs: ["f1", "f2"], sourceItemIds: ["i1", "i2"] }),
				story({ storyId: "b", factRefs: ["f2"], sourceItemIds: ["i2", "i3"] }),
			],
		});
		expect(collectFactRefs(b)).toEqual(["f1", "f2"]);
		expect(collectSourceItemIds(b)).toEqual(["i1", "i2", "i3"]);
	});
});

describe("facts are rendered from the store, never from prose", () => {
	const fact: StructuredFact = {
		factId: "fact-btc-usd",
		kind: "crypto",
		label: "BTC spot",
		value: 71482.35,
		unit: " USD",
		asOf: "2026-09-13T00:05:00.000Z",
		sourceItemId: "it-btc-print",
		previousValue: 70910.12,
		changePct: 0.81,
	};

	it("resolves a factRef to the stored canonical value", () => {
		const [resolved] = resolveFactRefs(["fact-btc-usd"], [fact]);
		expect(resolved?.status).toBe("resolved");
		if (resolved?.status !== "resolved") throw new Error("expected a resolved fact");
		expect(formatFactValue(resolved.fact)).toBe("71,482.35 USD");
		const line = factLine(resolved.fact);
		expect(line.previous).toBe("70,910.12 USD");
		expect(line.change).toBe("+0.81%");
		expect(line.sourceItemId).toBe("it-btc-print");
	});

	it("reports an unknown factRef as missing and never substitutes a number", () => {
		const [missing] = resolveFactRefs(["fact-nope"], [fact]);
		expect(missing).toEqual({ factId: "fact-nope", status: "missing" });
		expect(JSON.stringify(missing)).not.toMatch(/\d[\d,.]*\s*(USD|%)/);
	});

	it("preserves the stored value exactly, including integers and negatives", () => {
		expect(formatFactValue({ ...fact, value: 2.4, unit: "%" })).toBe("2.4%");
		expect(formatFactValue({ ...fact, value: 1000000, unit: "" })).toBe("1,000,000");
		expect(factLine({ ...fact, changePct: -11.11 }).change).toBe("-11.11%");
	});
});

describe("display mappings", () => {
	it("maps confidence levels to the renderer's labels", () => {
		expect(confidenceDisplay("HIGH")).toEqual({ label: "高", level: "HIGH", tone: "ok" });
		expect(confidenceDisplay("MEDIUM")).toEqual({ label: "中", level: "MEDIUM", tone: "warn" });
		expect(confidenceDisplay("LOW")).toEqual({ label: "低", level: "LOW", tone: "bad" });
	});

	it("buckets a 0..1 ledger confidence into the brief's three levels", () => {
		expect(confidenceLevelFromScore(0.9)).toBe("HIGH");
		expect(confidenceLevelFromScore(0.5)).toBe("MEDIUM");
		expect(confidenceLevelFromScore(0.1)).toBe("LOW");
	});

	it("formats dates and instants deterministically in UTC", () => {
		expect(formatDateKey("2026-09-13")).toBe("2026 年 9 月 13 日（日）");
		expect(formatDateKey("not-a-date")).toBe("not-a-date");
		expect(formatInstant("2026-09-13T06:10:30.000Z")).toBe("2026-09-13 06:10 UTC");
		expect(formatInstant(undefined)).toBe("—");
		expect(shiftDateKey("2026-09-01", -1)).toBe("2026-08-31");
		expect(shiftDateKey("bad", 1)).toBeUndefined();
	});

	it("formats scores and durations", () => {
		expect(formatScore(0.732)).toBe("73%");
		expect(formatScore(undefined)).toBe("—");
		expect(formatDuration(450)).toBe("450ms");
		expect(formatDuration(12_300)).toBe("12.3s");
		expect(formatDuration(330_000)).toBe("5m 30s");
	});

	it("labels change types, sections, signal states and dispositions", () => {
		expect(changeTypeLabel("NO_MATERIAL_CHANGE")).toBe("無實質新進展");
		expect(sectionLabel("DEVELOPER_OSS")).toBe("開發工具 / Open Source");
		expect(signalStateLabel("strengthening")).toBe("持續增強");
		// Dispositions are admin-only trace wording and stay in English.
		expect(dispositionLabel("DUPLICATE")).toContain("duplicate");
		// A missing decision is a coverage gap, not a verdict about the item.
		expect(dispositionLabel(undefined)).toContain("Never scanned");
	});
});

describe("untrusted source content", () => {
	const hostile = '<img src=x onerror="alert(1)"> Rust & "friends"';

	it("escapes every HTML metacharacter in source-derived text", () => {
		const escaped = escapeHtml(hostile);
		expect(escaped).not.toContain("<img");
		expect(escaped).not.toContain('"');
		expect(escaped).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
		// The ampersand must be escaped once, not double-escaped.
		expect(escaped).toContain("Rust &amp; ");
		expect(escapeHtml("a & b")).toBe("a &amp; b");
	});

	it("strips control characters that would break an XML document", () => {
		expect(escapeXmlText("safe text")).toBe("safetext");
	});

	it("refuses any URL scheme other than http(s)", () => {
		expect(safeExternalUrl("https://example.invalid/a")).toBe("https://example.invalid/a");
		expect(safeExternalUrl("javascript:alert(document.domain)")).toBeUndefined();
		expect(safeExternalUrl("data:text/html,<script>alert(1)</script>")).toBeUndefined();
		expect(safeExternalUrl("  ")).toBeUndefined();
		expect(safeExternalUrl(undefined)).toBeUndefined();
		expect(displayHost("https://news.example.invalid/x")).toBe("news.example.invalid");
		expect(displayHost("javascript:alert(1)")).toBeUndefined();
	});

	it("collapses and clips prose previews", () => {
		expect(preview("a\n\n  b  ")).toBe("a b");
		expect(preview("abcdefghij", 5)).toBe("abcd…");
	});

	it("escapes untrusted headlines in the hand-built feed", () => {
		const xml = buildBriefFeedXml(
			[
				{
					date: "2026-09-13",
					producedAt: "2026-09-13T06:10:30.000Z",
					storyCount: 9,
					mustKnowCount: 2,
					sections: ["AI_LLM"],
					signalCount: 1,
					headline: hostile,
				},
			],
			{ baseUrl: "http://127.0.0.1:3300" },
		);
		expect(xml).toContain("<?xml version=\"1.0\" encoding=\"utf-8\"?>");
		expect(xml).toContain("&lt;img src=x");
		// No unescaped markup from source text may reach the document.
		expect(xml).not.toContain("<img");
		expect(xml).not.toContain('onerror="alert(1)"');
		expect(xml).toContain("http://127.0.0.1:3300/brief/2026-09-13");
	});
});
