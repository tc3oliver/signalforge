import type { DailyBrief } from "../schemas/brief.ts";
import type { EvalReport, MetricResult } from "../schemas/gold.ts";

function formatValue(metric: MetricResult): string {
	if (metric.value === null) return "n/a";
	return metric.unit === "ratio" ? metric.value.toFixed(3) : String(metric.value);
}

function formatThreshold(metric: MetricResult): string {
	switch (metric.comparator) {
		case "gte":
			return `>= ${metric.threshold}`;
		case "lte":
			return `<= ${metric.threshold}`;
		case "eq":
			return `== ${metric.threshold}`;
		case "range":
			// The bounds are computed per day from the material count, so they can
			// legitimately read 5..5 on a quiet day. Printing a fixed "8..15" here
			// would put a range in evaluation.md that the gate above it never
			// applied, which is the one thing a review document may not do.
			return metric.thresholdMax === null
				? `>= ${metric.threshold}`
				: `${metric.threshold}..${metric.thresholdMax}`;
		default:
			return "—";
	}
}

function formatPass(metric: MetricResult): string {
	if (metric.pass === null) return "—";
	return metric.pass ? "PASS" : "FAIL";
}

export function renderEvalMarkdown(report: EvalReport): string {
	const lines: string[] = [
		`# Evaluation — ${report.date}`,
		"",
		`Run: \`${report.runId}\`  ·  Evaluated: ${report.evaluatedAt}`,
		`Overall: **${report.overallPass ? "PASS" : "FAIL"}**`,
		"",
		"| Metric | Value | Threshold | Pass |",
		"| --- | --- | --- | --- |",
	];
	for (const metric of report.metrics) {
		lines.push(
			`| ${metric.name} | ${formatValue(metric)} | ${formatThreshold(metric)} | ${formatPass(metric)} |`,
		);
	}
	lines.push("", "## Failed gates", "");
	if (report.failedGates.length === 0) {
		lines.push("None.");
	} else {
		for (const name of report.failedGates) {
			const metric = report.metrics.find((m) => m.name === name);
			lines.push(`- **${name}** — ${metric?.detail ?? "(no detail recorded)"}`);
		}
	}
	lines.push("", "## Detail", "");
	for (const metric of report.metrics) {
		lines.push(`- \`${metric.name}\`: ${metric.detail}`);
	}
	return `${lines.join("\n")}\n`;
}

function renderBriefReference(brief: DailyBrief): string {
	const lines: string[] = [`## Brief reference — ${brief.date}`, ""];
	for (const story of brief.stories) {
		lines.push(
			`- ${story.mustKnow ? "**[MUST KNOW]** " : ""}${story.title} _(${story.section}, ${story.confidence}, \`${story.storyId}\`)_`,
		);
		lines.push(`  - What happened: ${story.whatHappened}`);
		lines.push(`  - Why it matters: ${story.whyItMatters}`);
		lines.push(`  - What changed: ${story.whatChanged}`);
		lines.push(`  - Sources: ${story.sourceItemIds.join(", ")}`);
	}
	if (brief.emergingSignals.length > 0) {
		lines.push("", "### Emerging signals", "");
		for (const signal of brief.emergingSignals) lines.push(`- **${signal.label}** — ${signal.body}`);
	}
	lines.push("", "### Daily analysis", "", brief.dailyAnalysis, "", "### Watch next", "");
	for (const item of brief.watchNext) lines.push(`- ${item}`);
	return lines.join("\n");
}

export function renderManualReviewMarkdown(brief: DailyBrief, report: EvalReport): string {
	const summary: string[] = [
		"## Automated metrics",
		"",
		"| Metric | Value | Threshold | Pass |",
		"| --- | --- | --- | --- |",
	];
	for (const metric of report.metrics) {
		summary.push(
			`| ${metric.name} | ${formatValue(metric)} | ${formatThreshold(metric)} | ${formatPass(metric)} |`,
		);
	}
	summary.push("", `Overall: **${report.overallPass ? "PASS" : "FAIL"}**`);
	if (report.failedGates.length > 0) {
		summary.push("", "Failed gates:");
		for (const name of report.failedGates) {
			const metric = report.metrics.find((m) => m.name === name);
			summary.push(`- **${name}** — ${metric?.detail ?? "(no detail recorded)"}`);
		}
	}

	return [
		`# Manual review — ${report.date}`,
		"",
		`Run: \`${report.runId}\``,
		"",
		renderBriefReference(brief),
		"",
		summary.join("\n"),
		"",
		"## Human score",
		"Would I read this every morning? (1-5): ___",
		"Notes:",
		"",
		"Target: >= 4. This field is filled in by the human only — the evaluator never prefills, guesses or infers it.",
		"",
	].join("\n");
}
