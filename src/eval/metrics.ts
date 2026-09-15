import type { DailyBrief } from "../schemas/brief.ts";
import type { ItemDecision } from "../schemas/decision.ts";
import type { GoldTruth, MetricResult } from "../schemas/gold.ts";
import type { DailyManifest } from "../schemas/manifest.ts";
import type { DailyMaterials } from "../schemas/materials.ts";
import type { StoryLedgerEntry } from "../schemas/story.ts";
import { matchStoriesToEvents, type MatchableStory, type StoryEventMatch } from "./matching.ts";

export interface EvalInput {
	date: string;
	gold: GoldTruth;
	manifest: DailyManifest;
	decisions: ItemDecision[];
	ledger: StoryLedgerEntry[];
	materials: DailyMaterials;
	brief: DailyBrief;
	briefSchemaValid: boolean;
	/** Attempts that failed schema validation before a valid object was produced. */
	structuredOutputRetriesNeeded: number;
	structuredOutputFinallyValid: boolean;
}

function metric(
	name: string,
	value: number | null,
	unit: string,
	threshold: number | null,
	comparator: MetricResult["comparator"],
	pass: boolean | null,
	detail: string,
): MetricResult {
	return { name, value, unit, threshold, comparator, pass, detail };
}

function gte(name: string, value: number, threshold: number, unit: string, detail: string) {
	return metric(name, value, unit, threshold, "gte", value >= threshold, detail);
}
function lte(name: string, value: number, threshold: number, unit: string, detail: string) {
	return metric(name, value, unit, threshold, "lte", value <= threshold, detail);
}
function eq(name: string, value: number, threshold: number, detail: string) {
	return metric(name, value, "flag", threshold, "eq", value === threshold, detail);
}
function range(name: string, value: number, min: number, max: number, detail: string) {
	// `threshold` holds the lower bound; the bounds themselves live in `detail`.
	return metric(name, value, "count", min, "range", value >= min && value <= max, detail);
}

function ratio(numerator: number, denominator: number): number | null {
	return denominator === 0 ? null : numerator / denominator;
}

/** Ledger entries the curator actually promoted into the materials, keyed by storyId. */
function selectedLedgerEntries(input: EvalInput): StoryLedgerEntry[] {
	const byId = new Map(input.ledger.map((entry) => [entry.storyId, entry]));
	const out: StoryLedgerEntry[] = [];
	for (const story of input.materials.stories) {
		const entry = byId.get(story.storyId);
		if (entry) out.push(entry);
	}
	return out;
}

/** Brief stories lifted to matchable shape; primary ids come from the ledger. */
function briefStoryViews(input: EvalInput): MatchableStory[] {
	const byId = new Map(input.ledger.map((entry) => [entry.storyId, entry]));
	return input.brief.stories.map((story) => ({
		storyId: story.storyId,
		sourceItemIds: story.sourceItemIds ?? [],
		primarySourceIds: byId.get(story.storyId)?.primarySourceIds ?? [],
	}));
}

/**
 * The two views and the two greedy assignments every metric is built from.
 *
 * These used to be recomputed inside each metric: `matchStoriesToEvents` ran
 * three times and `briefStoryViews` three times over identical inputs, on the
 * quadratic path. Computing them once in {@link computeMetrics} also guarantees
 * the metrics agree with each other about which story matched which event.
 *
 * Each metric still accepts the input alone and derives its own when called
 * standalone, so a test can exercise one gate in isolation.
 */
export interface EvalDerived {
	briefViews: MatchableStory[];
	briefMatches: StoryEventMatch[];
	selectedEntries: StoryLedgerEntry[];
	selectedMatches: StoryEventMatch[];
}

export function deriveEvalViews(input: EvalInput): EvalDerived {
	const briefViews = briefStoryViews(input);
	const selectedEntries = selectedLedgerEntries(input);
	return {
		briefViews,
		briefMatches: matchStoriesToEvents(briefViews, input.gold).matches,
		selectedEntries,
		selectedMatches: matchStoriesToEvents(selectedEntries, input.gold).matches,
	};
}

