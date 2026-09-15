import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql, type Sql } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import {
	announceSkip,
	probeDatabase,
	purgeIssuedLineages,
	purgeLineage,
	testLineage,
} from "../src/db/test-support.ts";

/*
 * The integration suites write into the same database the pipeline publishes
 * from, isolated by lineage. That isolation held -- nothing user-visible ever
 * read a test row -- but the purge stopped at the lineage-keyed tables and left
 * `daily_runs` and everything hanging off it behind, so every run added rows
 * that nothing would ever delete. The live database had reached 194 abandoned
 * `test-*` lineages, 197 `fake-broken` and 242 `fake-good` collection runs,
 * against 1 real lineage.
 *
 * So the purge is now tested like any other behaviour, because a teardown that
 * silently does half its job looks exactly like one that works.
 */

const probe = await probeDatabase();
announceSkip("db-purge-lineage", probe);

let sql: Sql;

beforeAll(async () => {
	if (!probe.available) return;
	sql = createSql();
	await migrate(sql);
});

afterAll(async () => {
	if (!probe.available) return;
	await purgeIssuedLineages(sql);
	await sql.end({ timeout: 5 });
});

/** One run with a row in every table that hangs off it. */
async function seedRun(lineage: string, runId: string): Promise<void> {
	const t = "2026-09-15T00:00:00Z";
	await sql`insert into daily_runs (run_id, lineage, date, status) values (${runId}, ${lineage}, '2026-09-15', 'PUBLISHED')`;
	await sql`insert into agent_runs (run_id, stage, status, started_at) values (${runId}, 'CURATOR', 'SUCCESS', ${t})`;
	await sql`insert into agent_attempts (attempt_id, run_id, stage, provider, model, started_at, finished_at, duration_ms, status)
		values (${`att-${runId}`}, ${runId}, 'CURATOR', 'p', 'm', ${t}, ${t}, 1, 'SUCCESS')`;
	await sql`insert into collection_runs (collection_run_id, run_id, collector_id, health, started_at, finished_at, latency_ms)
		values (${`cr-${runId}`}, ${runId}, 'fake-good', 'OK', ${t}, ${t}, 1)`;
	// raw_item_id is assigned by the database; only the parent link matters here.
	await sql`insert into raw_items (collection_run_id, source_type, source_name, external_id, body, fetched_at)
		values (${`cr-${runId}`}, 'rss', 'fake', ${`ext-${runId}`}, '{}'::jsonb, ${t})`;
}

async function countsFor(runId: string): Promise<Record<string, number>> {
	const [row] = await sql<{ runs: string; agents: string; attempts: string; collections: string; raws: string }[]>`
		select
			(select count(*) from daily_runs where run_id = ${runId}) as runs,
			(select count(*) from agent_runs where run_id = ${runId}) as agents,
			(select count(*) from agent_attempts where run_id = ${runId}) as attempts,
			(select count(*) from collection_runs where run_id = ${runId}) as collections,
			(select count(*) from raw_items where collection_run_id = ${`cr-${runId}`}) as raws
	`;
	return {
		daily_runs: Number(row?.runs ?? 0),
		agent_runs: Number(row?.agents ?? 0),
		agent_attempts: Number(row?.attempts ?? 0),
		collection_runs: Number(row?.collections ?? 0),
		raw_items: Number(row?.raws ?? 0),
	};
}

describe.skipIf(!probe.available)("purgeLineage", () => {
	it("leaves nothing behind, run rows and their children included", async () => {
		const lineage = testLineage("purge");
		const runId = `run-${lineage}`;
		await seedRun(lineage, runId);

		expect(await countsFor(runId)).toEqual({
			daily_runs: 1,
			agent_runs: 1,
			agent_attempts: 1,
			collection_runs: 1,
			raw_items: 1,
		});

		await purgeLineage(sql, lineage);

		expect(await countsFor(runId)).toEqual({
			daily_runs: 0,
			agent_runs: 0,
			agent_attempts: 0,
			collection_runs: 0,
			raw_items: 0,
		});
	});

	it("touches only the lineage it was given", async () => {
		const mine = testLineage("purge-mine");
		const theirs = testLineage("purge-theirs");
		await seedRun(mine, `run-${mine}`);
		await seedRun(theirs, `run-${theirs}`);

		await purgeLineage(sql, mine);

		expect((await countsFor(`run-${mine}`))["daily_runs"]).toBe(0);
		expect((await countsFor(`run-${theirs}`))["daily_runs"]).toBe(1);
	});

	it("purges every lineage the process issued, not only the ones a suite remembered", async () => {
		// The actual failure: a suite that names a lineage per scenario purges the
		// one it kept in a variable and abandons the rest.
		const a = testLineage("purge-registry-a");
		const b = testLineage("purge-registry-b");
		await seedRun(a, `run-${a}`);
		await seedRun(b, `run-${b}`);

		await purgeIssuedLineages(sql);

		expect((await countsFor(`run-${a}`))["daily_runs"]).toBe(0);
		expect((await countsFor(`run-${b}`))["daily_runs"]).toBe(0);
	});
});
