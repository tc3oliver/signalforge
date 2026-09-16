import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { ProgrammerError } from "../runtime/error-classifier.ts";
import { assertReachable, createSql, dbConfigFromEnv, type DbConfig, type Sql } from "./client.ts";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../db/migrations");
const FILE_RE = /^(\d{3,})_[a-z0-9-]+\.sql$/;

export interface MigrationFile {
	version: number;
	name: string;
	sql: string;
	checksum: string;
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
	const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
	const out: MigrationFile[] = [];
	for (const name of files) {
		const match = FILE_RE.exec(name);
		if (!match) {
			throw new ProgrammerError(`migration filename must be NNN_name.sql, got: ${name}`);
		}
		const sql = readFileSync(join(dir, name), "utf8");
		out.push({
			version: Number(match[1]),
			name,
			sql,
			checksum: createHash("sha256").update(sql).digest("hex"),
		});
	}
	return out;
}

async function ensureLedger(sql: Sql): Promise<void> {
	await sql`
		create table if not exists schema_migrations (
			version     integer     primary key,
			name        text        not null,
			checksum    text        not null,
			applied_at  timestamptz not null default now()
		)
	`;
}

export interface MigrateResult {
	applied: string[];
	skipped: string[];
}

/**
 * Forward-only. Each pending file runs inside its own transaction together with
 * its ledger insert, so a half-applied migration cannot be recorded as done.
 */
export async function migrate(sql: Sql, dir: string = MIGRATIONS_DIR): Promise<MigrateResult> {
	await assertReachable(sql, {
		onRetry: ({ attempt, elapsedMs, error }) => {
			// Printed rather than swallowed: a scheduled run that sits here for ten
			// minutes must not look like a hang in the log, and the reason a host is
			// mid-resume is exactly what an operator needs to see afterwards.
			console.error(
				JSON.stringify({
					scope: "db",
					msg: "database not answering yet; waiting",
					attempt,
					elapsedMs,
					error,
				}),
			);
		},
	});
	await ensureLedger(sql);
	/*
	 * One migrator at a time, cluster-wide. Nothing serialises callers otherwise:
	 * the daily and incremental agents can start together, and the test suites
	 * run in parallel against one database. Two processes then apply the same
	 * pending file at once and collide inside Postgres -- `create index if not
	 * exists` races on the catalogue and raises a duplicate key on pg_class,
	 * which reads like a corrupt schema rather than the lost race it is.
	 *
	 * The lock is released in `finally`, and a crashed process drops it with its
	 * session, so a migrator that dies cannot wedge the next one.
	 */
	await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
	try {
		return await applyPending(sql, dir);
	} finally {
		await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
	}
}

/** Arbitrary but fixed: only this module ever takes it. */
const MIGRATION_LOCK_KEY = 4_120_251_015;

async function applyPending(sql: Sql, dir: string): Promise<MigrateResult> {
	const applied = await sql<{ version: number; name: string; checksum: string }[]>`
		select version, name, checksum from schema_migrations
	`;
	const seen = new Map(applied.map((r) => [r.version, r]));

	const result: MigrateResult = { applied: [], skipped: [] };
	for (const migration of loadMigrations(dir)) {
		const prior = seen.get(migration.version);
		if (prior) {
			// A changed checksum means an already-applied file was edited in place,
			// which silently desynchronises every other environment.
			if (prior.checksum !== migration.checksum) {
				throw new ProgrammerError(
					`migration ${migration.name} was modified after being applied; add a new numbered file instead`,
				);
			}
			result.skipped.push(migration.name);
			continue;
		}
		await sql.begin(async (tx) => {
			await tx.unsafe(migration.sql);
			await tx`
				insert into schema_migrations (version, name, checksum)
				values (${migration.version}, ${migration.name}, ${migration.checksum})
			`;
		});
		result.applied.push(migration.name);
	}
	return result;
}

/** Drops and recreates the `public` schema. Never touches the docker volume. */
export async function resetSchema(sql: Sql): Promise<void> {
	await assertReachable(sql);
	await sql.unsafe("drop schema public cascade; create schema public;");
}

/* -------------------------------------------------------------------------- */
/* Destructive-reset authorisation.                                            */
/* -------------------------------------------------------------------------- */

/**
 * `pnpm db:reset` is one keystroke away from `pnpm db:migrate`, and the thing it
 * runs is an unrecoverable `drop schema public cascade`. Connectivity is not
 * intent, so the argv flag alone must never be enough: the operator has to name
 * the database they mean to destroy, either by typing it at a TTY or by passing
 * it explicitly when there is no TTY to prompt at.
 */
export const DROP_FLAG = "--yes-drop-database";

export type ResetDecision =
	/** `--reset` was not requested; migrate normally. */
	| { kind: "skip" }
	| { kind: "refuse"; reason: string }
	/** Interactive: the operator must type `expected` before anything is dropped. */
	| { kind: "confirm"; expected: string; prompt: string }
	| { kind: "proceed" };

