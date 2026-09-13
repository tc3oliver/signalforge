import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql, dbConfigFromEnv, type Sql } from "../src/db/client.ts";
import { loadMigrations, migrate } from "../src/db/migrate.ts";
import { announceSkip, probeDatabase } from "../src/db/test-support.ts";

const probe = await probeDatabase();
announceSkip("db-migrations", probe);

// Each run migrates a throwaway schema, so "applies cleanly to an empty
// database" is actually tested rather than asserted against a schema someone
// already migrated by hand.
const SCHEMA = `mig_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!probe.available)("migrations", () => {
	let admin: Sql;
	let sql: Sql;

	beforeAll(async () => {
		admin = createSql();
		await admin.unsafe(`create schema "${SCHEMA}"`);
		// `public` stays on the path so the vector / pg_trgm types installed there resolve.
		sql = createSql({ ...dbConfigFromEnv(), searchPath: `"${SCHEMA}", public`, max: 2 });
	});

	afterAll(async () => {
		await sql?.end({ timeout: 5 });
		await admin?.unsafe(`drop schema if exists "${SCHEMA}" cascade`);
		await admin?.end({ timeout: 5 });
	});

	it("discovers numbered migration files", () => {
		const files = loadMigrations();
		expect(files.length).toBeGreaterThan(0);
		expect(files[0]?.name).toBe("001_init.sql");
		expect(files.map((f) => f.version)).toEqual([...files.map((f) => f.version)].sort((a, b) => a - b));
	});

	it("applies cleanly to an empty database and records the ledger", async () => {
		const result = await migrate(sql);
		expect(result.applied).toContain("001_init.sql");
		expect(result.skipped).toEqual([]);

		const rows = await sql<{ version: number; name: string }[]>`
			select version, name from schema_migrations order by version
		`;
		expect(rows.map((r) => r.name)).toEqual(result.applied);
	});

	it("creates every expected table", async () => {
		const rows = await sql<{ table_name: string }[]>`
			select table_name from information_schema.tables where table_schema = ${SCHEMA}
		`;
		const tables = new Set(rows.map((r) => r.table_name));
		for (const expected of [
			"daily_runs", "collection_runs", "raw_items", "normalized_items", "story_ledger",
			"story_items", "item_decisions", "daily_materials", "daily_material_stories",
			"daily_brief_drafts", "daily_briefs", "daily_brief_stories", "structured_facts",
			"interest_profiles", "watchlists", "source_configs", "agent_runs", "agent_attempts",
			"emerging_signals", "schema_migrations",
		]) {
			expect(tables).toContain(expected);
		}
	});

	it("is re-runnable: a second pass applies nothing", async () => {
		const second = await migrate(sql);
		expect(second.applied).toEqual([]);
		expect(second.skipped).toEqual(loadMigrations().map((f) => f.name));
	});
});
