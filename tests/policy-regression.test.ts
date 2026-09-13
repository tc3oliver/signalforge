import { describe, expect, it } from "vitest";
import { evaluate } from "../src/eval/evaluator.ts";
import type { EvalInput } from "../src/eval/metrics.ts";
import { validateBrief } from "../src/validator/brief-validator.ts";
import type { DailyBrief, DailyBriefStory } from "../src/schemas/brief.ts";
import type { ItemDecision } from "../src/schemas/decision.ts";
import type { GoldEvent, GoldTruth } from "../src/schemas/gold.ts";
import type { NormalizedItem } from "../src/schemas/item.ts";
import type { DailyManifest } from "../src/schemas/manifest.ts";
import type { DailyMaterials, DailyMaterialStory } from "../src/schemas/materials.ts";
import type { MetricResult } from "../src/schemas/gold.ts";
import type { StoryLedgerEntry } from "../src/schemas/story.ts";

/**
 * Deterministic regression net over the real evaluator. Every scenario here is
 * hand-built (no LLM in the loop): we synthesize curator/editor outputs by hand
 * and run `evaluate()` / `validateBrief()` over them, to prove the evaluator
 * rewards the corrected policy behavior and punishes the two failure modes that
 * were found (double-counted emerging-signal constituents, and over-merged
 * causally-related macro events) — while still requiring true duplicates to
 * merge and background context to stay out of the brief.
 *
 * All ids are generated locally; none reference fixtures/generated/** or eval/gold/**.
 */

const DATE = "2026-01-15";
const TS = `${DATE}T00:00:00.000Z`;

function findMetric(metrics: MetricResult[], name: string): MetricResult {
	const m = metrics.find((x) => x.name === name);
	if (!m) throw new Error(`metric ${name} not found`);
	return m;
}

// ---------------------------------------------------------------------------
// Filler: 8 independently-important, always-correctly-handled single-item
// events. They pad every scenario up to the brief's 8-story schema minimum
// without contributing any item-pairs to the cluster metrics, so each
// scenario's cluster_f1 is driven entirely by the behavior under test.
// ---------------------------------------------------------------------------

const FILLER_COUNT = 8;
const FILLER_MUST_KNOW = 4; // within the schema's 3-5 mustKnow band

function fillerItemId(n: number): string {
	return `fill-${n}-a`;
}

function fillerGoldEvents(): GoldEvent[] {
	return Array.from({ length: FILLER_COUNT }, (_, i) => {
		const n = i + 1;
		return {
			eventId: `fill-ev-${n}`,
			canonicalTitle: `Filler event ${n}`,
			itemIds: [fillerItemId(n)],
			primaryItemIds: [fillerItemId(n)],
			expectedChangeType: "NEW" as const,
			expectedImportant: true,
			expectedSection: "AI_LLM",
		};
	});
}

function fillerLedger(): StoryLedgerEntry[] {
	return Array.from({ length: FILLER_COUNT }, (_, i) => {
		const n = i + 1;
		return {
			storyId: `fill-story-${n}`,
			date: DATE,
			canonicalTitle: `Filler story ${n}`,
			sourceItemIds: [fillerItemId(n)],
			primarySourceIds: [fillerItemId(n)],
			firstSeenAt: TS,
			lastSeenAt: TS,
			status: "OPEN" as const,
			changeType: "NEW" as const,
			relevance: 0.9,
			novelty: 0.9,
			importance: 0.9,
			confidence: 0.9,
			reason: "filler",
			factRefs: [],
		};
	});
}

function fillerMaterials(): DailyMaterialStory[] {
	return Array.from({ length: FILLER_COUNT }, (_, i) => {
		const n = i + 1;
		return {
			storyId: `fill-story-${n}`,
			tier: "A" as const,
			canonicalTitle: `Filler story ${n}`,
			whySelected: "filler",
			changeType: "NEW" as const,
			importance: 0.9,
			novelty: 0.9,
			confidence: 0.9,
			sourceItemIds: [fillerItemId(n)],
			primarySourceIds: [fillerItemId(n)],
			factRefs: [],
		};
	});
}

function fillerBriefStories(): DailyBriefStory[] {
	return Array.from({ length: FILLER_COUNT }, (_, i) => {
		const n = i + 1;
		return {
			storyId: `fill-story-${n}`,
			section: "AI_LLM" as const,
			mustKnow: n <= FILLER_MUST_KNOW,
			title: `Filler story ${n}`,
			whatHappened: "filler",
			whyItMatters: "filler",
			whatChanged: "filler",
			impact: "filler",
			confidence: "HIGH" as const,
			sourceItemIds: [fillerItemId(n)],
			factRefs: [],
		};
	});
}

