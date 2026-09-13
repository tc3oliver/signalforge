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
 * that is simply not running must skip, never fail: `pnpm test` has to stay
 * green on a machine with no Postgres up.
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

/** One-line reason on stdout so a skipped run is never mistaken for a pass. */
export function announceSkip(suite: string, probe: DbProbe): void {
	if (probe.available) return;
	console.log(`[${suite}] skipped — PostgreSQL not available (${probe.reason}).`);
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
