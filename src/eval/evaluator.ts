import { join } from "node:path";
import { readJson, readJsonIfExists } from "../runtime/atomic-json.ts";
import { DailyBrief } from "../schemas/brief.ts";
import { ItemDecision } from "../schemas/decision.ts";
import { GoldTruth, type EvalReport } from "../schemas/gold.ts";
import { DailyManifest } from "../schemas/manifest.ts";
import { DailyMaterials } from "../schemas/materials.ts";
import { StoryLedgerEntry } from "../schemas/story.ts";
import { computeMetrics, type EvalInput } from "./metrics.ts";

export function evaluate(input: EvalInput, runId = "unknown"): EvalReport {
	const metrics = computeMetrics(input);
	const failedGates = metrics.filter((m) => m.pass === false).map((m) => m.name);
	return {
		date: input.date,
		runId,
		evaluatedAt: new Date().toISOString(),
		metrics,
		overallPass: failedGates.length === 0,
		failedGates,
	};
}

export interface LoadEvalInputOptions {
	goldDir: string;
	fixturesDir: string;
}

/**
 * Read one run's artifacts off disk. The brief is parsed leniently: a brief that
 * fails its schema is still evaluated, with `schema_validity` recording the fact,
 * because "the model produced garbage" is a result and not a crash.
 */
export function loadEvalInput(
	runDir: string,
	date: string,
	opts: LoadEvalInputOptions,
): EvalInput {
	const manifest = DailyManifest.parse(readJson(join(runDir, "manifest.json")));
	const decisions = ItemDecision.array().parse(readJson(join(runDir, "item-decisions.json")));
	const ledger = StoryLedgerEntry.array().parse(readJson(join(runDir, "story-ledger.json")));
	const materials = DailyMaterials.parse(readJson(join(runDir, "materials.json")));
	const gold = GoldTruth.parse(readJson(join(opts.goldDir, `${date}.json`)));

	const rawBrief = readJson<unknown>(join(runDir, "brief.json"));
	const parsed = DailyBrief.safeParse(rawBrief);
	const brief = parsed.success ? parsed.data : (rawBrief as DailyBrief);

	const retries = readRetryCount(runDir);

	return {
		date,
		gold,
		manifest,
		decisions,
		ledger,
		materials,
		brief,
		briefSchemaValid: parsed.success,
		structuredOutputRetriesNeeded: retries,
		structuredOutputFinallyValid: parsed.success,
	};
}

/**
 * Failed editor attempts, which is what `structured_output_after_retry` reports.
 *
 * They live in `attempts.json` — a bare array appended to by
 * `RunStateStore.appendAttempt` — and never in `run-state.json`, which is a
 * strict object with no `attempts` key. Reading the wrong file pinned this
 * metric at 0 for every run, so a model that needed three tries to produce a
 * valid brief scored the same as one that got it right first time.
 *
 * The file is optional: a run that never recorded an attempt has no retries.
 */
function readRetryCount(runDir: string): number {
	const attempts = readJsonIfExists<{ stage?: string; status?: string }[]>(
		join(runDir, "attempts.json"),
	);
	if (!Array.isArray(attempts)) return 0;
	return attempts.filter((a) => a.stage === "EDITOR" && a.status === "FAILED").length;
}