// ---------------------------------------------------------------------------
// Generic assembly
// ---------------------------------------------------------------------------

function mkItem(id: string): NormalizedItem {
	return {
		id,
		sourceType: "rss",
		sourceName: "feed",
		title: `title ${id}`,
		summary: "",
		publishedAt: TS,
		metadata: {},
	};
}

interface ScenarioSpec {
	goldEvents: GoldEvent[];
	noiseItemIds: string[];
	ledger: StoryLedgerEntry[];
	materials: DailyMaterialStory[];
	briefStories: DailyBriefStory[];
	emergingSignals?: { label: string; body: string; storyIds: string[] }[];
	/** itemId -> storyId, for curated-but-not-necessarily-published items. */
	itemStoryOwner?: Record<string, string>;
}

function buildEvalInput(spec: ScenarioSpec): EvalInput {
	const goldEvents = [...fillerGoldEvents(), ...spec.goldEvents];
	const ledger = [...fillerLedger(), ...spec.ledger];
	const materialStories = [...fillerMaterials(), ...spec.materials];
	const briefStories = [...fillerBriefStories(), ...spec.briefStories];

	const owner = new Map<string, string>();
	for (const entry of ledger) for (const id of entry.sourceItemIds) owner.set(id, entry.storyId);
	for (const [id, storyId] of Object.entries(spec.itemStoryOwner ?? {})) owner.set(id, storyId);

	const noise = new Set(spec.noiseItemIds);
	const allItemIds = new Set<string>([
		...goldEvents.flatMap((e) => e.itemIds),
		...ledger.flatMap((e) => e.sourceItemIds),
		...materialStories.flatMap((s) => s.sourceItemIds),
		...briefStories.flatMap((s) => s.sourceItemIds),
		...noise,
	]);

	const manifest: DailyManifest = {
		date: DATE,
		generatedAt: TS,
		items: [...allItemIds].sort().map(mkItem),
		facts: [],
	};

	const decisions: ItemDecision[] = [...allItemIds].sort().map((itemId) => {
		if (noise.has(itemId)) {
			return { itemId, disposition: "IRRELEVANT" as const, reason: "noise", decidedAt: TS };
		}
		const storyId = owner.get(itemId);
		return storyId
			? { itemId, disposition: "CANDIDATE" as const, storyId, reason: "curated", decidedAt: TS }
			: { itemId, disposition: "CANDIDATE" as const, reason: "curated", decidedAt: TS };
	});

	const materials: DailyMaterials = {
		date: DATE,
		producedAt: TS,
		stories: materialStories,
		emergingSignals: (spec.emergingSignals ?? []).map((s) => ({
			label: s.label,
			rationale: s.body,
			storyIds: s.storyIds,
		})),
		curatorNotes: "",
	};

	const brief: DailyBrief = {
		date: DATE,
		producedAt: TS,
		stories: briefStories,
		emergingSignals: spec.emergingSignals ?? [],
		dailyAnalysis: "daily analysis",
		watchNext: ["watch next item"],
	};

	const gold: GoldTruth = {
		date: DATE,
		events: goldEvents,
		noiseItemIds: spec.noiseItemIds,
		expectedEmergingSignals: [],
	};

	return {
		date: DATE,
		gold,
		manifest,
		decisions,
		ledger,
		materials,
		brief,
		briefSchemaValid: true,
		structuredOutputRetriesNeeded: 0,
		structuredOutputFinallyValid: true,
	};
}

// ===========================================================================
// 1. Emerging-signal constituents (Issue A)
// ===========================================================================

const SIG_CONSTITUENTS = [1, 2, 3, 4].map((n) => ({
	eventId: `sig-ev-${n}`,
	itemId: `sig-${n}-a`,
	storyId: `sig-story-${n}`,
}));

function signalGoldEvents(): GoldEvent[] {
	return SIG_CONSTITUENTS.map((c) => ({
		eventId: c.eventId,
		canonicalTitle: `Signal constituent ${c.eventId}`,
		itemIds: [c.itemId],
		primaryItemIds: [c.itemId],
		expectedChangeType: "NEW" as const,
		expectedImportant: false,
		expectedSection: "AI_LLM",
	}));
}

