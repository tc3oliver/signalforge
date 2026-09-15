import { describe, expect, it } from "vitest";
import type { ItemExplanation } from "../src/db/decisions.ts";
import type { StoryLedgerEntry } from "../src/schemas/story.ts";
import { buildTraceSteps } from "../web/lib/trace.ts";

/*
 * The explainability contract: for any item, the reader must be able to say
 * where it stopped and why, in words, at every step of the chain.
 */

function explanation(over: Partial<ItemExplanation> = {}): ItemExplanation {
	return {
		itemId: "it-1",
		title: "An item",
		disposition: "CANDIDATE",
		reason: "符合興趣輪廓",
		storyId: "st-1",
		runId: "run-1",
		reachedBrief: true,
		briefSection: "AI_LLM",
		...over,
	};
}

const story: StoryLedgerEntry = {
	storyId: "st-1",
	date: "2026-09-13",
	canonicalTitle: "A story",
	sourceItemIds: ["it-1"],
	primarySourceIds: ["it-1"],
	factRefs: [],
	topicIds: [],
	firstSeenAt: "2026-09-13T06:03:00.000Z",
	lastSeenAt: "2026-09-13T06:03:00.000Z",
	status: "OPEN",
	changeType: "NEW",
	relevance: 0.9,
	novelty: 0.8,
	importance: 0.85,
	confidence: 0.9,
	reason: "第一手來源",
};

const base = {
	date: "2026-09-13",
	story,
	collectedAt: "2026-09-13T05:40:00.000Z",
	collectorId: "seed-rss-frontier",
	knownToItemStore: true,
};

describe("item trace", () => {
	it("walks scanned -> decided -> story -> brief when the item is published", () => {
		const steps = buildTraceSteps({ ...base, explanation: explanation() });
		expect(steps.map((s) => s.stage)).toEqual(["scanned", "decided", "story", "brief"]);
		expect(steps.every((s) => s.outcome === "ok")).toBe(true);
		expect(steps[3]?.label).toContain("Published");
		expect(steps[3]?.detail).toContain("AI / LLM");
	});

	it("stops at the decision when the item was judged irrelevant", () => {
		const steps = buildTraceSteps({
			...base,
			explanation: explanation({
				disposition: "IRRELEVANT",
				reason: "不在輪廓範圍",
				storyId: undefined,
				reachedBrief: false,
				briefSection: undefined,
			}),
		});
		expect(steps.map((s) => s.stage)).toEqual(["scanned", "decided", "story"]);
		expect(steps[1]?.outcome).toBe("stopped");
		expect(steps[1]?.detail).toContain("不在輪廓範圍");
		expect(steps[2]?.outcome).toBe("stopped");
		expect(steps[2]?.detail).toContain("out of scope");
	});

	it("distinguishes a story that was never selected from one that was", () => {
		const steps = buildTraceSteps({
			...base,
			explanation: explanation({ reachedBrief: false, briefSection: undefined }),
		});
		const briefStep = steps.at(-1);
		expect(briefStep?.stage).toBe("brief");
		expect(briefStep?.outcome).toBe("stopped");
		expect(briefStep?.label).toContain("Not selected");
		expect(briefStep?.storyId).toBe("st-1");
	});

	it("reports a missing decision as a coverage gap, not a verdict", () => {
		const steps = buildTraceSteps({
			...base,
			explanation: explanation({ disposition: undefined, reason: undefined, storyId: undefined }),
		});
		expect(steps).toHaveLength(2);
		expect(steps[1]?.outcome).toBe("unknown");
		expect(steps[1]?.detail).toContain("scan-coverage gap");
	});

	it("stops immediately when the item is not in the item store at all", () => {
		const steps = buildTraceSteps({
			...base,
			knownToItemStore: false,
			explanation: explanation({ disposition: undefined, storyId: undefined }),
		});
		expect(steps[0]?.outcome).toBe("stopped");
		expect(steps[0]?.label).toContain("Not in the item store");
	});

	it("flags a decision naming a story with no ledger entry", () => {
		const steps = buildTraceSteps({ ...base, story: undefined, explanation: explanation() });
		const storyStep = steps.find((s) => s.stage === "story");
		expect(storyStep?.outcome).toBe("unknown");
		expect(storyStep?.detail).toContain("no ledger entry");
	});
});