export function scanCoverage(input: EvalInput): MetricResult {
	const decided = new Set(input.decisions.map((d) => d.itemId));
	const manifestIds = new Set(input.manifest.items.map((i) => i.id));
	let covered = 0;
	for (const id of manifestIds) if (decided.has(id)) covered += 1;
	const value = ratio(covered, manifestIds.size);
	if (value === null) {
		return metric("scan_coverage", null, "ratio", 1.0, "gte", null, "manifest has 0 items");
	}
	const missing = [...manifestIds].filter((id) => !decided.has(id));
	return gte(
		"scan_coverage",
		value,
		1.0,
		"ratio",
		`${covered}/${manifestIds.size} manifest items have a decision; ${missing.length} undecided${
			missing.length > 0 ? ` (e.g. ${missing.slice(0, 5).join(", ")})` : ""
		}`,
	);
}

export function importantStoryRecall(
	input: EvalInput,
	derived: EvalDerived = deriveEvalViews(input),
): MetricResult {
	const important = input.gold.events.filter((e) => e.expectedImportant);
	if (important.length === 0) {
		return metric(
			"important_story_recall",
			null,
			"ratio",
			0.9,
			"gte",
			null,
			"gold has no expectedImportant events",
		);
	}
	const matchedEvents = new Set(derived.briefMatches.map((m) => m.eventId));
	const hit = important.filter((e) => matchedEvents.has(e.eventId));
	const missed = important.filter((e) => !matchedEvents.has(e.eventId));
	return gte(
		"important_story_recall",
		hit.length / important.length,
		0.9,
		"ratio",
		`${hit.length}/${important.length} important gold events reached the brief; missed: ${
			missed.map((e) => e.eventId).join(", ") || "none"
		}`,
	);
}

export function selectedStoryPrecision(
	input: EvalInput,
	derived: EvalDerived = deriveEvalViews(input),
): MetricResult {
	const views = derived.briefViews;
	if (views.length === 0) {
		return metric(
			"selected_story_precision",
			null,
			"ratio",
			0.85,
			"gte",
			null,
			"brief has 0 stories",
		);
	}
	const matches = derived.briefMatches;
	const importantIds = new Set(
		input.gold.events.filter((e) => e.expectedImportant).map((e) => e.eventId),
	);
	const good = matches.filter((m) => importantIds.has(m.eventId));
	const goodStories = new Set(good.map((m) => m.storyId));
	const bad = views.filter((v) => !goodStories.has(v.storyId)).map((v) => v.storyId);
	return gte(
		"selected_story_precision",
		good.length / views.length,
		0.85,
		"ratio",
		`${good.length}/${views.length} brief stories match an important gold event; unjustified: ${
			bad.join(", ") || "none"
		}`,
	);
}

