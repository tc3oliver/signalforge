import { describe, expect, it } from "vitest";
import { evaluate } from "../src/eval/evaluator.ts";
import { computeMetrics, type EvalInput } from "../src/eval/metrics.ts";
import { renderEvalMarkdown } from "../src/eval/report.ts";
import type { DailyBrief, DailyBriefStory } from "../src/schemas/brief.ts";
import type { ItemDecision } from "../src/schemas/decision.ts";
import type { GoldEvent, GoldTruth, MetricResult } from "../src/schemas/gold.ts";
import type { DailyManifest } from "../src/schemas/manifest.ts";
import type { DailyMaterials } from "../src/schemas/materials.ts";
import type { StoryLedgerEntry } from "../src/schemas/story.ts";

const DATE = "2026-09-12";
const STORY_COUNT = 10;
const NOISE = ["n1", "n2", "n3", "n4"];

const items = (n: number): string[] => [`e${n}-a`, `e${n}-b`, `e${n}-c`];
const indices = Array.from({ length: STORY_COUNT }, (_, i) => i + 1);

function goldTruth(): GoldTruth {
	const events: GoldEvent[] = indices.map((n) => ({
		eventId: `ev${n}`,
		canonicalTitle: `Event ${n}`,
		itemIds: items(n),
		primaryItemIds: [`e${n}-a`],
		expectedChangeType: "NEW",
		expectedImportant: true,
		expectedSection: "AI_LLM",
	}));
	return { date: DATE, events, noiseItemIds: [...NOISE], expectedEmergingSignals: [] };
}

function manifest(): DailyManifest {
	const allIds = [...indices.flatMap(items), ...NOISE];
	return {
		date: DATE,
		generatedAt: `${DATE}T00:00:00.000Z`,
		items: allIds.map((id) => ({
			id,
			sourceType: "rss" as const,
			trust: "UNTRUSTED_EXTERNAL_CONTENT" as const,
			sourceName: "feed",
			title: `title ${id}`,
			summary: "",
			publishedAt: `${DATE}T00:00:00.000Z`,
			metadata: {},
		})),
		facts: [
			{
				factId: "f1",
				kind: "crypto" as const,
				label: "BTC",
				value: 1,
				unit: "USD",
				asOf: `${DATE}T00:00:00.000Z`,
				sourceItemId: "e1-a",
			},
		],
	};
}

function decisions(): ItemDecision[] {
	const all = [...indices.flatMap(items), ...NOISE];
	return all.map((itemId) => ({
		itemId,
		disposition: NOISE.includes(itemId) ? ("IRRELEVANT" as const) : ("CANDIDATE" as const),
		reason: "fixture",
		decidedAt: `${DATE}T01:00:00.000Z`,
	}));
}

function ledger(): StoryLedgerEntry[] {
	return indices.map((n) => ({
		storyId: `s${n}`,
		date: DATE,
		canonicalTitle: `Story ${n}`,
		sourceItemIds: items(n),
		primarySourceIds: [`e${n}-a`],
		firstSeenAt: `${DATE}T01:00:00.000Z`,
		lastSeenAt: `${DATE}T01:00:00.000Z`,
		status: "OPEN" as const,
		changeType: "NEW" as const,
		relevance: 0.9,
		novelty: 0.9,
		importance: 0.9,
		confidence: 0.9,
		reason: "fixture",
		factRefs: [],
		topicIds: [],
	}));
}

function materials(): DailyMaterials {
	return {
		date: DATE,
		producedAt: `${DATE}T02:00:00.000Z`,
		stories: indices.map((n) => ({
			storyId: `s${n}`,
			tier: "A" as const,
			canonicalTitle: `Story ${n}`,
			whySelected: "fixture",
			changeType: "NEW" as const,
			importance: 0.9,
			novelty: 0.9,
			confidence: 0.9,
			sourceItemIds: items(n),
			primarySourceIds: [`e${n}-a`],
			factRefs: [],
			topicIds: [],
		})),
		emergingSignals: [],
		curatorNotes: "",
	};
}

