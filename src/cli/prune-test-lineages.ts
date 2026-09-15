import { createSql } from "../db/client.ts";
import { purgeLineage } from "../db/test-support.ts";
import { parseFlags } from "./_args.ts";

/*
 * Delete the lineages the integration suites left behind.
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

interface Candidate {
	lineage: string;
	runs: number;
}

async function main(): Promise<void> {
	const flags = parseFlags(process.argv.slice(2));
	const sql = createSql();
	try {
		const rows = await sql<{ lineage: string; n: string }[]>`
			select lineage, count(*)::text as n
			from daily_runs
			where lineage like ${`${TEST_LINEAGE_PREFIX}%`}
			group by lineage
			order by lineage
		`;
		const candidates: Candidate[] = rows.map((r) => ({ lineage: r.lineage, runs: Number(r.n) }));

		if (candidates.length === 0) {
			console.log("No test lineages found. Nothing to do.");
			return;
		}

		const totalRuns = candidates.reduce((sum, c) => sum + c.runs, 0);
		console.log(`${candidates.length} test lineage(s), ${totalRuns} run(s):`);
		for (const c of candidates.slice(0, 10)) console.log(`  ${c.lineage} (${c.runs})`);
		if (candidates.length > 10) console.log(`  ... and ${candidates.length - 10} more`);

		// Named so an operator can see that the real lineage is not in scope.
		const [live] = await sql<{ n: string }[]>`
			select count(*)::text as n from daily_runs where lineage not like ${`${TEST_LINEAGE_PREFIX}%`}
		`;
		console.log(`Leaving ${Number(live?.n ?? 0)} run(s) in non-test lineages untouched.`);

		if (flags["yes"] !== true) {
			console.log("\nDry run. Re-run with --yes to delete.");
			return;
		}

		for (const c of candidates) await purgeLineage(sql, c.lineage);
		console.log(`\nDeleted ${candidates.length} test lineage(s).`);

		/*
		 * Collection runs seeded by a fixture collector but never attached to a
		 * daily_run are not reachable from a lineage, so the purge above cannot
		 * see them. They are identified by the collector ids the fake registry
		 * uses, which no real collector shares.
		 */
		const orphans = await sql`
			delete from collection_runs
			where run_id is null and collector_id in ('fake-good', 'fake-broken')
			returning collection_run_id
		`;
		if (orphans.length > 0) console.log(`Deleted ${orphans.length} orphaned fixture collection run(s).`);
	} finally {
		await sql.end({ timeout: 5 });
	}
}

await main();