function signalLedger(): StoryLedgerEntry[] {
	return SIG_CONSTITUENTS.map((c) => ({
		storyId: c.storyId,
		date: DATE,
		canonicalTitle: `Signal constituent ${c.storyId}`,
		sourceItemIds: [c.itemId],
		primarySourceIds: [c.itemId],
		firstSeenAt: TS,
		lastSeenAt: TS,
		status: "OPEN" as const,
		changeType: "NEW" as const,
		relevance: 0.5,
		novelty: 0.5,
		importance: 0.4,
		confidence: 0.6,
		reason: "constituent",
		factRefs: [],
	}));
}

function signalMaterials(): DailyMaterialStory[] {
	return SIG_CONSTITUENTS.map((c) => ({
		storyId: c.storyId,
		tier: "C" as const,
		canonicalTitle: `Signal constituent ${c.storyId}`,
		whySelected: "part of an emerging trend",
		changeType: "NEW" as const,
		importance: 0.4,
		novelty: 0.5,
		confidence: 0.6,
		sourceItemIds: [c.itemId],
		primarySourceIds: [c.itemId],
		factRefs: [],
	}));
}

function signalBriefStories(): DailyBriefStory[] {
	return SIG_CONSTITUENTS.map((c) => ({
		storyId: c.storyId,
		section: "AI_LLM" as const,
		mustKnow: false,
		title: `Signal constituent ${c.storyId}`,
		whatHappened: "constituent",
		whyItMatters: "constituent",
		whatChanged: "constituent",
		impact: "constituent",
		confidence: "MEDIUM" as const,
		sourceItemIds: [c.itemId],
		factRefs: [],
	}));
}

const SIGNAL = {
	label: "Emerging trend across constituents",
	body: "Four weak signals point at the same emerging trend.",
	storyIds: SIG_CONSTITUENTS.map((c) => c.storyId),
};

describe("Issue A: emerging-signal constituents must not double-count", () => {
	it("1a — signal cites curated-but-unpublished constituents: valid and precise", () => {
		const input = buildEvalInput({
			goldEvents: signalGoldEvents(),
			noiseItemIds: [],
			ledger: signalLedger(),
			materials: signalMaterials(),
			briefStories: [], // constituents are curated but NOT published as brief stories
			emergingSignals: [SIGNAL],
		});

		const { date: _date, producedAt: _producedAt, ...briefInput } = input.brief;
		const validation = validateBrief(briefInput, { manifest: input.manifest, materials: input.materials });
		expect(validation.ok, validation.errors.join("; ")).toBe(true);

		const report = evaluate(input);
		const precision = findMetric(report.metrics, "selected_story_precision");
		expect(precision.value).not.toBeNull();
		expect(precision.value as number).toBeGreaterThanOrEqual(0.85);
		expect(precision.pass).toBe(true);
	});

	it("1b — regression: constituents ALSO published as standalone stories degrades precision", () => {
		const goodInput = buildEvalInput({
			goldEvents: signalGoldEvents(),
			noiseItemIds: [],
			ledger: signalLedger(),
			materials: signalMaterials(),
			briefStories: [],
			emergingSignals: [SIGNAL],
		});
		const goodPrecision = findMetric(evaluate(goodInput).metrics, "selected_story_precision")
			.value as number;

		const regressedInput = buildEvalInput({
			goldEvents: signalGoldEvents(),
			noiseItemIds: [],
			ledger: signalLedger(),
			materials: signalMaterials(),
			briefStories: signalBriefStories(), // double counted: also published
			emergingSignals: [SIGNAL],
		});
		const report = evaluate(regressedInput);
		const precision = findMetric(report.metrics, "selected_story_precision");

		expect(precision.value as number).toBeLessThan(goodPrecision);
		expect(precision.pass).toBe(false);
	});
});

// ===========================================================================
// 2. Causally related macro events (Issue B)
// ===========================================================================

const MACRO_DATA_ITEMS = ["macro-data-a", "macro-data-b", "macro-data-c"];
const MACRO_POLICY_ITEMS = ["macro-policy-a", "macro-policy-b", "macro-policy-c"];

