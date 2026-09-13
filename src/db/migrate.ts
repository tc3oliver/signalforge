import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProgrammerError } from "../runtime/error-classifier.ts";
import { assertReachable, createSql, type Sql } from "./client.ts";

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
	await assertReachable(sql);
	await ensureLedger(sql);
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

async function main(): Promise<void> {
	const reset = process.argv.includes("--reset");
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
