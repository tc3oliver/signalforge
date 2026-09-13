import { connect } from "node:net";
import { createSql, type Sql } from "./client.ts";

export interface DbProbe {
	available: boolean;
	reason: string;
}

function parseTarget(url: string): { host: string; port: number } | undefined {
	try {
		const parsed = new URL(url);
		return { host: parsed.hostname, port: Number(parsed.port || 5432) };
	} catch {
		return undefined;
	}
}

function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host, port });
		const done = (ok: boolean) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}

let cached: Promise<DbProbe> | undefined;

/**
 * Gate for the database-backed suites. A missing DATABASE_URL or a container
 * that is simply not running skips under `pnpm test`, which has to stay green on
 * a machine with no Postgres up, and fails under the mandatory verification
 * command — see `announceSkip` below.
 */
export function probeDatabase(timeoutMs = 1500): Promise<DbProbe> {
	cached ??= (async (): Promise<DbProbe> => {
		const url = process.env["DATABASE_URL"]?.trim();
		if (!url) return { available: false, reason: "DATABASE_URL is not set" };
		const target = parseTarget(url);
		if (!target) return { available: false, reason: "DATABASE_URL is not a valid URL" };
		if (!(await tcpReachable(target.host, target.port, timeoutMs))) {
			return { available: false, reason: `no TCP listener on ${target.host}:${target.port}` };
		}
		const sql = createSql();
		try {
			await sql`select 1`;
			return { available: true, reason: "reachable" };
		} catch (err) {
			return { available: false, reason: `connect failed: ${(err as Error).message}` };
		} finally {
			await sql.end({ timeout: 1 });
		}
	})();
	return cached;
}

/**
 * Set by the mandatory verification command (`pnpm verify` / `pnpm test:integration`).
 *
 * `pnpm test` must stay runnable on a machine with no Postgres up, so the
 * database suites skip themselves there. That convenience became a trap: a run
 * with no database reported `622 passed | 42 skipped`, exit 0, green -- with the
 * entire DB layer, the pipeline state machine and the gold-isolation *security*
 * test silently absent. "The tests pass" then meant less than it appeared to,
 * and nothing recorded which of the two runs had happened.
 *
 * So there are now two commands with two contracts. Skipping stays the default
 * for the fast one; when this variable is set, anything that would skip for want
 * of infrastructure is a hard failure instead.
 */
export const REQUIRE_INTEGRATION_ENV_VAR = "DI_REQUIRE_INTEGRATION";

/** Whether this run is the one that is not allowed to skip. */
export function integrationRequired(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[REQUIRE_INTEGRATION_ENV_VAR]?.trim();
	if (value === undefined || value === "" || value === "0") return false;
	return value.toLowerCase() !== "false";
}

/**
 * One-line reason on stdout so a skipped run is never mistaken for a pass —
 * and, under the mandatory command, a thrown error so it cannot be one.
 */
export function announceSkip(suite: string, probe: DbProbe): void {
	if (probe.available) return;
	if (integrationRequired()) {
		throw new Error(
			`[${suite}] PostgreSQL is required for this run because ${REQUIRE_INTEGRATION_ENV_VAR} is set, ` +
				`and it is not available: ${probe.reason}. Start it with \`docker compose up -d\` and re-run.`,
		);
	}
	console.log(`[${suite}] skipped — PostgreSQL not available (${probe.reason}).`);
}

/**
 * The same contract for a suite gated on generated fixtures rather than on
 * Postgres. `tests/integration/gold-isolation.test.ts` is the one that matters:
 * it asserts gold truth is unreachable from inside the agent sandbox, and it
 * used to vanish with no announcement at all when the fixtures were absent.
 */
export function announceMissingFixtures(suite: string, present: boolean, detail: string): void {
	if (present) return;
	if (integrationRequired()) {
		throw new Error(
			`[${suite}] generated fixtures are required for this run because ${REQUIRE_INTEGRATION_ENV_VAR} is set, ` +
				`and they are absent (${detail}). Run \`pnpm phase1:generate\` and re-run.`,
		);
	}
	console.log(`[${suite}] skipped — generated fixtures not present (${detail}).`);
}

/** Isolated lineage per suite so parallel test files cannot collide. */
export function testLineage(prefix: string): string {
	return `test-${prefix}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function purgeLineage(sql: Sql, lineage: string): Promise<void> {
	await sql.begin(async (tx) => {
		await tx`delete from item_decisions where lineage = ${lineage}`;
		await tx`delete from story_items where lineage = ${lineage}`;
		await tx`delete from story_ledger where lineage = ${lineage}`;
		await tx`delete from daily_brief_stories where lineage = ${lineage}`;
		await tx`delete from daily_briefs where lineage = ${lineage}`;
		await tx`delete from daily_brief_drafts where lineage = ${lineage}`;
		await tx`delete from daily_material_stories where lineage = ${lineage}`;
		await tx`delete from daily_materials where lineage = ${lineage}`;
		await tx`delete from structured_facts where lineage = ${lineage}`;
		await tx`delete from emerging_signals where lineage = ${lineage}`;
		await tx`delete from normalized_items where lineage = ${lineage}`;
	});
}