function macroGoldEvents(): GoldEvent[] {
	return [
		{
			eventId: "macro-ev-data",
			canonicalTitle: "Macro data release",
			itemIds: MACRO_DATA_ITEMS,
			primaryItemIds: [MACRO_DATA_ITEMS[0] as string],
			expectedChangeType: "NEW",
			expectedImportant: true,
			expectedSection: "MACRO",
		},
		{
			eventId: "macro-ev-policy",
			canonicalTitle: "Policy response to the data release",
			itemIds: MACRO_POLICY_ITEMS,
			primaryItemIds: [MACRO_POLICY_ITEMS[0] as string],
			expectedChangeType: "NEW",
			expectedImportant: true,
			expectedSection: "MACRO",
		},
	];
}

function macroStory(
	storyId: string,
	sourceItemIds: string[],
	primarySourceIds: string[],
): { ledger: StoryLedgerEntry; material: DailyMaterialStory; brief: DailyBriefStory } {
	return {
		ledger: {
			storyId,
			date: DATE,
			canonicalTitle: storyId,
			sourceItemIds,
			primarySourceIds,
			firstSeenAt: TS,
			lastSeenAt: TS,
			status: "OPEN",
			changeType: "NEW",
			relevance: 0.9,
			novelty: 0.9,
			importance: 0.9,
			confidence: 0.9,
			reason: "macro",
			factRefs: [],
		},
		material: {
			storyId,
			tier: "A",
			canonicalTitle: storyId,
			whySelected: "macro",
			changeType: "NEW",
			importance: 0.9,
			novelty: 0.9,
			confidence: 0.9,
			sourceItemIds,
			primarySourceIds,
			factRefs: [],
		},
		brief: {
			storyId,
			section: "MACRO",
			mustKnow: false,
			title: storyId,
			whatHappened: "macro",
			whyItMatters: "macro",
			whatChanged: "macro",
			impact: "macro",
			confidence: "HIGH",
			sourceItemIds,
			factRefs: [],
		},
	};
}

describe("Issue B: causally related macro events must not over-merge", () => {
	it("2a — correct: two separate stories match gold, cluster_f1 passes", () => {
		const data = macroStory("macro-story-data", MACRO_DATA_ITEMS, [MACRO_DATA_ITEMS[0] as string]);
		const policy = macroStory("macro-story-policy", MACRO_POLICY_ITEMS, [
			MACRO_POLICY_ITEMS[0] as string,
		]);
		const input = buildEvalInput({
			goldEvents: macroGoldEvents(),
			noiseItemIds: [],
			ledger: [data.ledger, policy.ledger],
			materials: [data.material, policy.material],
			briefStories: [data.brief, policy.brief],
		});
		const f1 = findMetric(evaluate(input).metrics, "cluster_f1");
		expect(f1.value as number).toBeGreaterThanOrEqual(0.9);
		expect(f1.pass).toBe(true);
	});

	it("2b — regression: merged into one story degrades cluster_f1 and fails", () => {
		const data = macroStory("macro-story-data", MACRO_DATA_ITEMS, [MACRO_DATA_ITEMS[0] as string]);
		const policy = macroStory("macro-story-policy", MACRO_POLICY_ITEMS, [
			MACRO_POLICY_ITEMS[0] as string,
		]);
		const goodInput = buildEvalInput({
			goldEvents: macroGoldEvents(),
			noiseItemIds: [],
			ledger: [data.ledger, policy.ledger],
			materials: [data.material, policy.material],
			briefStories: [data.brief, policy.brief],
		});
		const goodF1 = findMetric(evaluate(goodInput).metrics, "cluster_f1").value as number;

		const merged = macroStory(
			"macro-story-merged",
			[...MACRO_DATA_ITEMS, ...MACRO_POLICY_ITEMS],
			[MACRO_DATA_ITEMS[0] as string],
		);
		const regressedInput = buildEvalInput({
			goldEvents: macroGoldEvents(),
			noiseItemIds: [],
			ledger: [merged.ledger],
			materials: [merged.material],
			briefStories: [merged.brief],
		});
		const f1 = findMetric(evaluate(regressedInput).metrics, "cluster_f1");

		expect(f1.value as number).toBeLessThan(goodF1);
		expect(f1.pass).toBe(false);
	});
});

// ===========================================================================
// 3. True same event must still merge (anti-over-splitting)
// ===========================================================================

const MERGE_ITEMS = ["merge-official", "merge-tag", "merge-media", "merge-community"];

function mergeGoldEvents(): GoldEvent[] {
	return [
		{
			eventId: "merge-ev-1",
			canonicalTitle: "One real event reported four ways",
			itemIds: MERGE_ITEMS,
			primaryItemIds: ["merge-official"],
			expectedChangeType: "NEW",
			expectedImportant: true,
			expectedSection: "DEVELOPER_OSS",
		},
	];
}

