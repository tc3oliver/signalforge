import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJson, readJsonIfExists } from "../runtime/atomic-json.ts";
import { resolvePaths } from "../runtime/orchestrator.ts";
import { DailyBrief } from "../schemas/brief.ts";
import { GoldTruth } from "../schemas/gold.ts";
import type {
	DateStability,
	StabilityMetric,
	StabilityPair,
	StabilityReport,
	StabilitySummaryMetric,
} from "../schemas/stability.ts";
import { StoryLedgerEntry } from "../schemas/story.ts";
import { matchStoriesToEvents, type MatchableStory } from "./matching.ts";

const CORE_STORY_SELECTION = "core_story_selection_stability";
const MUST_KNOW = "must_know_stability";
const CLUSTER = "cluster_stability";
const CHANGE_TYPE = "change_type_stability";
const EMERGING_SIGNAL = "emerging_signal_stability";

export interface StabilityRunInput {
	experiment: string;
	runId: string;
	ledger: StoryLedgerEntry[];
	brief: DailyBrief;
	/** Model(s) observed for this run's attempts, for report attribution only. */
	models?: readonly string[];
}

export interface StabilityDateInput {
	date: string;
	gold: GoldTruth;
	/** One entry per experiment being compared, all for this same date. */
	runs: StabilityRunInput[];
}

export interface StabilityInput {
	dates: StabilityDateInput[];
}

/**
 * Story identity across experiments MUST survive a storyId/title rename between
 * lineages, because two independent curator runs never agree on slugs even when
 * they agree on substance. So identity is:
 *
 *   1. the gold eventId the story matches via `matchStoriesToEvents` (item-set
 *      overlap, never title/slug), if it matches one; else
 *   2. a synthetic id derived from the story's own source-item set, so two
 *      unmatched stories in different runs that were built from the same items
 *      still compare as the same story.
 *
 * This is what makes the "same event, different storyId slug" case score as
 * stable instead of as a total disagreement.
 */
function identityMap(views: MatchableStory[], gold: GoldTruth): Map<string, string> {
	const { matches } = matchStoriesToEvents(views, gold);
	const matchedEventByStory = new Map(matches.map((m) => [m.storyId, m.eventId]));
	const out = new Map<string, string>();
	for (const view of views) {
		const eventId = matchedEventByStory.get(view.storyId);
		const identity = eventId
			? `gold:${eventId}`
			: `items:${[...new Set(view.sourceItemIds)].sort().join(",")}`;
		out.set(view.storyId, identity);
	}
	return out;
}

function briefStoryView(brief: DailyBrief, ledger: StoryLedgerEntry[]): MatchableStory[] {
	const byId = new Map(ledger.map((entry) => [entry.storyId, entry]));
	return brief.stories.map((story) => ({
		storyId: story.storyId,
		sourceItemIds: story.sourceItemIds,
		primarySourceIds: byId.get(story.storyId)?.primarySourceIds ?? [],
	}));
}

/**
 * Jaccard over two sets, leaving the "both sides empty" case to the caller.
 *
 * Whether 0/0 is agreement depends on what the sets are. Two briefs that
 * published the same zero stories really did agree; two briefs that both
 * flagged zero mustKnow stories produced no evidence about mustKnow at all, and
 * scoring that 1 was inflating `overall`, which is an unweighted mean over the
 * per-metric means. Callers say which case they are in via {@link BothEmpty}.
 */
function jaccardOfSets(a: ReadonlySet<string>, b: ReadonlySet<string>): number | null {
	if (a.size === 0 && b.size === 0) return null;
	let intersection = 0;
	for (const value of a) if (b.has(value)) intersection += 1;
	const union = a.size + b.size - intersection;
	return union === 0 ? null : intersection / union;
}

/**
 * What a pair where neither run produced anything means for this metric.
 *
 * `value: null` is the same answer `ratio()` in metrics.ts gives a zero
 * denominator — excluded from `meanOf`, and so from the roll-up, instead of
 * counted as a perfect score nothing was measured to earn.
 */
interface BothEmpty {
	value: number | null;
	detail: (a: PreparedRun, b: PreparedRun) => string;
}

const VACUOUS_AGREEMENT: BothEmpty = {
	value: 1,
	detail: (a, b) => `${a.experiment} and ${b.experiment} both published 0 identities; jaccard=1 (vacuous agreement)`,
};

