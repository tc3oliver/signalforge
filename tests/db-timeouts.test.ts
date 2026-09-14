import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql, dbConfigFromEnv, type Sql } from "../src/db/client.ts";
import { announceSkip, probeDatabase } from "../src/db/test-support.ts";

/*
 * An unreachable database must produce an error, not a wait.
 *
 * On 2026-09-15 the container VM suspended under the host's maintenance sleep.
 * The sockets stayed open from this side and no reply ever came, so every
 * caller blocked indefinitely: the reader answered nothing for ten minutes
 * while its supervisor saw a healthy process and had no reason to restart it.
 * A process that hangs is worse than one that crashes, because nothing above it
 * can tell that anything is wrong.
 */

const probe = await probeDatabase();
announceSkip("db-timeouts", probe);

describe("connection timeout", () => {
	it("gives up on an address that accepts nothing rather than waiting forever", async () => {
		// 198.51.100.0/24 is TEST-NET-2: reserved for documentation, routable
		// nowhere, so the connection attempt hangs instead of being refused.
		const sql = createSql({
			host: "198.51.100.1",
			port: 5432,
			database: "nothing",
			username: "nobody",
			connectTimeoutSeconds: 2,
		});
		const startedAt = Date.now();
		try {
			await expect(sql`select 1`).rejects.toThrow();
			// Comfortably under the 5s the driver would otherwise spend, and well
			// clear of the 2s bound so a slow machine does not fail this.
			expect(Date.now() - startedAt).toBeLessThan(15_000);
		} finally {
			await sql.end({ timeout: 5 }).catch(() => {});
		}
	}, 30_000);
});

describe.skipIf(!probe.available)("statement timeout", () => {
	let sql: Sql;

	beforeAll(() => {
		sql = createSql({ ...dbConfigFromEnv(), max: 1, statementTimeoutMs: 500 });
	});

	afterAll(async () => {
		await sql.end({ timeout: 5 }).catch(() => {});
	});

	it("aborts a statement that outruns the cap", async () => {
		await expect(sql`select pg_sleep(5)`).rejects.toThrow(/statement timeout|canceling/i);
	}, 30_000);

	it("leaves a normal query untouched", async () => {
		const rows = await sql<{ n: number }[]>`select 1 as n`;
		expect(rows[0]?.n).toBe(1);
	});
});

describe.skipIf(!probe.available)("default configuration", () => {
	it("applies no statement cap unless one is asked for", async () => {
		// The pipeline's scans and bulk writes are legitimately long; a cap that
		// suits a page render would abort them.
		const sql = createSql({ ...dbConfigFromEnv(), max: 1 });
		try {
			const rows = await sql<{ setting: string }[]>`select current_setting('statement_timeout') as setting`;
			expect(rows[0]?.setting).toBe("0");
		} finally {
			await sql.end({ timeout: 5 }).catch(() => {});
		}
	}, 30_000);

	it("sets the cap the reader asks for", async () => {
		const sql = createSql({ ...dbConfigFromEnv(), max: 1, statementTimeoutMs: 10_000 });
		try {
			const rows = await sql<{ setting: string }[]>`select current_setting('statement_timeout') as setting`;
			expect(rows[0]?.setting).toBe("10s");
		} finally {
			await sql.end({ timeout: 5 }).catch(() => {});
		}
	}, 30_000);
});
