import { parseFlags } from "./_args.ts";
import { createSql } from "../db/client.ts";
import { createPostgresCollectionStore, runCollectionForDay } from "../pipeline/collection.ts";
import { createLogger } from "../runtime/logger.ts";

/**
 * Collection only — what the daytime incremental cron calls. It never touches a
 * model, so it is cheap enough to run every hour, and a collector failing here
 * degrades the day rather than ending it.
 */
async function main(): Promise<number> {
	const flags = parseFlags(process.argv.slice(2));
	const date = typeof flags["date"] === "string" ? flags["date"] : new Date().toISOString().slice(0, 10);
	const lineage = typeof flags["lineage"] === "string" ? flags["lineage"] : process.env["DI_LINEAGE"] ?? "default";
	const since =
		typeof flags["since"] === "string" ? new Date(flags["since"]) : new Date(`${date}T00:00:00.000Z`);
	if (Number.isNaN(since.getTime())) throw new Error(`Invalid --since value`);

	const log = createLogger("collect");
	const sql = createSql();
	try {
		const summary = await runCollectionForDay({
			store: createPostgresCollectionStore(sql, lineage),
			since,
			...(typeof flags["run-id"] === "string" ? { runId: flags["run-id"] } : {}),
			log: (msg, fields) => log.info(msg, fields),
		});

		for (const outcome of summary.outcomes) {
			log.info("collector", {
				collector: outcome.collectorId,
				health: outcome.health,
				fetched: outcome.itemsFetched,
				inserted: outcome.itemsInserted,
				cursorAdvanced: outcome.cursorAdvanced,
				...(outcome.disabledReason ? { disabled: outcome.disabledReason } : {}),
				...(outcome.error ? { error: outcome.error } : {}),
			});
		}
		log.info("collection finished", {
			date,
			degraded: summary.degraded,
			itemsInserted: summary.itemsInserted,
		});

		// A degraded run is still a successful run: exiting non-zero would make a
		// scheduler retry work that already succeeded for ten other sources.
		return summary.empty && summary.degraded ? 1 : 0;
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