function pairKey(a: string, b: string): string {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function itemPairs(itemIds: readonly string[]): Set<string> {
	const ids = [...new Set(itemIds)].sort();
	const out = new Set<string>();
	for (let i = 0; i < ids.length; i += 1) {
		for (let j = i + 1; j < ids.length; j += 1) {
			out.add(pairKey(ids[i] as string, ids[j] as string));
		}
	}
	return out;
}

/** All pairs implied by a ledger's clustering: within-story item pairs, unioned. */
function ledgerPairs(ledger: StoryLedgerEntry[]): Set<string> {
	const out = new Set<string>();
	for (const entry of ledger) for (const pair of itemPairs(entry.sourceItemIds)) out.add(pair);
	return out;
}

function meanOf(values: readonly (number | null)[]): number | null {
	const present = values.filter((v): v is number => v !== null);
	if (present.length === 0) return null;
	return present.reduce((sum, v) => sum + v, 0) / present.length;
}

/** Every unordered pair of runs, for the "mean pairwise agreement" metrics. */
function pairsOfRuns<T>(runs: T[]): [T, T][] {
	const out: [T, T][] = [];
	for (let i = 0; i < runs.length; i += 1) {
		for (let j = i + 1; j < runs.length; j += 1) {
			const a = runs[i];
			const b = runs[j];
			if (a !== undefined && b !== undefined) out.push([a, b]);
		}
	}
	return out;
}

interface PreparedRun {
	experiment: string;
	runId: string;
	brief: DailyBrief;
	ledger: StoryLedgerEntry[];
	views: MatchableStory[];
	identities: Map<string, string>;
}

function prepare(run: StabilityRunInput, gold: GoldTruth): PreparedRun {
	const views = briefStoryView(run.brief, run.ledger);
	return {
		experiment: run.experiment,
		runId: run.runId,
		brief: run.brief,
		ledger: run.ledger,
		views,
		identities: identityMap(views, gold),
	};
}

function identitySet(run: PreparedRun, filter: (storyId: string) => boolean): Set<string> {
	const out = new Set<string>();
	for (const view of run.views) {
		if (!filter(view.storyId)) continue;
		const identity = run.identities.get(view.storyId);
		if (identity) out.add(identity);
	}
	return out;
}

function buildSetMetric(
	name: string,
	unit: string,
	runs: PreparedRun[],
	setFor: (run: PreparedRun) => Set<string>,
	detailFor: (a: PreparedRun, b: PreparedRun, value: number) => string,
	bothEmpty: BothEmpty = VACUOUS_AGREEMENT,
): StabilityMetric {
	const sets = new Map(runs.map((r) => [r.experiment, setFor(r)]));
	const pairs: StabilityPair[] = pairsOfRuns(runs).map(([a, b]) => {
		const jaccard = jaccardOfSets(
			sets.get(a.experiment) as Set<string>,
			sets.get(b.experiment) as Set<string>,
		);
		if (jaccard === null) {
			return {
				experimentA: a.experiment,
				experimentB: b.experiment,
				value: bothEmpty.value,
				detail: bothEmpty.detail(a, b),
			};
		}
		return {
			experimentA: a.experiment,
			experimentB: b.experiment,
			value: jaccard,
			detail: detailFor(a, b, jaccard),
		};
	});
	return { name, mean: meanOf(pairs.map((p) => p.value)), unit, pairs };
}

function coreStorySelectionMetric(runs: PreparedRun[]): StabilityMetric {
	return buildSetMetric(
		CORE_STORY_SELECTION,
		"jaccard",
		runs,
		(r) => identitySet(r, () => true),
		(a, b, value) =>
			`${a.experiment} published ${identitySet(a, () => true).size} identities, ${b.experiment} published ${identitySet(b, () => true).size}; jaccard=${value.toFixed(3)}`,
	);
}

function mustKnowMetric(runs: PreparedRun[]): StabilityMetric {
	const mustKnowIds = (run: PreparedRun): Set<string> => {
		const flagged = new Set(run.brief.stories.filter((s) => s.mustKnow).map((s) => s.storyId));
		return identitySet(run, (storyId) => flagged.has(storyId));
	};
	return buildSetMetric(
		MUST_KNOW,
		"jaccard",
		runs,
		mustKnowIds,
		(a, b, value) =>
			`${a.experiment} flagged ${mustKnowIds(a).size} mustKnow identities, ${b.experiment} flagged ${mustKnowIds(b).size}; jaccard=${value.toFixed(3)}`,
		// Two runs that both flagged nothing tell us nothing about whether they
		// pick the same Must Know stories, which is the only thing this metric
		// exists to measure.
		{
			value: null,
			detail: (a, b) =>
				`neither ${a.experiment} nor ${b.experiment} flagged a mustKnow story; agreement is unmeasurable and this pair is excluded from the mean`,
		},
	);
}

function clusterStabilityMetric(runs: PreparedRun[]): StabilityMetric {
	const pairSets = new Map(runs.map((r) => [r.experiment, ledgerPairs(r.ledger)]));
	const pairs: StabilityPair[] = pairsOfRuns(runs).map(([a, b]) => {
		const setA = pairSets.get(a.experiment) as Set<string>;
		const setB = pairSets.get(b.experiment) as Set<string>;
		let value: number | null;
		let detail: string;
		if (setA.size === 0 && setB.size === 0) {
			value = 1;
			detail = `${a.experiment} and ${b.experiment} both have 0-item ledgers; f1=1 (vacuous agreement)`;
		} else {
			let truePositives = 0;
			for (const pair of setA) if (setB.has(pair)) truePositives += 1;
			const denom = setA.size + setB.size;
			value = denom === 0 ? 1 : (2 * truePositives) / denom;
			detail = `TP=${truePositives}, ${a.experiment} pairs=${setA.size}, ${b.experiment} pairs=${setB.size}; f1=${value.toFixed(3)}`;
		}
		return { experimentA: a.experiment, experimentB: b.experiment, value, detail };
	});
	return { name: CLUSTER, mean: meanOf(pairs.map((p) => p.value)), unit: "f1", pairs };
}

function changeTypeMetric(runs: PreparedRun[]): StabilityMetric {
	const eventChangeType = (run: PreparedRun): Map<string, string> => {
		const ledgerByStory = new Map(run.ledger.map((e) => [e.storyId, e]));
		const out = new Map<string, string>();
		for (const view of run.views) {
			const identity = run.identities.get(view.storyId);
			if (!identity || !identity.startsWith("gold:")) continue;
			const entry = ledgerByStory.get(view.storyId);
			if (entry) out.set(identity, entry.changeType);
		}
		return out;
	};
	const pairs: StabilityPair[] = pairsOfRuns(runs).map(([a, b]) => {
		const mapA = eventChangeType(a);
		const mapB = eventChangeType(b);
		const shared = [...mapA.keys()].filter((id) => mapB.has(id));
		if (shared.length === 0) {
			return {
				experimentA: a.experiment,
				experimentB: b.experiment,
				value: null,
				detail: `no gold event was matched by both ${a.experiment} and ${b.experiment}`,
			};
		}
		const agree = shared.filter((id) => mapA.get(id) === mapB.get(id));
		const value = agree.length / shared.length;
		return {
			experimentA: a.experiment,
			experimentB: b.experiment,
			value,
			detail: `${agree.length}/${shared.length} shared gold events assigned the same changeType by ${a.experiment} and ${b.experiment}`,
		};
	});
	return { name: CHANGE_TYPE, mean: meanOf(pairs.map((p) => p.value)), unit: "ratio", pairs };
}

function emergingSignalMetric(runs: PreparedRun[]): StabilityMetric {
	const citedEvents = (run: PreparedRun): Set<string> => {
		const out = new Set<string>();
		for (const signal of run.brief.emergingSignals) {
			for (const storyId of signal.storyIds) {
				const identity = run.identities.get(storyId);
				if (identity) out.add(identity);
			}
		}
		return out;
	};
	return buildSetMetric(
		EMERGING_SIGNAL,
		"jaccard",
		runs,
		citedEvents,
		(a, b, value) =>
			`${a.experiment} cited ${citedEvents(a).size} identities in emergingSignals, ${b.experiment} cited ${citedEvents(b).size}; jaccard=${value.toFixed(3)}`,
		// Same reason as must_know_stability: a run is allowed to emit no emerging
		// signals, and two runs that both did have not agreed about which signals
		// are emerging.
		{
			value: null,
			detail: (a, b) =>
				`neither ${a.experiment} nor ${b.experiment} cited a story in emergingSignals; agreement is unmeasurable and this pair is excluded from the mean`,
		},
	);
}

function computeDateStability(input: StabilityDateInput): DateStability {
	if (input.runs.length < 2) {
		throw new Error(
			`stability for ${input.date} needs at least 2 experiments to compare, got ${input.runs.length}`,
		);
	}
	const runs = input.runs.map((r) => prepare(r, input.gold));
	return {
		date: input.date,
		runs: runs.map((r) => ({ experiment: r.experiment, runId: r.runId })),
		metrics: [
			coreStorySelectionMetric(runs),
			mustKnowMetric(runs),
			clusterStabilityMetric(runs),
			changeTypeMetric(runs),
			emergingSignalMetric(runs),
		],
	};
}

/**
 * Compares N independent experiment lineages over the same set of dates.
 * Purely descriptive: there is no pass/fail here, only measured agreement.
 */
export function computeStability(input: StabilityInput): StabilityReport {
	const dates = input.dates.map(computeDateStability);

	const experiments = [...new Set(input.dates.flatMap((d) => d.runs.map((r) => r.experiment)))].sort();
	const models = [
		...new Set(input.dates.flatMap((d) => d.runs.flatMap((r) => r.models ?? []))),
	].sort();

	const metricNames = [CORE_STORY_SELECTION, MUST_KNOW, CLUSTER, CHANGE_TYPE, EMERGING_SIGNAL];
	const overall: StabilitySummaryMetric[] = metricNames.map((name) => {
		const perDateMeans = dates.map((d) => d.metrics.find((m) => m.name === name)?.mean ?? null);
		const unit = dates.find((d) => d.metrics.some((m) => m.name === name))?.metrics.find(
			(m) => m.name === name,
		)?.unit ?? "ratio";
		return { name, mean: meanOf(perDateMeans), unit };
	});

	return {
		generatedAt: new Date().toISOString(),
		experiments,
		models,
		dates,
		overall,
	};
}

// ---------------------------------------------------------------------------
// Disk loader
// ---------------------------------------------------------------------------

export interface LoadStabilityOptions {
	root: string;
	experiments: string[];
	dates: string[];
}

/**
 * Newest run directory under `dateDir` by mtime, ties broken lexically.
 *
 * Each entry is stat'ed exactly once. Calling statSync from inside the sort
 * comparator re-stats the same directory O(n log n) times, and a comparator
 * whose inputs can change under it is not a stable ordering either.
 */
function latestRunId(dateDir: string): string {
	const entries = readdirSync(dateDir)
		.map((name) => ({ name, stat: statSync(join(dateDir, name)) }))
		.filter((e) => e.stat.isDirectory())
		.map((e) => ({ name: e.name, mtimeMs: e.stat.mtimeMs }));
	if (entries.length === 0) throw new Error(`no run directories under ${dateDir}`);
	entries.sort((a, b) => {
		const delta = b.mtimeMs - a.mtimeMs;
		return delta !== 0 ? delta : a.name < b.name ? -1 : 1;
	});
	return (entries[0] as { name: string }).name;
}

function readModelsFromAttempts(runDir: string): string[] {
	const attempts = readJsonIfExists<{ stage?: string; status?: string; model?: string }[]>(
		join(runDir, "attempts.json"),
	);
	if (!attempts) return [];
	return [...new Set(attempts.filter((a) => a.status === "SUCCESS" && a.model).map((a) => a.model as string))];
}

/**
 * Reads one (experiment, date) cell off disk: the latest run under
 * `experiments/<experiment>/<date>/`. Missing experiment directories, missing
 * dates, and missing runs are all hard errors — a stability report that
 * silently dropped a lineage would misreport agreement as higher than it is.
 */
export function loadStabilityInput(opts: LoadStabilityOptions): StabilityInput {
	const dates: StabilityDateInput[] = opts.dates.map((date) => {
		const runs: StabilityRunInput[] = opts.experiments.map((experiment) => {
			const paths = resolvePaths(opts.root, experiment);
			if (!existsSync(paths.runsDir)) {
				throw new Error(`experiment "${experiment}" has no runs directory at ${paths.runsDir}`);
			}
			const dateDir = join(paths.runsDir, date);
			if (!existsSync(dateDir)) {
				throw new Error(`experiment "${experiment}" has no run for date ${date} (expected ${dateDir})`);
			}
			const runId = latestRunId(dateDir);
			const runDir = join(dateDir, runId);
			const brief = DailyBrief.parse(readJson(join(runDir, "brief.json")));
			const ledger = StoryLedgerEntry.array().parse(readJson(join(runDir, "story-ledger.json")));
			return { experiment, runId, ledger, brief, models: readModelsFromAttempts(runDir) };
		});
		const gold = GoldTruth.parse(readJson(join(opts.root, "eval", "gold", `${date}.json`)));
		return { date, gold, runs };
	});
	return { dates };
}