function briefStory(n: number): DailyBriefStory {
	return {
		storyId: `s${n}`,
		section: "AI_LLM",
		mustKnow: n <= 4,
		title: `Story ${n}`,
		whatHappened: "x",
		whyItMatters: "x",
		whatChanged: "x",
		impact: "x",
		confidence: "HIGH",
		sourceItemIds: items(n),
		factRefs: n === 1 ? ["f1"] : [],
	};
}

function brief(): DailyBrief {
	return {
		date: DATE,
		producedAt: `${DATE}T03:00:00.000Z`,
		stories: indices.map(briefStory),
		emergingSignals: [],
		dailyAnalysis: "analysis",
		watchNext: ["next"],
	};
}

function perfectInput(): EvalInput {
	return {
		date: DATE,
		gold: goldTruth(),
		manifest: manifest(),
		decisions: decisions(),
		ledger: ledger(),
		materials: materials(),
		brief: brief(),
		briefSchemaValid: true,
		structuredOutputRetriesNeeded: 0,
		structuredOutputFinallyValid: true,
	};
}

function byName(metrics: MetricResult[]): Map<string, MetricResult> {
	return new Map(metrics.map((m) => [m.name, m]));
}

/** Apply one mutation and report which gates flipped to FAIL. */
function failuresAfter(mutate: (input: EvalInput) => void): string[] {
	const input = perfectInput();
	mutate(input);
	return evaluate(input, "run-1").failedGates;
}

describe("metrics — perfect run", () => {
	it("passes every gate", () => {
		const report = evaluate(perfectInput(), "run-1");
		expect(report.failedGates).toEqual([]);
		expect(report.overallPass).toBe(true);
	});

	it("every metric carries a non-empty detail with raw counts", () => {
		for (const metric of computeMetrics(perfectInput())) {
			expect(metric.detail.length).toBeGreaterThan(0);
		}
	});

	it("reports the expected values", () => {
		const m = byName(computeMetrics(perfectInput()));
		expect(m.get("scan_coverage")?.value).toBe(1);
		expect(m.get("important_story_recall")?.value).toBe(1);
		expect(m.get("selected_story_precision")?.value).toBe(1);
		expect(m.get("cluster_precision")?.value).toBe(1);
		expect(m.get("cluster_recall")?.value).toBe(1);
		expect(m.get("cluster_f1")?.value).toBe(1);
		expect(m.get("change_type_accuracy")?.value).toBe(1);
		expect(m.get("noise_rejection_rate")?.value).toBe(1);
		expect(m.get("fabricated_source_ids")?.value).toBe(0);
		expect(m.get("invalid_fact_refs")?.value).toBe(0);
		expect(m.get("final_duplicate_stories")?.value).toBe(0);
		expect(m.get("final_story_count")?.value).toBe(10);
		expect(m.get("must_know_count")?.value).toBe(4);
	});
});

