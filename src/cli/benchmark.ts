import { join } from "node:path";
import { parseFlags, projectRoot } from "./_args.ts";
import { resolvePaths, runPhase1Day } from "../runtime/orchestrator.ts";
import { evaluate, loadEvalInput } from "../eval/evaluator.ts";
import { MODEL_CHAIN, modelKey, type ModelSpec } from "../runtime/model-config.ts";
import { resolveModel } from "../runtime/pi-runtime.ts";
import { writeJsonAtomic, writeTextAtomic } from "../runtime/atomic-json.ts";

/**
 * Cross-model benchmark.
 *
 * A full 3 models x 3 dates x N repeats sweep is a lot of subscription quota, so
 * this deliberately does nothing large by default: with no --models and no --dates
 * it runs a resolve-only check and prints the command needed for a real sweep.
 */

const flags = parseFlags(process.argv.slice(2));
const paths = resolvePaths(projectRoot());

const ALIASES: Record<string, ModelSpec> = {
	gemini: MODEL_CHAIN[0]!,
	gpt: MODEL_CHAIN[1]!,
	deepseek: MODEL_CHAIN[2]!,
};

function parseModels(raw: unknown): ModelSpec[] {
	if (typeof raw !== "string") return [];
	return raw.split(",").map((token) => {
		const key = token.trim().toLowerCase();
		if (ALIASES[key]) return ALIASES[key]!;
		const [provider, model] = token.trim().split("/");
		if (!provider || !model) {
			throw new Error(`Cannot parse model "${token}". Use gemini|gpt|deepseek or provider/model.`);
		}
		return { provider, model };
	});
}

const models = parseModels(flags["models"]);
const dates = typeof flags["dates"] === "string" ? flags["dates"].split(",").map((d) => d.trim()) : [];
const repeat = typeof flags["repeat"] === "string" ? Number.parseInt(flags["repeat"], 10) : 1;

// --- Always: prove every model in the chain resolves. Cheap, no tokens spent. ---
const resolution: { model: string; resolved: boolean; error?: string }[] = [];
for (const spec of MODEL_CHAIN) {
	try {
		await resolveModel(spec);
		resolution.push({ model: modelKey(spec), resolved: true });
	} catch (err) {
		resolution.push({
			model: modelKey(spec),
			resolved: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
console.log("Model resolution:");
for (const r of resolution) {
	console.log(`  ${r.resolved ? "OK  " : "FAIL"} ${r.model}${r.error ? ` — ${r.error}` : ""}`);
}

if (models.length === 0 || dates.length === 0) {
	console.log(
		[
			"",
			"No sweep requested. A live cross-model sweep costs real subscription quota, so it is opt-in:",
			"",
			"  pnpm benchmark:models --models gemini,gpt,deepseek --dates 2026-09-12 --repeat 1",
			"",
			"Each (model, date, repeat) cell is one full curator+editor run over ~85 items.",
		].join("\n"),
	);
	process.exit(resolution.every((r) => r.resolved) ? 0 : 1);
}

interface Cell {
	model: string;
	date: string;
	iteration: number;
	recall: number | null;
	precision: number | null;
	clusterF1: number | null;
	changeTypeAccuracy: number | null;
	validationFailures: number;
	latencyMs: number;
	fallbackCount: number;
	/** The SDK exposes no reliable per-run token or cost total here, so this is not guessed. */
	tokens: "N/A";
	cost: "N/A";
	error?: string;
}

const cells: Cell[] = [];
const metric = (report: ReturnType<typeof evaluate>, name: string) =>
	report.metrics.find((m) => m.name === name)?.value ?? null;

for (const spec of models) {
	for (const date of dates) {
		for (let i = 1; i <= repeat; i++) {
			const started = Date.now();
			try {
				// Pinning the chain to a single model is what makes this a per-model
				// measurement rather than a measurement of the fallback chain.
				const run = await runPhase1Day({ date, paths, chain: [spec] });
				const input = loadEvalInput(run.runDir, date, {
					goldDir: paths.goldDir,
					fixturesDir: paths.fixturesDir,
				});
				input.structuredOutputRetriesNeeded = run.editorRejectedSubmissions;
				input.structuredOutputFinallyValid = true;
				const report = evaluate(input);
				cells.push({
					model: modelKey(spec),
					date,
					iteration: i,
					recall: metric(report, "important_story_recall"),
					precision: metric(report, "selected_story_precision"),
					clusterF1: metric(report, "cluster_f1"),
					changeTypeAccuracy: metric(report, "change_type_accuracy"),
					validationFailures: run.editorRejectedSubmissions,
					latencyMs: Date.now() - started,
					fallbackCount: run.fallbackOccurred ? 1 : 0,
					tokens: "N/A",
					cost: "N/A",
				});
			} catch (err) {
				cells.push({
					model: modelKey(spec),
					date,
					iteration: i,
					recall: null,
					precision: null,
					clusterF1: null,
					changeTypeAccuracy: null,
					validationFailures: 0,
					latencyMs: Date.now() - started,
					fallbackCount: 0,
					tokens: "N/A",
					cost: "N/A",
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}
}

const fmt = (v: number | null) => (v === null ? "n/a" : v.toFixed(3));
const table = [
	"| Model | Date | # | Recall | Precision | Cluster F1 | ChangeType | Validation fails | Latency (s) | Fallbacks | Tokens | Cost |",
	"|---|---|---|---|---|---|---|---|---|---|---|---|",
	...cells.map(
		(c) =>
			`| ${c.model} | ${c.date} | ${c.iteration} | ${fmt(c.recall)} | ${fmt(c.precision)} | ${fmt(c.clusterF1)} | ${fmt(c.changeTypeAccuracy)} | ${c.validationFailures} | ${(c.latencyMs / 1000).toFixed(1)} | ${c.fallbackCount} | ${c.tokens} | ${c.cost} |`,
	),
].join("\n");

const outDir = join(paths.root, "runs", "_benchmark");
writeJsonAtomic(join(outDir, `benchmark-${Date.now()}.json`), { resolution, cells });
writeTextAtomic(join(outDir, "latest.md"), `# Cross-model benchmark\n\n${table}\n`);
console.log(`\n${table}\n\nWritten to ${outDir}/latest.md`);
