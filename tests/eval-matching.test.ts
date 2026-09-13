import { describe, expect, it } from "vitest";
import { matchStoriesToEvents, type MatchableStory } from "../src/eval/matching.ts";
import type { GoldEvent, GoldTruth } from "../src/schemas/gold.ts";

function event(partial: Partial<GoldEvent> & { eventId: string; itemIds: string[] }): GoldEvent {
	return {
		canonicalTitle: `event ${partial.eventId}`,
		primaryItemIds: partial.primaryItemIds ?? [partial.itemIds[0] as string],
		expectedChangeType: "NEW",
		expectedImportant: true,
		expectedSection: "AI_LLM",
		...partial,
	};
}

function gold(events: GoldEvent[], noiseItemIds: string[] = []): GoldTruth {
	return { date: "2026-09-12", events, noiseItemIds, expectedEmergingSignals: [] };
}

function story(storyId: string, sourceItemIds: string[], primary?: string[]): MatchableStory {
	return { storyId, sourceItemIds, primarySourceIds: primary ?? [] };
}

describe("matchStoriesToEvents", () => {
	it("matches an exact item-set overlap at jaccard 1", () => {
		const result = matchStoriesToEvents(
			[story("s1", ["i1", "i2", "i3"], ["i1"])],
			gold([event({ eventId: "e1", itemIds: ["i1", "i2", "i3"], primaryItemIds: ["i1"] })]),
		);
		expect(result.matches).toEqual([
			{ storyId: "s1", eventId: "e1", jaccard: 1, primaryHit: true },
		]);
		expect(result.unmatchedStoryIds).toEqual([]);
		expect(result.unmatchedEventIds).toEqual([]);
	});

	it("accepts a partial overlap at or above 0.3", () => {
		// story {i1,i2,x1,x2} vs event {i1,i2,i3} -> 2/5 = 0.4
		const result = matchStoriesToEvents(
			[story("s1", ["i1", "i2", "x1", "x2"])],
			gold([event({ eventId: "e1", itemIds: ["i1", "i2", "i3"], primaryItemIds: ["i9"] })]),
		);
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]?.jaccard).toBeCloseTo(0.4, 10);
		expect(result.matches[0]?.primaryHit).toBe(false);
	});

	it("rejects a partial overlap below 0.3 with no primary item", () => {
		// story {i1,x1,x2,x3,x4} vs event {i1,i2,i3} -> 1/7 ≈ 0.143
		const result = matchStoriesToEvents(
			[story("s1", ["i1", "x1", "x2", "x3", "x4"])],
			gold([event({ eventId: "e1", itemIds: ["i1", "i2", "i3"], primaryItemIds: ["i2"] })]),
		);
		expect(result.matches).toEqual([]);
		expect(result.unmatchedStoryIds).toEqual(["s1"]);
		expect(result.unmatchedEventIds).toEqual(["e1"]);
	});

	it("rescues a sub-0.3 overlap when the story carries a primary item", () => {
		// story {p1,x1,x2,x3} vs event {p1,i2,i3} -> 1/6 ≈ 0.167, above the 0.15 rescue bar
		const result = matchStoriesToEvents(
			[story("s1", ["p1", "x1", "x2", "x3"], ["p1"])],
			gold([event({ eventId: "e1", itemIds: ["p1", "i2", "i3"], primaryItemIds: ["p1"] })]),
		);
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]?.jaccard).toBeLessThan(0.3);
		expect(result.matches[0]?.primaryHit).toBe(true);
	});

	it("does not rescue below 0.15 even with a primary item", () => {
		const result = matchStoriesToEvents(
			[story("s1", ["p1", "x1", "x2", "x3", "x4", "x5"], ["p1"])],
			gold([event({ eventId: "e1", itemIds: ["p1", "i2", "i3"], primaryItemIds: ["p1"] })]),
		);
		expect(result.matches).toEqual([]);
	});

	it("assigns one-to-one, giving a contested event to the better story", () => {
		const result = matchStoriesToEvents(
			[
				story("sWeak", ["i1", "x1", "x2"]),
				story("sStrong", ["i1", "i2", "i3"]),
			],
			gold([event({ eventId: "e1", itemIds: ["i1", "i2", "i3"], primaryItemIds: ["i1"] })]),
		);
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]?.storyId).toBe("sStrong");
		expect(result.unmatchedStoryIds).toEqual(["sWeak"]);
	});

	it("breaks ties deterministically by (eventId, storyId)", () => {
		const events = gold([
			event({ eventId: "eB", itemIds: ["i1", "i2"], primaryItemIds: ["i1"] }),
			event({ eventId: "eA", itemIds: ["i1", "i2"], primaryItemIds: ["i1"] }),
		]);
		const stories = [story("sB", ["i1", "i2"]), story("sA", ["i1", "i2"])];
		const first = matchStoriesToEvents(stories, events);
		const reordered = matchStoriesToEvents([...stories].reverse(), events);
		expect(first.matches).toEqual([
			{ storyId: "sA", eventId: "eA", jaccard: 1, primaryHit: false },
			{ storyId: "sB", eventId: "eB", jaccard: 1, primaryHit: false },
		]);
		expect(reordered.matches).toEqual(first.matches);
	});

	it("reports a story that matches nothing", () => {
		const result = matchStoriesToEvents(
			[story("s1", ["z1", "z2"]), story("s2", ["i1", "i2", "i3"])],
			gold([event({ eventId: "e1", itemIds: ["i1", "i2", "i3"], primaryItemIds: ["i1"] })]),
		);
		expect(result.matches.map((m) => m.storyId)).toEqual(["s2"]);
		expect(result.unmatchedStoryIds).toEqual(["s1"]);
	});

	it("ignores titles entirely — identical titles do not create a match", () => {
		const result = matchStoriesToEvents(
			[story("same-title", ["z1", "z2"])],
			gold([
				{
					eventId: "e1",
					canonicalTitle: "same-title",
					itemIds: ["i1", "i2"],
					primaryItemIds: ["i1"],
					expectedChangeType: "NEW",
					expectedImportant: true,
					expectedSection: "AI_LLM",
				},
			]),
		);
		expect(result.matches).toEqual([]);
	});
});