describe("metrics — targeted mutations", () => {
	it("scan_coverage fails when an item has no decision", () => {
		expect(failuresAfter((i) => {
			i.decisions = i.decisions.filter((d) => d.itemId !== "e5-b");
		})).toEqual(["scan_coverage"]);
	});

	it("important_story_recall fails when an important event is dropped from the brief", () => {
		// Drop two of ten important events: recall 0.8 < 0.90. Story count stays in range.
		const failures = failuresAfter((i) => {
			i.brief.stories = i.brief.stories.filter((s) => s.storyId !== "s9" && s.storyId !== "s10");
		});
		expect(failures).toContain("important_story_recall");
		expect(failures).not.toContain("selected_story_precision");
		expect(failures).not.toContain("cluster_f1");
	});

	it("selected_story_precision fails when brief stories match no important gold event", () => {
		const failures = failuresAfter((i) => {
			i.gold.events = i.gold.events.map((e) =>
				e.eventId === "ev9" || e.eventId === "ev10" ? { ...e, expectedImportant: false } : e,
			);
		});
		expect(failures).toContain("selected_story_precision");
	});

	it("cluster_f1 fails when the curator splits every event into singletons", () => {
		const failures = failuresAfter((i) => {
			i.ledger = i.ledger.map((entry) => ({
				...entry,
				sourceItemIds: [entry.sourceItemIds[0] as string],
			}));
		});
		expect(failures).toContain("cluster_f1");
	});

	it("cluster_f1 fails on over-merging (precision collapses)", () => {
		const failures = failuresAfter((i) => {
			const merged = [...i.ledger[0]!.sourceItemIds, ...i.ledger[1]!.sourceItemIds];
			i.ledger = [{ ...i.ledger[0]!, sourceItemIds: merged }, ...i.ledger.slice(2)];
			i.materials.stories = i.materials.stories.filter((s) => s.storyId !== "s2");
		});
		expect(failures).toContain("cluster_f1");
	});

	it("change_type_accuracy fails when matched stories carry the wrong changeType", () => {
		const failures = failuresAfter((i) => {
			i.ledger = i.ledger.map((entry, idx) =>
				idx < 3 ? { ...entry, changeType: "RUMOR" as const } : entry,
			);
		});
		expect(failures).toEqual(["change_type_accuracy"]);
	});

	it("noise_rejection_rate fails when noise leaks into the brief", () => {
		const failures = failuresAfter((i) => {
			i.brief.stories[0] = {
				...i.brief.stories[0]!,
				sourceItemIds: [...i.brief.stories[0]!.sourceItemIds, "n1"],
			};
		});
		expect(failures).toEqual(["noise_rejection_rate"]);
	});

	it("fabricated_source_ids fails on an item id absent from the manifest", () => {
		const failures = failuresAfter((i) => {
			i.brief.stories[0] = {
				...i.brief.stories[0]!,
				sourceItemIds: [...i.brief.stories[0]!.sourceItemIds, "ghost-1"],
			};
		});
		expect(failures).toEqual(["fabricated_source_ids"]);
	});

	it("invalid_fact_refs fails on an unknown factId", () => {
		const failures = failuresAfter((i) => {
			i.brief.stories[2] = { ...i.brief.stories[2]!, factRefs: ["f-nope"] };
		});
		expect(failures).toEqual(["invalid_fact_refs"]);
	});

	it("final_duplicate_stories fails on a near-identical source set", () => {
		const failures = failuresAfter((i) => {
			i.brief.stories[9] = {
				...i.brief.stories[9]!,
				storyId: "s10-dup",
				sourceItemIds: [...i.brief.stories[0]!.sourceItemIds],
			};
		});
		expect(failures).toContain("final_duplicate_stories");
	});

	it("final_duplicate_stories fails on a repeated storyId", () => {
		const failures = failuresAfter((i) => {
			i.brief.stories = [...i.brief.stories, { ...i.brief.stories[0]!, sourceItemIds: ["n1"] }];
		});
		expect(failures).toContain("final_duplicate_stories");
	});

	it("final_story_count fails below 8", () => {
		const failures = failuresAfter((i) => {
			i.brief.stories = i.brief.stories.slice(0, 7);
		});
		expect(failures).toContain("final_story_count");
	});

	it("must_know_count fails when nothing is flagged must-know", () => {
		const failures = failuresAfter((i) => {
			i.brief.stories = i.brief.stories.map((s) => ({ ...s, mustKnow: false }));
		});
		expect(failures).toEqual(["must_know_count"]);
	});

	it("schema_validity fails when the brief did not parse", () => {
		expect(failuresAfter((i) => {
			i.briefSchemaValid = false;
		})).toEqual(["schema_validity"]);
	});

	it("structured_output_after_retry fails when no valid output was ever produced", () => {
		expect(failuresAfter((i) => {
			i.structuredOutputRetriesNeeded = 3;
			i.structuredOutputFinallyValid = false;
		})).toEqual(["structured_output_after_retry"]);
	});

	it("retries before eventual success do not fail the gate", () => {
		expect(failuresAfter((i) => {
			i.structuredOutputRetriesNeeded = 2;
		})).toEqual([]);
	});
});

