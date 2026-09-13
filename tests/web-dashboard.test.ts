import { describe, expect, it } from "vitest";
import type { DailyBrief, DailyBriefStory } from "../src/schemas/brief.ts";
import type { StoryLedgerEntry } from "../src/schemas/story.ts";
import type { EmergingSignal } from "../src/db/signals.ts";
import type { LateItem } from "../src/db/items.ts";
import {
	buildDashboard,
	DASHBOARD_LIMITS,
	importanceLevelFromScore,
	isUpdateChange,
	leadSentences,
	splitSentences,
} from "../web/lib/dashboard.ts";
import { formatClock, formatDateBanner } from "../web/lib/format.ts";

/*
 * The dashboard is a pure derivation of published rows. These tests pin that
 * it adds nothing: the hero is the analysis's opening, the takeaway is the
 * story's own "why it matters", counts are counts, and a missing input yields
 * an honest empty state rather than a filler.
 */

function story(over: Partial<DailyBriefStory> = {}): DailyBriefStory {
	return {
		storyId: "st-1",
		section: "AI_LLM",
		mustKnow: false,
		title: "A story",
		whatHappened: "Something happened in detail. Then more happened.",
		whyItMatters: "It matters because of X. It also matters because of Y.",
		whatChanged: "it changed",
		impact: "impact",
		confidence: "HIGH",
		sourceItemIds: ["it-1", "it-2", "it-3"],
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
		dailyAnalysis: "First sentence of the analysis. Second sentence, longer. Third one here.",
		watchNext: ["watch this"],
		...over,
	};
}

function ledger(over: Partial<StoryLedgerEntry> = {}): StoryLedgerEntry {
	return {
		storyId: "st-1",
		date: "2026-09-13",
		canonicalTitle: "A story",
		sourceItemIds: ["it-1"],
		primarySourceIds: ["it-1"],
		firstSeenAt: "2026-09-13T05:00:00.000Z",
		lastSeenAt: "2026-09-13T05:00:00.000Z",
		status: "OPEN",
		changeType: "NEW",
		relevance: 0.9,
		novelty: 0.9,
		importance: 0.8,
		confidence: 0.9,
		reason: "reason",
		factRefs: [],
		...over,
	};
}

function signalRecord(over: Partial<EmergingSignal> = {}): EmergingSignal {
	return {
		signalId: "sig-1",
		label: "A signal",
		rationale: "why",
		state: "strengthening",
		confidence: 0.8,
		firstSeenAt: "2026-09-11T05:00:00.000Z",
		lastSeenAt: "2026-09-13T05:00:00.000Z",
		storyIds: ["st-1"],
		...over,
	};
}

