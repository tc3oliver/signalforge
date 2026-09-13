import { join } from "node:path";
import { parseFlags, projectRoot, requireString } from "./_args.ts";
import { computeStability, loadStabilityInput } from "../eval/stability.ts";
import type { StabilityReport } from "../schemas/stability.ts";
import { writeJsonAtomic, writeTextAtomic } from "../runtime/atomic-json.ts";

/**
 * The one stability metric with a gate. Two independent lineages must pick
 * substantially the same core stories out of the same day, or the product is
 * not reproducible enough to be trusted on a day nobody checks by hand.
 */
const CORE_STORY_SELECTION_METRIC = "core_story_selection_stability";
const CORE_STORY_SELECTION_GATE = 0.85;

function formatValue(value: number | null): string {
	return value === null ? "n/a" : value.toFixed(3);
}

function renderStabilityMarkdown(report: StabilityReport): string {
	const lines: string[] = [
		"# Stability report",
		"",
		`Generated: ${report.generatedAt}`,
		`Experiments: ${report.experiments.join(", ")}`,
		`Model(s) observed: ${report.models.length > 0 ? report.models.join(", ") : "unknown"}`,
		`Dates: ${report.dates.map((d) => d.date).join(", ")}`,
		"",
		"Each lineage ran the same days from its own empty ledger, so two lineages",
		"never shared story ids, decisions or run state. Runs are matched by item",
		"membership and gold event mapping -- never by comparing title strings,",
		"which would measure phrasing rather than agreement.",
		"",
		"## Acceptance gate",
		"",
		`| Metric | Gate | Observed (mean) | Result |`,
		"| --- | --- | --- | --- |",
		(() => {
			const core = report.overall.find((m) => m.name === CORE_STORY_SELECTION_METRIC);
			const observed = core?.mean ?? null;
			const verdict = observed === null ? "FAIL (not measured)" : observed >= CORE_STORY_SELECTION_GATE ? "PASS" : "FAIL";
			return `| ${CORE_STORY_SELECTION_METRIC} | >= ${CORE_STORY_SELECTION_GATE.toFixed(2)} | ${formatValue(observed)} | ${verdict} |`;
		})(),
		"",
		"The four metrics below it are recorded as measurements, not gates: they",
		"describe where two independent lineages agree and where they diverge.",
		"",
		"### How to read the other four",
		"",
		"`must_know_stability` and `cluster_stability` measure the same kind of",
		"agreement as the gate and should sit near it. `change_type_stability` is a",
		"per-story label match, so it moves in larger steps on a small brief.",
		"",
		"`emerging_signal_stability` is expected to be the lowest of the five, and a",
		"low number here is not the same kind of finding as a low number above. A",
		"signal is a weak pattern across items none of which earned a story slot;",
		"whether a given day contains one at all is a judgement call at the margin,",
		"and a day with one signal in one lineage and none in another scores zero",
		"for that day however reasonable both readings were. Treat it as a measure",
		"of how marginal the day was, not of whether the pipeline is reproducible.",
		"",
		"## Overall (mean across dates)",
		"",
		"| Metric | Mean | Unit |",
		"| --- | --- | --- |",
	];
	for (const metric of report.overall) {
		lines.push(`| ${metric.name} | ${formatValue(metric.mean)} | ${metric.unit} |`);
	}

	for (const date of report.dates) {
		lines.push(
			"",
			`## ${date.date}`,
			"",
			`Runs compared: ${date.runs.map((r) => `${r.experiment}=${r.runId}`).join(", ")}`,
			"",
			"| Metric | Mean | Unit |",
			"| --- | --- | --- |",
		);
		for (const metric of date.metrics) {
			lines.push(`| ${metric.name} | ${formatValue(metric.mean)} | ${metric.unit} |`);
		}
		for (const metric of date.metrics) {
			lines.push("", `### ${metric.name} — pairwise detail`, "");
			for (const pair of metric.pairs) {
				lines.push(
					`- ${pair.experimentA} vs ${pair.experimentB}: ${formatValue(pair.value)} — ${pair.detail}`,
				);
			}
		}
	}
	return `${lines.join("\n")}\n`;
}

function main(): void {
	const flags = parseFlags(process.argv.slice(2));
	const experiments = requireString(flags, "experiments")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const dates = requireString(flags, "dates")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (experiments.length < 2) {
		throw new Error(`--experiments needs at least 2 lineages to compare, got: ${experiments.join(",")}`);
	}
	if (dates.length === 0) {
		throw new Error("--dates must name at least one date");
	}

	const root = projectRoot();
	const input = loadStabilityInput({ root, experiments, dates });
	const report = computeStability(input);

	const core = report.overall.find((m) => m.name === CORE_STORY_SELECTION_METRIC);
	const gatePassed = core?.mean !== null && core?.mean !== undefined && core.mean >= CORE_STORY_SELECTION_GATE;

	const outDir = join(root, "docs", "reports");
	writeJsonAtomic(join(outDir, "stability.json"), report);
	writeTextAtomic(join(outDir, "STABILITY_REPORT.md"), renderStabilityMarkdown(report));

	console.log(renderStabilityMarkdown(report));
	console.log(`wrote ${join(outDir, "STABILITY_REPORT.md")} and stability.json`);

	// A failing gate must be visible to whatever ran this, not only to whoever
	// later reads the markdown.
	if (!gatePassed) {
		console.error(
			`STABILITY GATE FAILED: ${CORE_STORY_SELECTION_METRIC} = ${formatValue(core?.mean ?? null)} (needs >= ${CORE_STORY_SELECTION_GATE})`,
		);
		process.exitCode = 1;
	}
}

main();
