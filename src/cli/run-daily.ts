import { mkdirSync } from "node:fs";
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
