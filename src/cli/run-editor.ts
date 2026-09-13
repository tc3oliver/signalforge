import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseFlags, projectRoot, requireString } from "./_args.ts";
import { loadManifest, resolvePaths } from "../runtime/orchestrator.ts";
import { readJson, writeJsonAtomic, writeTextAtomic } from "../runtime/atomic-json.ts";
import { JsonStoryRepository } from "../stories/json-repository.ts";
import { runEditorStage } from "../editor/session.ts";
import { renderBriefMarkdown } from "../renderer/markdown.ts";
import { MODEL_CHAIN } from "../runtime/model-config.ts";
import { RouterState, runStageWithFallback } from "../runtime/model-router.ts";
import { createPiAgentDriver } from "../runtime/agent-driver.ts";
import type { DailyMaterials } from "../schemas/index.ts";

const flags = parseFlags(process.argv.slice(2));
const date = requireString(flags, "date");
const paths = resolvePaths(projectRoot(), flags.experiment as string | undefined);

/** Editor runs against an existing curated run, in its own fresh session. */
const dayDir = join(paths.runsDir, date);
const runId =
	typeof flags["run-id"] === "string" ? flags["run-id"] : readdirSync(dayDir).sort().at(-1);
if (!runId) throw new Error(`No run found under ${dayDir}. Run phase1:curate first.`);
const runDir = join(dayDir, runId);

const manifest = loadManifest(paths, date);
const materials = readJson<DailyMaterials>(join(runDir, "materials.json"));
const repo = new JsonStoryRepository(paths.ledgerDir);
const routerState = new RouterState();

const result = await runStageWithFallback({
	stage: "EDITOR",
	chain: MODEL_CHAIN,
	routerState,
	recordAttempt: (a) => console.error(JSON.stringify(a)),
	onAttempt: ({ spec, mode }) =>
		runEditorStage({
			date,
			manifest,
			materials,
			repo,
			spec,
			skillsRoot: paths.skillsRoot,
			cwd: runDir,
			driverFactory: createPiAgentDriver,
			mode,
		}),
});

writeJsonAtomic(join(runDir, "brief.json"), result.brief);
writeTextAtomic(
	join(runDir, "brief.md"),
	renderBriefMarkdown(result.brief, { facts: manifest.facts, items: manifest.items }),
);
console.log(`brief written: ${runDir}/brief.md (${result.brief.stories.length} stories)`);
