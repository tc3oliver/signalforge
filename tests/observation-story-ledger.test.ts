import { describe, expect, it } from "vitest";
import {
	amplifiedTokens,
	ledgerTelemetry,
	listSavings,
	overlap,
	residualPairs,
	type LedgerEvent,
} from "../src/observation/story-ledger.ts";
import type { StoryLedgerEntry } from "../src/schemas/index.ts";

/*
 * The measurement that decides whether the story-ledger change worked.
 *
 * It has to be trustworthy in a specific way: it must not flatter the change it
 * is measuring. So these pin that a fire the model declined is counted as
 * declined, that a merge which happened BEFORE the warning is not counted as
 * acceptance, and that a pair surviving to the ledger is reported whether or not
 * the check ever fired on it.
 */

function entry(over: Partial<StoryLedgerEntry> & { storyId: string; canonicalTitle: string }): StoryLedgerEntry {
	return {
		date: "2026-09-19",
		sourceItemIds: ["rss-1"],
		primarySourceIds: ["rss-1"],
		factRefs: [],
		topicIds: [],
		firstSeenAt: "2026-09-19T00:00:00.000Z",
		lastSeenAt: "2026-09-19T00:00:00.000Z",
		status: "OPEN",
		changeType: "NEW",
		relevance: 0.5,
		novelty: 0.5,
		importance: 0.5,
		confidence: 0.5,
		reason: "because",
		...over,
	} as StoryLedgerEntry;
}

describe("overlap", () => {
	it("measures how much of the asking title the other accounts for", () => {
		expect(overlap("OpenAI ships Astra for Law", "OpenAI ships Astra for Law, confirmed")).toBe(1);
		expect(overlap("jemalloc 5.4.0 released", "OpenAI ships Astra for Law")).toBe(0);
	});

	it("is zero for a title with no usable tokens rather than dividing by zero", () => {
		expect(overlap("", "anything")).toBe(0);
	});
});

describe("residualPairs", () => {
	const entries = [
		entry({ storyId: "openai-astra-for-law", canonicalTitle: "OpenAI ships Astra for Law", sourceItemIds: ["rss-1"] }),
		entry({ storyId: "jemalloc-5-4-0", canonicalTitle: "jemalloc 5.4.0 released", sourceItemIds: ["rss-9"] }),
		entry({ storyId: "openai-astra-law", canonicalTitle: "OpenAI ships Astra for Law, confirmed", sourceItemIds: ["rss-1", "rss-2"] }),
	];

	it("reports the later story against the earlier one it resembles", () => {
		const pairs = residualPairs(entries, 0.5);
		expect(pairs.length).toBe(1);
		expect(pairs[0]!.storyId).toBe("openai-astra-law");
		expect(pairs[0]!.otherStoryId).toBe("openai-astra-for-law");
	});

	it("flags a shared source item, which is what makes a split likely", () => {
		expect(residualPairs(entries, 0.5)[0]!.sharesSource).toBe(true);
	});

	it("is deterministic: the same ledger prints the same order", () => {
		const a = JSON.stringify(residualPairs(entries, 0.3));
		const b = JSON.stringify(residualPairs([...entries], 0.3));
		expect(a).toBe(b);
	});

	it("finds nothing when no two titles overlap", () => {
		expect(residualPairs([entries[0]!, entries[1]!], 0.5)).toEqual([]);
	});
});