describe("metrics — null denominators", () => {
	it("yields null value and null pass rather than a false failure", () => {
		const input = perfectInput();
		input.gold.events = [];
		input.gold.noiseItemIds = [];
		input.manifest.items = [];
		input.decisions = [];
		input.ledger = [];
		input.materials.stories = [];
		const m = byName(computeMetrics(input));
		for (const name of [
			"scan_coverage",
			"important_story_recall",
			"cluster_precision",
			"cluster_recall",
			"cluster_f1",
			"change_type_accuracy",
			"noise_rejection_rate",
		]) {
			expect(m.get(name)?.value, name).toBeNull();
			expect(m.get(name)?.pass, name).toBeNull();
		}
		// A null-pass metric never contributes to failedGates.
		expect(evaluate(input, "run-1").failedGates).not.toContain("cluster_f1");
	});
});

/**
 * A day on which the curator found only `n` genuine stories. The validator then
 * requires exactly `n` stories and a Must Know floor scaled to them, and the
 * editor is held to that, so the evaluator has to be measuring the same gate.
 */
function quietDayInput(n: number): EvalInput {
	const input = perfectInput();
	const keep = new Set(indices.slice(0, n).map((i) => `s${i}`));
	input.materials.stories = input.materials.stories.filter((s) => keep.has(s.storyId));
	input.ledger = input.ledger.filter((e) => keep.has(e.storyId));
	input.brief.stories = input.brief.stories
		.filter((s) => keep.has(s.storyId))
		.map((s, idx) => ({ ...s, mustKnow: idx < 2 }));
	input.gold.events = input.gold.events.filter((e) =>
		keep.has(`s${e.eventId.replace("ev", "")}`),
	);
	return input;
}

describe("metrics — count gates track the validator's bounds", () => {
	it("accepts a five-story brief on a day with five curated stories", () => {
		const m = byName(computeMetrics(quietDayInput(5)));
		const stories = m.get("final_story_count");
		expect(stories?.value).toBe(5);
		expect(stories?.threshold).toBe(5);
		expect(stories?.thresholdMax).toBe(5);
		expect(stories?.pass).toBe(true);

		const mustKnow = m.get("must_know_count");
		expect(mustKnow?.value).toBe(2);
		expect(mustKnow?.threshold).toBe(2);
		expect(mustKnow?.thresholdMax).toBe(5);
		expect(mustKnow?.pass).toBe(true);
	});

	it("keeps the usual 8-story floor and 3..5 Must Know on a ten-story day", () => {
		// Ten curated stories: the floor is the usual 8, and the ceiling is the ten
		// that exist rather than the nominal 15.
		const m = byName(computeMetrics(perfectInput()));
		expect(m.get("final_story_count")?.threshold).toBe(8);
		expect(m.get("final_story_count")?.thresholdMax).toBe(10);
		expect(m.get("must_know_count")?.threshold).toBe(3);
		expect(m.get("must_know_count")?.thresholdMax).toBe(5);
	});

	it("renders the bounds the gate actually applied, not a fixed string", () => {
		const markdown = renderEvalMarkdown(evaluate(quietDayInput(5), "run-1"));
		expect(markdown).toContain("| final_story_count | 5 | 5..5 | PASS |");
		expect(markdown).toContain("| must_know_count | 2 | 2..5 | PASS |");
		expect(markdown).not.toContain("8..15");
	});
});

describe("metrics — cluster recall population", () => {
	it("scores a flawless run at recall 1 despite an unimportant gold event", () => {
		const input = perfectInput();
		// The curator is asked to leave expectedImportant:false events out, so its
		// pairs can never appear in the prediction; counting them in the gold
		// denominator capped a perfect run below the 0.9 f1 gate.
		input.gold.events = [
			...input.gold.events,
			{
				eventId: "ev-minor",
				canonicalTitle: "Minor event",
				itemIds: ["m-a", "m-b", "m-c"],
				primaryItemIds: ["m-a"],
				expectedChangeType: "NEW" as const,
				expectedImportant: false,
				expectedSection: "AI_LLM" as const,
			},
		];
		const m = byName(computeMetrics(input));
		expect(m.get("cluster_recall")?.value).toBe(1);
		expect(m.get("cluster_f1")?.value).toBe(1);
		expect(m.get("cluster_recall")?.detail).toContain("10/11 expectedImportant events");
		expect(m.get("cluster_recall")?.detail).not.toContain("ev-minor");
	});
});
