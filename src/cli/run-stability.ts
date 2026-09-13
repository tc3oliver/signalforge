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

	const outDir = join(root, "docs");
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
