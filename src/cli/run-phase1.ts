import { parseFlags, projectRoot, requireString } from "./_args.ts";
import { resolvePaths, runPhase1Day } from "../runtime/orchestrator.ts";
import { evaluate, loadEvalInput } from "../eval/evaluator.ts";
import { renderEvalMarkdown, renderManualReviewMarkdown } from "../eval/report.ts";
import { writeJsonAtomic, writeTextAtomic } from "../runtime/atomic-json.ts";
import { join } from "node:path";

const flags = parseFlags(process.argv.slice(2));
const date = requireString(flags, "date");
const paths = resolvePaths(projectRoot(), flags.experiment as string | undefined);

const run = await runPhase1Day({ date, paths });
console.log(`run ${run.runId} completed -> ${run.runDir}`);
console.log(`stories=${run.brief?.stories.length} attempts=${run.attempts} fallback=${run.fallbackOccurred}`);

// Curator -> Editor -> Validator all passed; evaluation closes the loop.
const input = loadEvalInput(run.runDir, date, {
	goldDir: paths.goldDir,
	fixturesDir: paths.fixturesDir,
});
input.structuredOutputRetriesNeeded = run.editorRejectedSubmissions;
input.structuredOutputFinallyValid = true;
const report = evaluate(input);

writeJsonAtomic(join(run.runDir, "evaluation.json"), report);
writeTextAtomic(join(run.runDir, "evaluation.md"), renderEvalMarkdown(report));
writeTextAtomic(
	join(run.runDir, "MANUAL_REVIEW.md"),
	renderManualReviewMarkdown(run.brief!, report),
);
writeTextAtomic(
	join(run.runDir, "summary.md"),
	[
		`# Run ${run.runId} (${date})`,
		"",
		`- stories: ${run.brief?.stories.length}`,
		`- must know: ${run.brief?.stories.filter((s) => s.mustKnow).length}`,
		`- attempts: ${run.attempts}`,
		`- fallback occurred: ${run.fallbackOccurred}`,
		`- evaluation: ${report.overallPass ? "PASS" : "FAIL"}`,
		...(report.failedGates.length ? [`- failed gates: ${report.failedGates.join(", ")}`] : []),
	].join("\n") + "\n",
);

console.log(renderEvalMarkdown(report));
if (!report.overallPass) process.exitCode = 1;