function pairKey(a: string, b: string): string {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function pairsOf(itemIds: readonly string[], noise: ReadonlySet<string>): Set<string> {
	const ids = [...new Set(itemIds)].filter((id) => !noise.has(id)).sort();
	const out = new Set<string>();
	for (let i = 0; i < ids.length; i += 1) {
		for (let j = i + 1; j < ids.length; j += 1) {
			const a = ids[i];
			const b = ids[j];
			if (a !== undefined && b !== undefined) out.add(pairKey(a, b));
		}
	}
	return out;
}

interface ClusterCounts {
	goldPairs: Set<string>;
	predictedPairs: Set<string>;
	truePositives: number;
}

function clusterCounts(input: EvalInput, derived: EvalDerived): ClusterCounts {
	const noise = new Set(input.gold.noiseItemIds);
	const goldPairs = new Set<string>();
	for (const event of input.gold.events) {
		for (const pair of pairsOf(event.itemIds, noise)) goldPairs.add(pair);
	}
	const predictedPairs = new Set<string>();
	for (const entry of derived.selectedEntries) {
		for (const pair of pairsOf(entry.sourceItemIds, noise)) predictedPairs.add(pair);
	}
	let truePositives = 0;
	for (const pair of predictedPairs) if (goldPairs.has(pair)) truePositives += 1;
	return { goldPairs, predictedPairs, truePositives };
}

export function clusterMetrics(
	input: EvalInput,
	derived: EvalDerived = deriveEvalViews(input),
): MetricResult[] {
	const { goldPairs, predictedPairs, truePositives } = clusterCounts(input, derived);
	const precision = ratio(truePositives, predictedPairs.size);
	const recall = ratio(truePositives, goldPairs.size);
	const base = `TP=${truePositives}, predicted pairs=${predictedPairs.size}, gold pairs=${goldPairs.size} (noise items excluded)`;

	const precisionMetric = metric(
		"cluster_precision",
		precision,
		"ratio",
		null,
		"none",
		null,
		precision === null ? `no predicted pairs; ${base}` : base,
	);
	const recallMetric = metric(
		"cluster_recall",
		recall,
		"ratio",
		null,
		"none",
		null,
		recall === null ? `no gold pairs; ${base}` : base,
	);

	// f1 is undefined only when there is nothing to measure (no gold pairs). A run
	// that predicts no pairs at all against a non-empty gold is a real failure —
	// recall is 0 there, so f1 is 0 and the gate fails rather than going silent.
	if (recall === null) {
		return [
			precisionMetric,
			recallMetric,
			metric("cluster_f1", null, "ratio", 0.9, "gte", null, `${base}; f1 undefined (no gold pairs)`),
		];
	}
	if (precision === null || precision + recall === 0) {
		return [
			precisionMetric,
			recallMetric,
			metric(
				"cluster_f1",
				0,
				"ratio",
				0.9,
				"gte",
				false,
				`${base}; f1 = 0 (${precision === null ? "no predicted pairs" : "zero precision and recall"})`,
			),
		];
	}
	const f1 = (2 * precision * recall) / (precision + recall);
	return [
		precisionMetric,
		recallMetric,
		gte(
			"cluster_f1",
			f1,
			0.9,
			"ratio",
			`${base}; precision=${precision.toFixed(3)}, recall=${recall.toFixed(3)}`,
		),
	];
}

export function changeTypeAccuracy(
	input: EvalInput,
	derived: EvalDerived = deriveEvalViews(input),
): MetricResult {
	const entries = derived.selectedEntries;
	const matches = derived.selectedMatches;
	if (matches.length === 0) {
		return metric(
			"change_type_accuracy",
			null,
			"ratio",
			0.85,
			"gte",
			null,
			"no (story, event) matches to score",
		);
	}
	const byStory = new Map(entries.map((e) => [e.storyId, e]));
	const byEvent = new Map(input.gold.events.map((e) => [e.eventId, e]));
	const wrong: string[] = [];
	let correct = 0;
	for (const match of matches) {
		const entry = byStory.get(match.storyId);
		const event = byEvent.get(match.eventId);
		if (entry && event && entry.changeType === event.expectedChangeType) correct += 1;
		else if (entry && event) {
			wrong.push(`${match.storyId}: ${entry.changeType} != ${event.expectedChangeType}`);
		}
	}
	return gte(
		"change_type_accuracy",
		correct / matches.length,
		0.85,
		"ratio",
		`${correct}/${matches.length} matched stories carry the expected changeType; wrong: ${
			wrong.join("; ") || "none"
		}`,
	);
}

export function noiseRejectionRate(input: EvalInput): MetricResult {
	const noise = input.gold.noiseItemIds;
	if (noise.length === 0) {
		return metric(
			"noise_rejection_rate",
			null,
			"ratio",
			0.95,
			"gte",
			null,
			"gold declares no noise items",
		);
	}
	const inBrief = new Set(input.brief.stories.flatMap((s) => s.sourceItemIds ?? []));
	const leaked = noise.filter((id) => inBrief.has(id));
	return gte(
		"noise_rejection_rate",
		(noise.length - leaked.length) / noise.length,
		0.95,
		"ratio",
		`${noise.length - leaked.length}/${noise.length} noise items kept out of the brief; leaked: ${
			leaked.join(", ") || "none"
		}`,
	);
}

export function fabricatedSourceIds(input: EvalInput): MetricResult {
	const known = new Set(input.manifest.items.map((i) => i.id));
	const fabricated: string[] = [];
	for (const story of input.brief.stories) {
		for (const id of story.sourceItemIds ?? []) if (!known.has(id)) fabricated.push(`${story.storyId}:${id}`);
	}
	return lte(
		"fabricated_source_ids",
		fabricated.length,
		0,
		"count",
		`${fabricated.length} brief sourceItemIds are absent from the manifest's ${known.size} items${
			fabricated.length > 0 ? ` (${fabricated.slice(0, 10).join(", ")})` : ""
		}`,
	);
}

export function invalidFactRefs(input: EvalInput): MetricResult {
	const known = new Set(input.manifest.facts.map((f) => f.factId));
	const invalid: string[] = [];
	for (const story of input.brief.stories) {
		for (const ref of story.factRefs ?? []) if (!known.has(ref)) invalid.push(`${story.storyId}:${ref}`);
	}
	return lte(
		"invalid_fact_refs",
		invalid.length,
		0,
		"count",
		`${invalid.length} brief factRefs are absent from the manifest's ${known.size} facts${
			invalid.length > 0 ? ` (${invalid.slice(0, 10).join(", ")})` : ""
		}`,
	);
}

const DUPLICATE_JACCARD = 0.6;

export function finalDuplicateStories(input: EvalInput): MetricResult {
	const stories = input.brief.stories;
	const seen = new Set<string>();
	const repeatedIds: string[] = [];
	for (const story of stories) {
		if (seen.has(story.storyId)) repeatedIds.push(story.storyId);
		else seen.add(story.storyId);
	}
	const sets = stories.map((s) => new Set(s.sourceItemIds ?? []));
	const overlapping: string[] = [];
	for (let i = 0; i < stories.length; i += 1) {
		for (let j = i + 1; j < stories.length; j += 1) {
			const a = sets[i];
			const b = sets[j];
			const left = stories[i];
			const right = stories[j];
			if (!a || !b || !left || !right) continue;
			let inter = 0;
			for (const id of a) if (b.has(id)) inter += 1;
			const union = a.size + b.size - inter;
			const score = union === 0 ? 0 : inter / union;
			if (score >= DUPLICATE_JACCARD) {
				overlapping.push(`${left.storyId}~${right.storyId} (j=${score.toFixed(2)})`);
			}
		}
	}
	const total = overlapping.length + repeatedIds.length;
	return lte(
		"final_duplicate_stories",
		total,
		0,
		"count",
		`${overlapping.length} story pairs overlap at jaccard >= ${DUPLICATE_JACCARD}${
			overlapping.length > 0 ? ` (${overlapping.join(", ")})` : ""
		}; ${repeatedIds.length} repeated storyIds${
			repeatedIds.length > 0 ? ` (${repeatedIds.join(", ")})` : ""
		}`,
	);
}

export function finalStoryCount(input: EvalInput): MetricResult {
	const count = input.brief.stories.length;
	return range("final_story_count", count, 8, 15, `${count} stories in the brief; allowed 8..15`);
}

export function mustKnowCount(input: EvalInput): MetricResult {
	const count = input.brief.stories.filter((s) => s.mustKnow).length;
	return range("must_know_count", count, 3, 5, `${count} stories flagged mustKnow; allowed 3..5`);
}

export function schemaValidity(input: EvalInput): MetricResult {
	return eq(
		"schema_validity",
		input.briefSchemaValid ? 1 : 0,
		1,
		input.briefSchemaValid
			? "brief parsed against DailyBrief"
			: "brief FAILED DailyBrief schema validation",
	);
}

export function structuredOutputAfterRetry(input: EvalInput): MetricResult {
	return eq(
		"structured_output_after_retry",
		input.structuredOutputFinallyValid ? 1 : 0,
		1,
		`${input.structuredOutputRetriesNeeded} schema-failing attempt(s) before ${
			input.structuredOutputFinallyValid ? "a valid structured output" : "giving up without one"
		}`,
	);
}

/** Every metric, in report order. */
export function computeMetrics(input: EvalInput): MetricResult[] {
	const derived = deriveEvalViews(input);
	return [
		scanCoverage(input),
		importantStoryRecall(input, derived),
		selectedStoryPrecision(input, derived),
		...clusterMetrics(input, derived),
		changeTypeAccuracy(input, derived),
		noiseRejectionRate(input),
		fabricatedSourceIds(input),
		invalidFactRefs(input),
		finalDuplicateStories(input),
		finalStoryCount(input),
		mustKnowCount(input),
		schemaValidity(input),
		structuredOutputAfterRetry(input),
	];
}