export interface ResetContext {
	argv: readonly string[];
	/** Whether stdin can carry a typed confirmation. */
	isTTY: boolean;
	/** Database actually resolved from the connection settings, not from argv. */
	resolvedDbName: string | undefined;
	/** Host actually resolved from the connection settings. */
	host: string | undefined;
}

/**
 * Same refusal philosophy as `scripts/lib-db-env.sh`: this machine runs several
 * other Docker stacks in the same engine, and daily-intelligence's Postgres is
 * bound to loopback by design, so a non-loopback host means the settings have
 * drifted onto someone else's database.
 */
function isLoopback(host: string | undefined): boolean {
	// Unset means the driver's own default, which is the local socket/localhost.
	if (host === undefined || host === "") return true;
	return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/**
 * Pure: every input is passed in, so the whole refusal matrix is testable
 * without a database. `main()` only executes what this returns.
 */
export function decideReset(ctx: ResetContext): ResetDecision {
	if (!ctx.argv.includes("--reset")) return { kind: "skip" };

	if (!isLoopback(ctx.host)) {
		return {
			kind: "refuse",
			reason:
				`refusing to drop a schema on non-loopback host '${ctx.host}' — ` +
				"this command only ever operates on the local daily-intelligence Postgres",
		};
	}

	if (!ctx.resolvedDbName) {
		return {
			kind: "refuse",
			reason:
				"cannot resolve the target database name from DATABASE_URL / PGDATABASE; " +
				"refusing to drop a schema on an unidentified connection",
		};
	}

	const flag = ctx.argv.find((a) => a === DROP_FLAG || a.startsWith(`${DROP_FLAG}=`));
	if (flag !== undefined) {
		const named = flag.startsWith(`${DROP_FLAG}=`) ? flag.slice(DROP_FLAG.length + 1) : "";
		if (named !== ctx.resolvedDbName) {
			return {
				kind: "refuse",
				reason:
					`${DROP_FLAG}=${named || "<empty>"} does not match the database this connection ` +
					`resolves to ('${ctx.resolvedDbName}'); refusing`,
			};
		}
		return { kind: "proceed" };
	}

	if (ctx.isTTY) {
		return {
			kind: "confirm",
			expected: ctx.resolvedDbName,
			prompt:
				`This will run 'drop schema public cascade' on database '${ctx.resolvedDbName}'. ` +
				`All data in it is lost and cannot be recovered.\n` +
				`Type the database name to confirm: `,
		};
	}

	// Not a TTY: no prompt is possible, so intent has to arrive in argv.
	return {
		kind: "refuse",
		reason:
			"refusing a destructive reset without explicit authorisation. " +
			`Re-run with ${DROP_FLAG}=${ctx.resolvedDbName}, or run it interactively to be prompted.`,
	};
}

/** Pure: what the operator typed, against what `decideReset` demanded. */
export function confirmationAccepted(expected: string, typed: string): boolean {
	return typed.trim() === expected;
}

/**
 * The database/host the pool will actually connect to. Authorisation is checked
 * against this, never against what the operator claims on the command line.
 */
export function resolveTarget(config: DbConfig = dbConfigFromEnv()): {
	host: string | undefined;
	database: string | undefined;
} {
	if (config.url) {
		try {
			const url = new URL(config.url);
			return {
				host: decodeURIComponent(url.hostname),
				database: decodeURIComponent(url.pathname.replace(/^\//, "")) || undefined,
			};
		} catch {
			// An unparseable URL is an unidentified target; decideReset refuses on it.
			return { host: undefined, database: undefined };
		}
	}
	return { host: config.host, database: config.database };
}

async function askForConfirmation(prompt: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return await rl.question(prompt);
	} finally {
		rl.close();
	}
}

async function main(): Promise<void> {
	const target = resolveTarget();
	const decision = decideReset({
		argv: process.argv.slice(2),
		isTTY: process.stdin.isTTY === true,
		resolvedDbName: target.database,
		host: target.host,
	});
	if (decision.kind === "refuse") {
		console.error(`db:reset refused: ${decision.reason}`);
		process.exitCode = 1;
		return;
	}
	let reset = decision.kind === "proceed";
	if (decision.kind === "confirm") {
		const typed = await askForConfirmation(decision.prompt);
		if (!confirmationAccepted(decision.expected, typed)) {
			console.error("db:reset aborted: the typed name did not match the target database");
			process.exitCode = 1;
			return;
		}
		reset = true;
	}

	const sql = createSql();
	try {
		if (reset) {
			await resetSchema(sql);
			console.log("public schema dropped and recreated");
		}
		const { applied, skipped } = await migrate(sql);
		for (const name of skipped) console.log(`skip  ${name}`);
		for (const name of applied) console.log(`apply ${name}`);
		console.log(`${applied.length} applied, ${skipped.length} already present`);
	} finally {
		await sql.end();
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err: unknown) => {
		console.error(err);
		process.exitCode = 1;
	});
}