function mergeStoryParts(
	storyId: string,
	sourceItemIds: string[],
): { ledger: StoryLedgerEntry; material: DailyMaterialStory; brief: DailyBriefStory } {
	return {
		ledger: {
			storyId,
			date: DATE,
			canonicalTitle: storyId,
			sourceItemIds,
			primarySourceIds: [sourceItemIds[0] as string],
			firstSeenAt: TS,
			lastSeenAt: TS,
			status: "OPEN",
			changeType: "NEW",
			relevance: 0.9,
			novelty: 0.9,
			importance: 0.9,
			confidence: 0.9,
			reason: "merge",
			factRefs: [],
		},
		material: {
			storyId,
			tier: "A",
			canonicalTitle: storyId,
			whySelected: "merge",
			changeType: "NEW",
			importance: 0.9,
			novelty: 0.9,
			confidence: 0.9,
			sourceItemIds,
			primarySourceIds: [sourceItemIds[0] as string],
			factRefs: [],
		},
		brief: {
			storyId,
			section: "DEVELOPER_OSS",
			mustKnow: false,
			title: storyId,
			whatHappened: "merge",
			whyItMatters: "merge",
			whatChanged: "merge",
			impact: "merge",
			confidence: "HIGH",
			sourceItemIds,
			factRefs: [],
		},
	};
}

describe("anti-over-splitting: a true single event must still merge", () => {
	it("3a — correct: one story with all 4 items, cluster_f1 passes, no duplicates", () => {
		const merged = mergeStoryParts("merge-story-1", MERGE_ITEMS);
		const input = buildEvalInput({
			goldEvents: mergeGoldEvents(),
			noiseItemIds: [],
			ledger: [merged.ledger],
			materials: [merged.material],
			briefStories: [merged.brief],
		});
		const report = evaluate(input);
		const f1 = findMetric(report.metrics, "cluster_f1");
		const dup = findMetric(report.metrics, "final_duplicate_stories");
		expect(f1.value as number).toBeGreaterThanOrEqual(0.9);
		expect(f1.pass).toBe(true);
		expect(dup.value).toBe(0);
	});

	it("3b — regression: same 4 items split across 3 stories degrades cluster_f1 and fails", () => {
		const merged = mergeStoryParts("merge-story-1", MERGE_ITEMS);
		const goodInput = buildEvalInput({
			goldEvents: mergeGoldEvents(),
			noiseItemIds: [],
			ledger: [merged.ledger],
			materials: [merged.material],
			briefStories: [merged.brief],
		});
		const goodF1 = findMetric(evaluate(goodInput).metrics, "cluster_f1").value as number;

		const split1 = mergeStoryParts("merge-story-split-1", ["merge-official", "merge-tag"]);
		const split2 = mergeStoryParts("merge-story-split-2", ["merge-media"]);
		const split3 = mergeStoryParts("merge-story-split-3", ["merge-community"]);
		const regressedInput = buildEvalInput({
			goldEvents: mergeGoldEvents(),
			noiseItemIds: [],
			ledger: [split1.ledger, split2.ledger, split3.ledger],
			materials: [split1.material, split2.material, split3.material],
			briefStories: [split1.brief, split2.brief, split3.brief],
		});
		const f1 = findMetric(evaluate(regressedInput).metrics, "cluster_f1");

		expect(f1.value as number).toBeLessThan(goodF1);
		expect(f1.pass).toBe(false);
	});
});

// ===========================================================================
// 4. Background context must not create a new event
// ===========================================================================

const BG_EVENT_ITEMS = ["bg-a", "bg-b"];
const BG_ANALYSIS_ITEM = "bg-analysis";

function bgGoldEvents(): GoldEvent[] {
	return [
		{
			eventId: "bg-ev-1",
			canonicalTitle: "The actual event",
			itemIds: BG_EVENT_ITEMS,
			primaryItemIds: [BG_EVENT_ITEMS[0] as string],
			expectedChangeType: "NEW",
			expectedImportant: true,
			expectedSection: "RESEARCH",
		},
	];
}

