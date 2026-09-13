import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql, dbConfigFromEnv, type Sql } from "../src/db/client.ts";
import {
	listCollectorStatus,
	recordCollectionRun,
	upsertSourceConfig,
} from "../src/db/collector-health.ts";
import { migrate } from "../src/db/migrate.ts";
import { announceSkip, probeDatabase } from "../src/db/test-support.ts";
import type { CollectorHealth, CollectorResult } from "../src/collectors/types.ts";

const probe = await probeDatabase();
announceSkip("db-collector-health", probe);

// Throwaway schema per run, same as db-migrations: the summary columns added by
// 003 are asserted against a database migrated from empty, not one someone
// migrated by hand.
const SCHEMA = `health_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

function result(
	collectorId: string,
	health: CollectorHealth,
	finishedAt: string,
	overrides: Partial<CollectorResult> = {},
): CollectorResult {
	return {
		collectorId,
		health,
		items: [],
		facts: [],
		itemsFetched: 0,
		warnings: [],
		startedAt: finishedAt,
		finishedAt,
		latencyMs: 1,
		...overrides,
	};
}

describe.skipIf(!probe.available)("collector health summary", () => {
	let admin: Sql;
	let sql: Sql;
	let runSeq = 0;

	const record = (r: CollectorResult) => recordCollectionRun(sql, `cr-${++runSeq}`, r);
	const statusOf = async (collectorId: string) =>
		(await listCollectorStatus(sql)).find((s) => s.collectorId === collectorId);

	beforeAll(async () => {
		admin = createSql();
		await admin.unsafe(`create schema "${SCHEMA}"`);
		sql = createSql({ ...dbConfigFromEnv(), searchPath: `"${SCHEMA}", public`, max: 2 });
		await migrate(sql);
	});

	afterAll(async () => {
		await sql?.end({ timeout: 5 });
		await admin?.unsafe(`drop schema if exists "${SCHEMA}" cascade`);
		await admin?.end({ timeout: 5 });
	});

	it("counts a quiet but healthy run as a success", async () => {
		await upsertSourceConfig(sql, { collectorId: "fred", sourceType: "fred" });
		await record(result("fred", "OK", "2026-09-10T06:00:00.000Z"));

		const status = await statusOf("fred");
		expect(status?.consecutiveFailures).toBe(0);
		expect(status?.lastSuccessAt).toBe("2026-09-10T06:00:00.000Z");
		expect(status?.lastFailureAt).toBeUndefined();
	});

	it("does not let a DEGRADED run reset the failure streak", async () => {
		await upsertSourceConfig(sql, { collectorId: "reddit", sourceType: "reddit" });
		await record(result("reddit", "FAILED", "2026-09-10T06:00:00.000Z", { error: "401" }));
		await record(result("reddit", "DEGRADED", "2026-09-11T06:00:00.000Z", { error: "partial" }));

		const status = await statusOf("reddit");
		expect(status?.consecutiveFailures).toBe(2);
		expect(status?.lastFailureAt).toBe("2026-09-11T06:00:00.000Z");
		expect(status?.lastError).toBe("partial");
		expect(status?.lastSuccessAt).toBeUndefined();
	});

	it("resets on recovery while keeping the failure history", async () => {
		await record(result("reddit", "OK", "2026-09-12T06:00:00.000Z"));

		const status = await statusOf("reddit");
		expect(status?.consecutiveFailures).toBe(0);
		expect(status?.lastError).toBeUndefined();
		expect(status?.lastSuccessAt).toBe("2026-09-12T06:00:00.000Z");
		expect(status?.lastFailureAt).toBe("2026-09-11T06:00:00.000Z");
	});
});
