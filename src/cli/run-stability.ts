import { join } from "node:path";
import { parseFlags, projectRoot, requireString } from "./_args.ts";
import { computeStability, loadStabilityInput } from "../eval/stability.ts";
import type { StabilityReport } from "../schemas/stability.ts";
import { writeJsonAtomic, writeTextAtomic } from "../runtime/atomic-json.ts";

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
		"These metrics are descriptive measurements of agreement between independent",
		"lineages, not acceptance gates. There is no pass/fail here.",
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

	const outDir = join(root, "docs");
	writeJsonAtomic(join(outDir, "stability.json"), report);
	writeTextAtomic(join(outDir, "STABILITY_REPORT.md"), renderStabilityMarkdown(report));

	console.log(renderStabilityMarkdown(report));
	console.log(`wrote ${join(outDir, "STABILITY_REPORT.md")} and stability.json`);
}

main();
