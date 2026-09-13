#!/usr/bin/env tsx
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeJsonAtomic, writeTextAtomic } from "../runtime/atomic-json.ts";
import { evaluate, loadEvalInput } from "../eval/evaluator.ts";
import { renderEvalMarkdown, renderManualReviewMarkdown } from "../eval/report.ts";

function parseArgs(argv: string[]): Map<string, string> {
	const out = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === undefined || !arg.startsWith("--")) continue;
		const next = argv[i + 1];
		out.set(arg.slice(2), next !== undefined && !next.startsWith("--") ? next : "true");
		if (next !== undefined && !next.startsWith("--")) i += 1;
	}
	return out;
}

/** Newest run directory by mtime, ties broken by name so the choice is stable. */
function latestRunId(dateDir: string): string {
	const entries = readdirSync(dateDir).filter((name) => statSync(join(dateDir, name)).isDirectory());
	if (entries.length === 0) throw new Error(`no run directories under ${dateDir}`);
	entries.sort((a, b) => {
		const delta = statSync(join(dateDir, b)).mtimeMs - statSync(join(dateDir, a)).mtimeMs;
		return delta !== 0 ? delta : a < b ? -1 : 1;
	});
	const first = entries[0];
	if (first === undefined) throw new Error(`no run directories under ${dateDir}`);
	return first;
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	const date = args.get("date");
	if (!date) {
		console.error("usage: pnpm eval:run --date <YYYY-MM-DD> [--run-id <id>]");
		process.exit(2);
		return;
	}
	const root = resolve(args.get("root") ?? process.cwd());
	const dateDir = join(root, "runs", date);
	const runId = args.get("run-id") ?? latestRunId(dateDir);
	const runDir = join(dateDir, runId);

	const input = loadEvalInput(runDir, date, {
		goldDir: args.get("gold-dir") ?? join(root, "eval", "gold"),
		fixturesDir: args.get("fixtures-dir") ?? join(root, "fixtures", "generated"),
	});
	const report = evaluate(input, runId);

	const markdown = renderEvalMarkdown(report);
	writeJsonAtomic(join(runDir, "evaluation.json"), report);
	writeTextAtomic(join(runDir, "evaluation.md"), markdown);
	writeTextAtomic(
		join(runDir, "MANUAL_REVIEW.md"),
		renderManualReviewMarkdown(input.brief, report),
	);

	process.stdout.write(markdown);
	if (!report.overallPass) process.exit(1);
}

main();
