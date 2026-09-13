import { describe, expect, it } from "vitest";
import { computeStability, type StabilityDateInput, type StabilityRunInput } from "../src/eval/stability.ts";
import type { DailyBrief, DailyBriefStory } from "../src/schemas/brief.ts";
import type { GoldEvent, GoldTruth } from "../src/schemas/gold.ts";
import type { StoryLedgerEntry } from "../src/schemas/story.ts";

function goldEvent(partial: Partial<GoldEvent> & { eventId: string; itemIds: string[] }): GoldEvent {
	return {
		canonicalTitle: `event ${partial.eventId}`,
		primaryItemIds: partial.primaryItemIds ?? [partial.itemIds[0] as string],
		expectedChangeType: "NEW",
		expectedImportant: true,
		expectedSection: "AI_LLM",
		...partial,
	};
}

function gold(events: GoldEvent[]): GoldTruth {
	return { date: "2026-09-10", events, noiseItemIds: [], expectedEmergingSignals: [] };
}

function briefStory(partial: Partial<DailyBriefStory> & { storyId: string; sourceItemIds: string[] }): DailyBriefStory {
	return {
		section: "AI_LLM",
		mustKnow: false,
		title: `title for ${partial.storyId}`,
		whatHappened: "x",
		whyItMatters: "x",
		whatChanged: "x",
		impact: "x",
		confidence: "HIGH",
		factRefs: [],
		...partial,
	};
}

function ledgerEntry(partial: Partial<StoryLedgerEntry> & { storyId: string; sourceItemIds: string[] }): StoryLedgerEntry {
	return {
		date: "2026-09-10",
		canonicalTitle: `ledger for ${partial.storyId}`,
		primarySourceIds: [partial.sourceItemIds[0] as string],
		firstSeenAt: "2026-09-10T00:00:00.000Z",
		lastSeenAt: "2026-09-10T00:00:00.000Z",
		status: "OPEN",
		changeType: "NEW",
		relevance: 0.9,
		novelty: 0.9,
		importance: 0.9,
		confidence: 0.9,
		reason: "x",
		factRefs: [],
		...partial,
	};
}

function brief(stories: DailyBriefStory[], emergingSignals: DailyBrief["emergingSignals"] = []): DailyBrief {
	return {
		date: "2026-09-10",
		producedAt: "2026-09-10T00:00:00.000Z",
		stories,
		emergingSignals,
		dailyAnalysis: "x",
		watchNext: ["x"],
	};
}

function run(experiment: string, brief_: DailyBrief, ledger: StoryLedgerEntry[]): StabilityRunInput {
	return { experiment, runId: `${experiment}-run`, brief: brief_, ledger };
}