describe("ledgerTelemetry", () => {
	const fire = (storyId: string, top: string, ts: string): LedgerEvent => ({
		kind: "tool_call",
		tool: "upsert_story",
		ts,
		storyId,
		todayNear: [top],
		todayNearTop: top,
		todayNearScore: 0.8,
	});

	it("counts a later merge into the named candidate as acceptance", () => {
		const t = ledgerTelemetry([
			{ kind: "tool_call", tool: "upsert_story", ts: "t1", storyId: "a" },
			fire("b", "a", "t2"),
			{ kind: "tool_call", tool: "upsert_story", ts: "t3", storyId: "a" },
		]);
		expect(t.fires.length).toBe(1);
		expect(t.accepted).toBe(1);
		expect(t.declined).toBe(0);
	});

	it("does not credit a write that happened before the warning", () => {
		const t = ledgerTelemetry([
			{ kind: "tool_call", tool: "upsert_story", ts: "t1", storyId: "a" },
			fire("b", "a", "t2"),
		]);
		expect(t.accepted).toBe(0);
		expect(t.declined).toBe(1);
	});

	it("records the top candidate and its score", () => {
		const t = ledgerTelemetry([fire("b", "a", "t1")]);
		expect(t.fires[0]).toMatchObject({ storyId: "b", top: "a", score: 0.8, candidates: ["a"] });
	});

	it("totals list_today_stories result chars and separates match calls", () => {
		const t = ledgerTelemetry([
			{ kind: "tool_call", tool: "list_today_stories", count: 28 },
			{ kind: "tool_result", tool: "list_today_stories", chars: 900 },
			{ kind: "tool_call", tool: "list_today_stories", match: "a title", hits: 2, total: 40 },
			{ kind: "tool_result", tool: "list_today_stories", chars: 300 },
		]);
		expect(t.listCalls).toBe(2);
		expect(t.listMatchCalls).toBe(1);
		expect(t.listChars).toBe(1200);
		expect(t.largestList).toBe(900);
		expect(t.listTokens).toBe(amplifiedTokens(1200));
	});

	it("reports nothing rather than failing on an empty log", () => {
		const t = ledgerTelemetry([]);
		expect(t).toMatchObject({ listCalls: 0, listChars: 0, fires: [], upserts: 0 });
	});
});

describe("listSavings", () => {
	it("rebuilds the old payload from the ids each call actually returned", () => {
		const entries = [
			entry({ storyId: "a-story-with-a-slug", canonicalTitle: "A reasonably long canonical title for a story" }),
			entry({ storyId: "b-story-with-a-slug", canonicalTitle: "Another reasonably long canonical title" }),
		];
		const s = listSavings(entries, [1, 2]);
		expect(s.before).toBeGreaterThan(s.after);
		expect(s.beforeTokens).toBe(amplifiedTokens(s.before));
	});

	it("is zero for a run that never called it", () => {
		expect(listSavings([], [])).toMatchObject({ before: 0, after: 0 });
	});
});

describe("ledgerTelemetry reads a batch commit", () => {
	it("counts a batch's stories and its fires without needing a call per entry", () => {
		const t = ledgerTelemetry([
			{
				kind: "tool_call",
				tool: "commit_curation_batch",
				ts: "t1",
				accepted: 3,
				recorded: 50,
				near: [{ storyId: "b", top: "a", score: 0.8, candidates: ["a"] }],
			},
		]);
		expect(t.upserts).toBe(3);
		expect(t.fires.length).toBe(1);
		expect(t.fires[0]).toMatchObject({ storyId: "b", top: "a", score: 0.8 });
	});

	it("sees a later batch merging into the candidate as acceptance", () => {
		const t = ledgerTelemetry([
			{
				kind: "tool_call",
				tool: "commit_curation_batch",
				ts: "t1",
				accepted: 1,
				near: [{ storyId: "b", top: "a", score: 0.8, candidates: ["a"] }],
			},
			{ kind: "tool_call", tool: "upsert_story", ts: "t2", storyId: "a" },
		]);
		expect(t.accepted).toBe(1);
	});
});

describe("a trace from before the writers were consolidated still counts correctly", () => {
	it("does not count a batch's entries twice when it also logged them one by one", () => {
		// The 2026-09-19 shape: `upsert_stories` reported 20 accepted AND each
		// entry emitted its own `upsert_story` note.
		const t = ledgerTelemetry([
			{ kind: "tool_call", tool: "upsert_stories", ts: "t1", accepted: 2 },
			{ kind: "tool_call", tool: "upsert_story", ts: "t1", storyId: "a" },
			{ kind: "tool_call", tool: "upsert_story", ts: "t1", storyId: "b" },
		]);
		expect(t.upserts).toBe(2);
	});

	it("still counts a genuine single write when nothing batched in that run", () => {
		const t = ledgerTelemetry([{ kind: "tool_call", tool: "upsert_story", ts: "t1", storyId: "a" }]);
		expect(t.upserts).toBe(1);
	});
});
