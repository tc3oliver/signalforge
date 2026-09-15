import { createSql } from "../db/client.ts";
import { purgeLineage } from "../db/test-support.ts";
import { parseFlags } from "./_args.ts";

/*
 * Delete the rows that are not production: the integration suites' lineages and
 * the demo seeder's.
 *
 * The suites write into the same database the pipeline publishes from, isolated
 * by lineage, and their teardown used to stop at the lineage-keyed tables --
 * `daily_runs` and everything hanging off it survived. By 2026-09-15 the live
 * database held 194 abandoned `test-*` lineages against 1 real one. The
 * teardown is fixed (`purgeLineage` in src/db/test-support.ts), so from now on
 * nothing new accumulates; this is for what is already there.
 *
 * It matches on the `test-` prefix that `testLineage()` stamps, and on nothing
 * else. A real lineage cannot be named that way by the pipeline, and the
 * command prints what it will delete and requires --yes before deleting
 * anything, because the argument for "this row is disposable" is exactly the
 * argument that goes wrong quietly.
 */

const TEST_LINEAGE_PREFIX = "test-";

/**
 * The demo seeder's lineage and its fixture collectors.
 *
 * `pnpm demo` (web/scripts/seed-dev.ts) writes a browsable day into its own
 * lineage so it can never be mistaken for published output, which works -- but
 * it has no teardown, so its source_configs, collection_runs and raw_items
 * survive every reset and accumulate. Same shape as the test residue, same fix.
 */
const DEMO_LINEAGE = process.env["DI_SEED_LINEAGE"]?.trim() || "web-dev";
const FIXTURE_COLLECTOR_PREFIXES = ["seed-", "fake-"];

interface Candidate {
	lineage: string;
	runs: number;
}

/** `collector_id like 'seed-%' or collector_id like 'fake-%'`, as one fragment. */
function fixtureMatch(sql: ReturnType<typeof createSql>, column: string) {
	return FIXTURE_COLLECTOR_PREFIXES.map((p) => sql`${sql(column)} like ${`${p}%`}`).reduce(
		(acc, frag) => sql`${acc} or ${frag}`,
	);
}

async function main(): Promise<void> {
	const flags = parseFlags(process.argv.slice(2));
	const sql = createSql();
	try {
		const rows = await sql<{ lineage: string; n: string }[]>`
			select lineage, count(*)::text as n
			from daily_runs
			where lineage like ${`${TEST_LINEAGE_PREFIX}%`} or lineage = ${DEMO_LINEAGE}
			group by lineage
			order by lineage
		`;
		const candidates: Candidate[] = rows.map((r) => ({ lineage: r.lineage, runs: Number(r.n) }));

		/*
		 * Rows written by a fixture collector but never attached to a daily_run
		 * are not reachable from a lineage, so a lineage purge cannot see them.
		 * Counted separately for the same reason: they outlive the lineages, so
		 * "no lineages left" must not be read as "nothing left".
		 */
		const orphans = await sql<{ collection_runs: string; raw_items: string; source_configs: string }[]>`
			select
				(select count(*)::text from collection_runs where ${fixtureMatch(sql, "collector_id")}) as collection_runs,
				(select count(*)::text from raw_items where collection_run_id in (
					select collection_run_id from collection_runs where ${fixtureMatch(sql, "collector_id")}
				)) as raw_items,
				(select count(*)::text from source_configs where ${fixtureMatch(sql, "collector_id")}) as source_configs
		`;
		const orphanCounts = {
			collectionRuns: Number(orphans[0]?.collection_runs ?? 0),
			rawItems: Number(orphans[0]?.raw_items ?? 0),
			sourceConfigs: Number(orphans[0]?.source_configs ?? 0),
		};
		const orphanTotal = orphanCounts.collectionRuns + orphanCounts.rawItems + orphanCounts.sourceConfigs;

		if (candidates.length === 0 && orphanTotal === 0) {
			console.log("Nothing to prune: no test or demo lineages, no fixture-collector rows.");
			return;
		}

		if (candidates.length > 0) {
			const totalRuns = candidates.reduce((sum, c) => sum + c.runs, 0);
			console.log(`${candidates.length} non-production lineage(s), ${totalRuns} run(s):`);
			for (const c of candidates.slice(0, 10)) console.log(`  ${c.lineage} (${c.runs})`);
			if (candidates.length > 10) console.log(`  ... and ${candidates.length - 10} more`);
		}
		if (orphanTotal > 0) {
			console.log(
				`Fixture-collector rows (${FIXTURE_COLLECTOR_PREFIXES.map((p) => `${p}*`).join(", ")}): ` +
					`${orphanCounts.collectionRuns} collection run(s), ${orphanCounts.rawItems} raw item(s), ` +
					`${orphanCounts.sourceConfigs} source config(s).`,
			);
		}

		// Named so an operator can see that the real lineage is not in scope.
		const [live] = await sql<{ n: string }[]>`
			select count(*)::text as n from daily_runs
			where lineage not like ${`${TEST_LINEAGE_PREFIX}%`} and lineage <> ${DEMO_LINEAGE}
		`;
		console.log(`Leaving ${Number(live?.n ?? 0)} run(s) in production lineages untouched.`);

		if (flags["yes"] !== true) {
			console.log("\nDry run. Re-run with --yes to delete.");
			return;
		}

		for (const c of candidates) await purgeLineage(sql, c.lineage);
		if (candidates.length > 0) console.log(`\nDeleted ${candidates.length} lineage(s).`);

		if (orphanTotal > 0) {
			await sql`delete from raw_items where collection_run_id in (
				select collection_run_id from collection_runs where ${fixtureMatch(sql, "collector_id")}
			)`;
			await sql`delete from collection_runs where ${fixtureMatch(sql, "collector_id")}`;
			await sql`delete from source_configs where ${fixtureMatch(sql, "collector_id")}`;
			console.log(`Deleted ${orphanTotal} fixture-collector row(s).`);
		}
	} finally {
		await sql.end({ timeout: 5 });
	}
}

await main();