describe("computeStability", () => {
	it("scores every metric 1.0 for two identical runs", () => {
		const g = gold([
			goldEvent({ eventId: "e1", itemIds: ["i1", "i2"] }),
			goldEvent({ eventId: "e2", itemIds: ["i3", "i4"] }),
		]);
		const stories = [
			briefStory({ storyId: "s1", sourceItemIds: ["i1", "i2"], mustKnow: true }),
			briefStory({ storyId: "s2", sourceItemIds: ["i3", "i4"] }),
		];
		const ledger = [
			ledgerEntry({ storyId: "s1", sourceItemIds: ["i1", "i2"], changeType: "NEW" }),
			ledgerEntry({ storyId: "s2", sourceItemIds: ["i3", "i4"], changeType: "UPDATE" }),
		];
		const b = brief(stories, [{ label: "sig", body: "x", storyIds: ["s1"] }]);

		const input: StabilityDateInput = {
			date: "2026-09-10",
			gold: g,
			runs: [run("a", b, ledger), run("b", structuredClone(b), structuredClone(ledger))],
		};
		const report = computeStability({ dates: [input] });
		expect(report.dates).toHaveLength(1);
		for (const metric of report.dates[0]!.metrics) {
			expect(metric.mean).toBe(1);
			for (const pair of metric.pairs) expect(pair.value).toBe(1);
		}
		for (const metric of report.overall) expect(metric.mean).toBe(1);
	});

	it("scores core_story_selection_stability 0 for completely disjoint selections", () => {
		const g = gold([
			goldEvent({ eventId: "e1", itemIds: ["i1", "i2"] }),
			goldEvent({ eventId: "e2", itemIds: ["i3", "i4"] }),
		]);
		const briefA = brief([briefStory({ storyId: "s1", sourceItemIds: ["i1", "i2"] })]);
		const briefB = brief([briefStory({ storyId: "s2", sourceItemIds: ["i3", "i4"] })]);
		const ledgerA = [ledgerEntry({ storyId: "s1", sourceItemIds: ["i1", "i2"] })];
		const ledgerB = [ledgerEntry({ storyId: "s2", sourceItemIds: ["i3", "i4"] })];

		const report = computeStability({
			dates: [{ date: "2026-09-10", gold: g, runs: [run("a", briefA, ledgerA), run("b", briefB, ledgerB)] }],
		});
		const core = report.dates[0]!.metrics.find((m) => m.name === "core_story_selection_stability");
		expect(core?.mean).toBe(0);
	});

	it("treats the same event under a different storyId slug (same items) as stable", () => {
		const g = gold([goldEvent({ eventId: "e1", itemIds: ["i1", "i2", "i3"] })]);
		const briefA = brief([briefStory({ storyId: "curator-slug-alpha", sourceItemIds: ["i1", "i2", "i3"] })]);
		const briefB = brief([briefStory({ storyId: "totally-different-name", sourceItemIds: ["i1", "i2", "i3"] })]);
		const ledgerA = [ledgerEntry({ storyId: "curator-slug-alpha", sourceItemIds: ["i1", "i2", "i3"] })];
		const ledgerB = [ledgerEntry({ storyId: "totally-different-name", sourceItemIds: ["i1", "i2", "i3"] })];

		const report = computeStability({
			dates: [{ date: "2026-09-10", gold: g, runs: [run("a", briefA, ledgerA), run("b", briefB, ledgerB)] }],
		});
		const core = report.dates[0]!.metrics.find((m) => m.name === "core_story_selection_stability");
		expect(core?.mean).toBe(1);
	});

	it("still counts an unmatched story with identical items as stable via synthetic identity", () => {
		// Neither story overlaps any gold event well enough to match, but both runs
		// independently grouped the same two items into one story under different slugs.
		const g = gold([goldEvent({ eventId: "e1", itemIds: ["z1", "z2", "z3", "z4", "z5"] })]);
		const briefA = brief([briefStory({ storyId: "orphan-a", sourceItemIds: ["x1", "x2"] })]);
		const briefB = brief([briefStory({ storyId: "orphan-b", sourceItemIds: ["x1", "x2"] })]);
		const ledgerA = [ledgerEntry({ storyId: "orphan-a", sourceItemIds: ["x1", "x2"] })];
		const ledgerB = [ledgerEntry({ storyId: "orphan-b", sourceItemIds: ["x1", "x2"] })];

		const report = computeStability({
			dates: [{ date: "2026-09-10", gold: g, runs: [run("a", briefA, ledgerA), run("b", briefB, ledgerB)] }],
		});
		const core = report.dates[0]!.metrics.find((m) => m.name === "core_story_selection_stability");
		expect(core?.mean).toBe(1);
	});

	it("change_type_stability only considers gold events matched by both runs", () => {
		const g = gold([
			goldEvent({ eventId: "e1", itemIds: ["i1", "i2"] }),
			goldEvent({ eventId: "e2", itemIds: ["i3", "i4"] }),
		]);
		// Both runs match e1 with the same changeType; only run "a" also covers e2.
		const briefA = brief([
			briefStory({ storyId: "s1", sourceItemIds: ["i1", "i2"] }),
			briefStory({ storyId: "s2", sourceItemIds: ["i3", "i4"] }),
		]);
		const briefB = brief([briefStory({ storyId: "s1", sourceItemIds: ["i1", "i2"] })]);
		const ledgerA = [
			ledgerEntry({ storyId: "s1", sourceItemIds: ["i1", "i2"], changeType: "NEW" }),
			ledgerEntry({ storyId: "s2", sourceItemIds: ["i3", "i4"], changeType: "ESCALATION" }),
		];
		const ledgerB = [ledgerEntry({ storyId: "s1", sourceItemIds: ["i1", "i2"], changeType: "NEW" })];

		const report = computeStability({
			dates: [{ date: "2026-09-10", gold: g, runs: [run("a", briefA, ledgerA), run("b", briefB, ledgerB)] }],
		});
		const changeType = report.dates[0]!.metrics.find((m) => m.name === "change_type_stability");
		expect(changeType?.mean).toBe(1);
		expect(changeType?.pairs[0]?.detail).toContain("1/1");
	});

	it("computes the mean pairwise agreement over all pairs for three experiments", () => {
		const g = gold([
			goldEvent({ eventId: "e1", itemIds: ["i1", "i2"] }),
			goldEvent({ eventId: "e2", itemIds: ["i3", "i4"] }),
		]);
		// a and b both publish only e1 (jaccard 1 between them); c publishes only e2
		// (jaccard 0 against both a and b). Mean over the 3 pairs = (1 + 0 + 0) / 3.
		const briefA = brief([briefStory({ storyId: "s1", sourceItemIds: ["i1", "i2"] })]);
		const briefB = brief([briefStory({ storyId: "s1b", sourceItemIds: ["i1", "i2"] })]);
		const briefC = brief([briefStory({ storyId: "s2", sourceItemIds: ["i3", "i4"] })]);
		const ledgerA = [ledgerEntry({ storyId: "s1", sourceItemIds: ["i1", "i2"] })];
		const ledgerB = [ledgerEntry({ storyId: "s1b", sourceItemIds: ["i1", "i2"] })];
		const ledgerC = [ledgerEntry({ storyId: "s2", sourceItemIds: ["i3", "i4"] })];

		const report = computeStability({
			dates: [
				{
					date: "2026-09-10",
					gold: g,
					runs: [run("a", briefA, ledgerA), run("b", briefB, ledgerB), run("c", briefC, ledgerC)],
				},
			],
		});
		const core = report.dates[0]!.metrics.find((m) => m.name === "core_story_selection_stability");
		expect(core?.pairs).toHaveLength(3);
		expect(core?.mean).toBeCloseTo(1 / 3, 10);
	});
});