function late(over: Partial<LateItem> = {}): LateItem {
	return {
		itemId: "late-1",
		title: "Late item",
		summary: "a long summary that must not reach the dashboard",
		sourceName: "Example",
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

function build(over: Partial<Parameters<typeof buildDashboard>[0]> = {}) {
	return buildDashboard({
		brief: brief(),
		ledger: [ledger()],
		signalRecords: [],
		lateItems: [],
		...over,
	});
}

describe("sentence helpers", () => {
	it("splits on CJK and ASCII terminators without breaking version numbers", () => {
		expect(splitSentences("今日重點。第二句！第三句？")).toEqual(["今日重點。", "第二句！", "第三句？"]);
		expect(splitSentences("Homebrew 7.0.0 shipped. Next one.")).toEqual([
			"Homebrew 7.0.0 shipped.",
			"Next one.",
		]);
	});

	it("takes whole leading sentences that fit, never a partial one", () => {
		const text = "Short one. This second sentence is quite a bit longer than the first.";
		expect(leadSentences(text, 20)).toBe("Short one.");
		expect(leadSentences(text, 200)).toBe(text);
		expect(leadSentences(text, 200, 1)).toBe("Short one.");
	});

	it("clips a single over-long sentence with an ellipsis rather than returning nothing", () => {
		const long = "x".repeat(50);
		const out = leadSentences(long, 10);
		expect(out.endsWith("…")).toBe(true);
		expect(out.length).toBeLessThanOrEqual(10);
	});
});

describe("hero", () => {
	it("uses the opening of the editor's analysis and nothing else", () => {
		const view = build();
		expect(view.hero.summary).toBe("First sentence of the analysis. Second sentence, longer.");
		expect(view.hero.summary.length).toBeLessThanOrEqual(DASHBOARD_LIMITS.heroChars);
	});

	it("counts stories, must-know, updates, signals and late items", () => {
		const view = build({
			brief: brief({
				stories: [
					story({ storyId: "a", mustKnow: true }),
					story({ storyId: "b", mustKnow: true }),
					story({ storyId: "c" }),
				],
				emergingSignals: [{ label: "S", body: "b", storyIds: ["a"] }],
			}),
			ledger: [
				ledger({ storyId: "a", changeType: "NEW" }),
				ledger({ storyId: "b", changeType: "UPDATE" }),
				ledger({ storyId: "c", changeType: "ESCALATION" }),
			],
			lateItems: [late({ itemId: "l1" }), late({ itemId: "l2" })],
		});
		expect(view.hero.stats).toEqual({
			stories: 3,
			mustKnow: 2,
			updates: 2,
			signals: 1,
			newSinceMorning: 2,
		});
	});

	it("does not count NEW or NO_MATERIAL_CHANGE as an update", () => {
		expect(isUpdateChange("NEW")).toBe(false);
		expect(isUpdateChange("NO_MATERIAL_CHANGE")).toBe(false);
		expect(isUpdateChange(undefined)).toBe(false);
		expect(isUpdateChange("CONFIRMATION")).toBe(true);
	});

	it("formats the banner date and the feed clock in UTC", () => {
		expect(formatDateBanner("2026-09-13")).toBe("9 月 13 日 · 星期日");
		expect(formatDateBanner("nonsense")).toBe("nonsense");
		expect(formatClock("2026-09-13T12:29:41.000Z")).toBe("12:29");
	});
});

describe("must know", () => {
	it("ranks must-know stories in editor order and carries only card fields", () => {
		const view = build({
			brief: brief({
				stories: [
					story({ storyId: "c", section: "COMPANIES", mustKnow: true, title: "Third" }),
					story({ storyId: "a", mustKnow: true, title: "First listed" }),
					story({ storyId: "b", mustKnow: false, title: "Not must know" }),
				],
			}),
			ledger: [ledger({ storyId: "c", importance: 0.9 }), ledger({ storyId: "a", importance: 0.5 })],
		});
		expect(view.mustKnow.map((c) => [c.rank, c.storyId])).toEqual([
			[1, "c"],
			[2, "a"],
		]);
		const first = view.mustKnow[0];
		expect(first?.importance).toBe("HIGH");
		expect(view.mustKnow[1]?.importance).toBe("MEDIUM");
		expect(first?.takeaway).toBe("It matters because of X.");
		expect(first?.sourceCount).toBe(3);
		// The full prose fields are not part of the card at all.
		expect(Object.keys(first ?? {})).not.toContain("whatHappened");
		expect(Object.keys(first ?? {})).not.toContain("impact");
	});

	it("leaves importance and change type undefined when the ledger has no row", () => {
		const view = build({ brief: brief({ stories: [story({ mustKnow: true })] }), ledger: [] });
		expect(view.mustKnow[0]?.importance).toBeUndefined();
		expect(view.mustKnow[0]?.changeType).toBeUndefined();
	});

	it("buckets the ledger's importance score for display only", () => {
		expect(importanceLevelFromScore(0.75)).toBe("HIGH");
		expect(importanceLevelFromScore(0.6)).toBe("MEDIUM");
		expect(importanceLevelFromScore(0.1)).toBe("LOW");
	});
});

describe("what changed", () => {
	it("orders by strength of change, editor order within a kind, and caps the list", () => {
		const stories = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => story({ storyId: id }));
		const view = build({
			brief: brief({ stories }),
			ledger: [
				ledger({ storyId: "a", changeType: "NEW" }),
				ledger({ storyId: "b", changeType: "UPDATE" }),
				ledger({ storyId: "c", changeType: "ESCALATION" }),
				ledger({ storyId: "d", changeType: "NO_MATERIAL_CHANGE" }),
				ledger({ storyId: "e", changeType: "RESOLUTION" }),
				ledger({ storyId: "f", changeType: "NEW" }),
				ledger({ storyId: "g", changeType: "CONFIRMATION" }),
				ledger({ storyId: "h", changeType: "REVERSAL" }),
			],
		});
		expect(view.changes.map((r) => r.storyId)).toEqual(["c", "h", "e", "b", "g", "a"]);
		expect(view.changes.length).toBe(DASHBOARD_LIMITS.changes);
		expect(view.changes.map((r) => r.changeType)).not.toContain("NO_MATERIAL_CHANGE");
	});

	it("is empty, not padded, when nothing moved", () => {
		const view = build({ ledger: [ledger({ changeType: "NO_MATERIAL_CHANGE" })] });
		expect(view.changes).toEqual([]);
	});

	it("skips a story with no ledger row rather than inventing a change type", () => {
		const view = build({ ledger: [] });
		expect(view.changes).toEqual([]);
	});
});

describe("emerging signals", () => {
	it("is empty when the brief carries none", () => {
		expect(build().signals).toEqual([]);
	});

	it("counts stories and distinct cited sources, and joins the tracked record by label", () => {
		const view = build({
			brief: brief({
				stories: [
					story({ storyId: "a", sourceItemIds: ["i1", "i2"] }),
					story({ storyId: "b", sourceItemIds: ["i2", "i3"] }),
					story({ storyId: "c", sourceItemIds: ["i9"] }),
				],
				emergingSignals: [{ label: "A signal", body: "Body one. Body two. Body three.", storyIds: ["a", "b"] }],
			}),
			signalRecords: [signalRecord()],
		});
		const signal = view.signals[0];
		expect(signal?.storyCount).toBe(2);
		expect(signal?.sourceCount).toBe(3);
		expect(signal?.state).toBe("strengthening");
		expect(signal?.confidence).toBe("HIGH");
		expect(signal?.daySpan).toBe(3);
		expect(signal?.summary).toBe("Body one. Body two.");
	});

	it("shows no state or confidence when no tracked record matches", () => {
		const view = build({
			brief: brief({ emergingSignals: [{ label: "Untracked", body: "b", storyIds: [] }] }),
		});
		expect(view.signals[0]?.state).toBeUndefined();
		expect(view.signals[0]?.confidence).toBeUndefined();
		expect(view.signals[0]?.daySpan).toBeUndefined();
	});
});

describe("compact sections", () => {
	it("keeps topical order, omits empty sections, and reports overflow", () => {
		const many = Array.from({ length: 6 }, (_, i) => story({ storyId: `d${i}`, section: "DEVELOPER_OSS" }));
		const view = build({
			brief: brief({
				stories: [story({ storyId: "m", section: "MACRO" }), ...many],
			}),
		});
		expect(view.sections.map((s) => s.key)).toEqual(["DEVELOPER_OSS", "MACRO"]);
		const dev = view.sections[0];
		expect(dev?.rows.length).toBe(DASHBOARD_LIMITS.sectionRows);
		expect(dev?.overflow).toBe(6 - DASHBOARD_LIMITS.sectionRows);
		expect(dev?.total).toBe(6);
		expect(view.sections[1]?.overflow).toBe(0);
	});

	it("uses the real cited source count on every row", () => {
		const view = build({
			brief: brief({ stories: [story({ sourceItemIds: ["x"] }), story({ storyId: "y", sourceItemIds: ["a", "b", "c", "d"] })] }),
		});
		expect(view.sections[0]?.rows.map((r) => r.sourceCount)).toEqual([1, 4]);
	});
});

describe("new since morning", () => {
	it("keeps the total but shows at most three, with no summary or scores", () => {
		const items = Array.from({ length: 6 }, (_, i) => late({ itemId: `l${i}` }));
		const view = build({ lateItems: items });
		expect(view.newSinceMorning.total).toBe(6);
		expect(view.newSinceMorning.items.length).toBe(DASHBOARD_LIMITS.lateItems);
		const keys = Object.keys(view.newSinceMorning.items[0] ?? {});
		expect(keys).not.toContain("summary");
		expect(keys).not.toContain("importance");
	});

	it("is an empty feed when nothing arrived", () => {
		expect(build().newSinceMorning).toEqual({ total: 0, capped: false, items: [] });
	});

	it("flags the count as a floor when the read hit its fetch limit", () => {
		const items = Array.from({ length: DASHBOARD_LIMITS.lateItemsFetch }, (_, i) => late({ itemId: `l${i}` }));
		expect(build({ lateItems: items }).newSinceMorning.capped).toBe(true);
		expect(build({ lateItems: items.slice(1) }).newSinceMorning.capped).toBe(false);
	});
});

describe("analysis and watch next", () => {
	it("previews the analysis and marks it truncated only when it is", () => {
		const short = build({ brief: brief({ dailyAnalysis: "One line." }) });
		expect(short.analysis.truncated).toBe(false);
		const long = build({
			brief: brief({ dailyAnalysis: `${"A sentence. ".repeat(60)}` }),
		});
		expect(long.analysis.truncated).toBe(true);
		expect(long.analysis.preview.length).toBeLessThanOrEqual(DASHBOARD_LIMITS.analysisChars);
	});

	it("drops blank watch-next entries and keeps the rest verbatim", () => {
		const view = build({ brief: brief({ watchNext: ["  ", "Watch A", "Watch B "] }) });
		expect(view.watchNext).toEqual(["Watch A", "Watch B"]);
	});
});
