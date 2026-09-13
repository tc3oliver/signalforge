import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parseFlags, projectRoot } from "./_args.ts";
import { loadConfig } from "../config/loader.ts";
import { hasSecret, resolveSecret } from "../config/secrets.ts";
import { createSql } from "../db/client.ts";
import { runDailyPipeline, type PipelineStage } from "../pipeline/daily-run.ts";
import { createExaProvider } from "../research/providers/exa.ts";
import { createTavilyProvider } from "../research/providers/tavily.ts";
import { ResearchBudgetTracker, ResearchRouter } from "../research/router.ts";
import type { CuratorResearchConfig } from "../curator/tools.ts";
import { createLogger } from "../runtime/logger.ts";
import { loadSecretsFileAndReport } from "../config/secrets-file.ts";
import { writeJsonAtomic, writeTextAtomic } from "../runtime/atomic-json.ts";

const STAGES: readonly PipelineStage[] = ["collect", "curate", "write", "validate", "publish"];

/**
 * `search_web` exists for this run only when a research provider is actually
 * configured. With no credential there is no router, no tool, and the curator's
 * tool set is byte-identical to an offline run's.
 */
async function buildResearch(): Promise<CuratorResearchConfig | undefined> {
	const secrets = { secret: (n: string) => resolveSecret(n), hasSecret: (n: string) => hasSecret(n) };
	if (!(await secrets.hasSecret("TAVILY_API_KEY")) && !(await secrets.hasSecret("EXA_API_KEY"))) {
		return undefined;
	}
	const budgets = loadConfig().agent.searchWeb;
	const tracker = new ResearchBudgetTracker({
		maxQueryLength: budgets.maxQueryLength,
		maxResults: budgets.maxResults,
		perRequestTimeoutMs: budgets.timeoutMs,
		maxCallsPerStory: budgets.maxCallsPerStory,
		maxCallsPerRun: budgets.maxCallsPerRun,
	});
	const router = new ResearchRouter(
		createTavilyProvider(globalThis.fetch, secrets),
		createExaProvider(globalThis.fetch, secrets),
		tracker,
	);
	return { router, maxResults: budgets.maxResults };
}

/**
 * Renames an existing brief pair to `<date>.v<n>.<ext>` and returns the version
 * stem used, or undefined when there was nothing to keep. `n` is the lowest
 * number not already taken, so repeated runs accumulate rather than collide.
 */
function archivePreviousBrief(
	outDir: string,
	date: string,
	jsonPath: string,
	markdownPath: string,
): string | undefined {
	if (!existsSync(jsonPath) && !existsSync(markdownPath)) return undefined;
	let n = 1;
	while (existsSync(join(outDir, `${date}.v${n}.json`)) || existsSync(join(outDir, `${date}.v${n}.md`))) n++;
	const stem = `${date}.v${n}`;
	if (existsSync(jsonPath)) renameSync(jsonPath, join(outDir, `${stem}.json`));
	if (existsSync(markdownPath)) renameSync(markdownPath, join(outDir, `${stem}.md`));
	return stem;
}

async function main(): Promise<number> {
	const flags = parseFlags(process.argv.slice(2));
	const date = typeof flags["date"] === "string" ? flags["date"] : new Date().toISOString().slice(0, 10);
	const lineage = typeof flags["lineage"] === "string" ? flags["lineage"] : process.env["DI_LINEAGE"] ?? "default";
	const resume = typeof flags["resume"] === "string" ? flags["resume"] : undefined;
	const stageFlag = typeof flags["stage"] === "string" ? flags["stage"] : undefined;
	if (stageFlag && !STAGES.includes(stageFlag as PipelineStage)) {
		throw new Error(`Unknown --stage "${stageFlag}". Expected one of: ${STAGES.join(", ")}`);
	}
	const stage = stageFlag as PipelineStage | undefined;
	if (stage && stage !== "collect" && !resume) {
		throw new Error(`--stage ${stage} retries a stage of an existing run; pass --resume <runId> too.`);
	}

	const log = createLogger("daily");
	// Before anything reads a credential: the operator's file outside the repo
	// populates the environment, and the resolver in config/secrets.ts then
	// behaves exactly as it always has (environment first, Keychain second).
	loadSecretsFileAndReport((msg, fields) => log.info(msg, fields));
	const root = projectRoot();
	const sql = createSql();
	try {
		const research = await buildResearch();
		if (!research) log.info("search_web disabled: no research provider credential configured");

		const result = await runDailyPipeline({
			sql,
			date,
			lineage,
			...(resume ? { runId: resume, skipCollection: stage !== "collect" && stage !== undefined } : {}),
			...(stage ? { stage } : {}),
			skillsRoot: join(root, "agent", "skills"),
			cwd: join(root, "runs"),
			// The chain comes from config/agent.yaml, not from the MODEL_CHAIN
			// constant. The constant remains the default the pipeline falls back
			// to, but an operator changing providers must be able to do it
			// without editing TypeScript -- which is the whole point of the file
			// existing. A test asserts the shipped config still matches the
			// constant, so the default cannot drift silently.
			chain: loadConfig().agent.modelChain,
			...(research ? { research } : {}),
			log: (msg, fields) => log.info(msg, fields),
			// Stage events -- tool calls, nudges, and above all the text of a
			// rejected submission -- go to the run log. Without this the one thing
			// worth knowing when a stage fails (what the validator actually said)
			// is discarded, and the log records only that it failed.
			onEvent: (event) => log.info(String(event["kind"] ?? "event"), event),
		});

		// The database is the canonical copy, but a brief that exists only inside
		// Postgres is not something the reader can keep, diff, grep or hand to
		// anything else. The pipeline already renders the markdown; discarding it
		// here was the only reason the day had no file on disk.
		if (result.state === "PUBLISHED" && result.brief) {
			const outDir = join(root, "briefs", date);
			mkdirSync(outDir, { recursive: true });
			const jsonPath = join(outDir, `${date}.json`);
			const markdownPath = join(outDir, `${date}.md`);
			// The database keeps every draft of a day (daily_brief_drafts.draft_no);
			// the files did not, so re-running a day silently destroyed the copy you
			// would want to diff the new one against. Retire the previous pair under
			// the next free version number before writing.
			const archived = archivePreviousBrief(outDir, date, jsonPath, markdownPath);
			if (archived !== undefined) {
				log.info("previous brief archived", { as: archived });
				console.log(`previous brief kept as: ${archived}`);
			}
			writeJsonAtomic(jsonPath, result.brief);
			if (result.markdown) writeTextAtomic(markdownPath, result.markdown);
			log.info("brief written", { json: jsonPath, ...(result.markdown ? { markdown: markdownPath } : {}) });
			console.log(`brief: ${jsonPath}`);
			if (result.markdown) console.log(`brief: ${markdownPath}`);
		}

		log.info("pipeline finished", {
			runId: result.runId,
			state: result.state,
			degraded: result.degraded,
			stories: result.brief?.stories.length ?? 0,
			signals: result.signalsWritten,
			attempts: result.attempts,
		});
		console.log(`run ${result.runId} -> ${result.state}${result.degraded ? " (DEGRADED)" : ""}`);
		return result.state === "PUBLISHED" || result.state === "COLLECTED" || result.state === "MATERIALS_READY"
			? 0
			: 1;
	} finally {
		await sql.end({ timeout: 5 });
	}
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(err: unknown) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	},
);
