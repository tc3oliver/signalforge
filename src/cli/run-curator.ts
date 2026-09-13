import { parseFlags, projectRoot, requireString } from "./_args.ts";
import { resolvePaths, runPhase1Day } from "../runtime/orchestrator.ts";

const flags = parseFlags(process.argv.slice(2));
const date = requireString(flags, "date");
const paths = resolvePaths(projectRoot(), flags.experiment as string | undefined);

const result = await runPhase1Day({ date, paths, curateOnly: true });
console.log(
	`curated ${date}: ${result.materials.stories.length} stories -> ${result.runDir}/materials.json`,
);
console.log(`attempts=${result.attempts} fallback=${result.fallbackOccurred}`);