function bgStoryParts(): { ledger: StoryLedgerEntry; material: DailyMaterialStory; brief: DailyBriefStory } {
	return {
		ledger: {
			storyId: "bg-story-1",
			date: DATE,
			canonicalTitle: "bg-story-1",
			sourceItemIds: BG_EVENT_ITEMS,
			primarySourceIds: [BG_EVENT_ITEMS[0] as string],
			firstSeenAt: TS,
			lastSeenAt: TS,
			status: "OPEN",
			changeType: "NEW",
			relevance: 0.9,
			novelty: 0.9,
			importance: 0.9,
			confidence: 0.9,
			reason: "bg",
			factRefs: [],
		},
		material: {
			storyId: "bg-story-1",
			tier: "A",
			canonicalTitle: "bg-story-1",
			whySelected: "bg",
			changeType: "NEW",
			importance: 0.9,
			novelty: 0.9,
			confidence: 0.9,
			sourceItemIds: BG_EVENT_ITEMS,
			primarySourceIds: [BG_EVENT_ITEMS[0] as string],
			factRefs: [],
		},
		brief: {
			storyId: "bg-story-1",
			section: "RESEARCH",
			mustKnow: false,
			title: "bg-story-1",
			whatHappened: "bg",
			whyItMatters: "bg",
			whatChanged: "bg",
			impact: "bg",
			confidence: "HIGH",
			sourceItemIds: BG_EVENT_ITEMS,
			factRefs: [],
		},
	};
}

describe("background context must not create a new event", () => {
	it("4a — correct: analysis item marked noise, kept out of the brief, noise_rejection passes", () => {
		const main = bgStoryParts();
		const input = buildEvalInput({
			goldEvents: bgGoldEvents(),
			noiseItemIds: [BG_ANALYSIS_ITEM],
			ledger: [main.ledger],
			materials: [main.material],
			briefStories: [main.brief],
		});
		const report = evaluate(input);
		const noiseRejection = findMetric(report.metrics, "noise_rejection_rate");
		expect(noiseRejection.value).toBe(1);
		expect(noiseRejection.pass).toBe(true);
		expect(input.brief.stories.length).toBe(FILLER_COUNT + 1);
	});

	it("4b — regression: analysis item becomes its own standalone story degrades noise_rejection", () => {
		const main = bgStoryParts();
		const goodInput = buildEvalInput({
			goldEvents: bgGoldEvents(),
			noiseItemIds: [BG_ANALYSIS_ITEM],
			ledger: [main.ledger],
			materials: [main.material],
			briefStories: [main.brief],
		});
		const goodReport = evaluate(goodInput);
		const goodNoiseRejection = findMetric(goodReport.metrics, "noise_rejection_rate").value as number;

		const analysisLedger: StoryLedgerEntry = {
			storyId: "bg-story-analysis",
			date: DATE,
			canonicalTitle: "bg-story-analysis",
			sourceItemIds: [BG_ANALYSIS_ITEM],
			primarySourceIds: [BG_ANALYSIS_ITEM],
			firstSeenAt: TS,
			lastSeenAt: TS,
			status: "OPEN",
			changeType: "NEW",
			relevance: 0.6,
			novelty: 0.5,
			importance: 0.5,
			confidence: 0.6,
			reason: "background analysis treated as its own story (regression)",
			factRefs: [],
		};
		const analysisMaterial: DailyMaterialStory = {
			storyId: "bg-story-analysis",
			tier: "B",
			canonicalTitle: "bg-story-analysis",
			whySelected: "background analysis",
			changeType: "NEW",
			importance: 0.5,
			novelty: 0.5,
			confidence: 0.6,
			sourceItemIds: [BG_ANALYSIS_ITEM],
			primarySourceIds: [BG_ANALYSIS_ITEM],
			factRefs: [],
		};
		const analysisBrief: DailyBriefStory = {
			storyId: "bg-story-analysis",
			section: "RESEARCH",
			mustKnow: false,
			title: "bg-story-analysis",
			whatHappened: "background analysis",
			whyItMatters: "background analysis",
			whatChanged: "background analysis",
			impact: "background analysis",
			confidence: "LOW",
			sourceItemIds: [BG_ANALYSIS_ITEM],
			factRefs: [],
		};

		const regressedInput = buildEvalInput({
			goldEvents: bgGoldEvents(),
			noiseItemIds: [BG_ANALYSIS_ITEM],
			ledger: [main.ledger, analysisLedger],
			materials: [main.material, analysisMaterial],
			briefStories: [main.brief, analysisBrief],
		});
		const report = evaluate(regressedInput);
		const noiseRejection = findMetric(report.metrics, "noise_rejection_rate");

		expect(noiseRejection.value as number).toBeLessThan(goodNoiseRejection);
		expect(noiseRejection.pass).toBe(false);
	});
});
