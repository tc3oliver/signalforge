import postgres from "postgres";
import { ProgrammerError } from "../runtime/error-classifier.ts";

/*
 * porsager/postgres over `pg`: it is a single dependency with no native build
 * step (this machine installs nothing outside Homebrew/mise), it returns tagged
 * template results already typed, and its built-in pooling plus array/jsonb
 * handling means the repository modules stay plain typed query functions
 * instead of an ORM layer.
 */

/** Timestamps stay strings on the way in and on the way out. */
type DbTypes = { date: postgres.PostgresType<string> };
export type Sql = postgres.Sql<{ date: string }>;

export interface DbConfig {
	url?: string;
	host?: string;
	port?: number;
	database?: string;
	username?: string;
	password?: string;
	max?: number;
	/** Pins every connection in the pool to a schema; used to isolate test runs. */
	searchPath?: string;
}

/** DATABASE_URL wins; the discrete PG* variables are the fallback. */
export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
	const url = env["DATABASE_URL"]?.trim();
	if (url) return { url };
	const port = env["PGPORT"] ? Number(env["PGPORT"]) : undefined;
	if (port !== undefined && !Number.isInteger(port)) {
		throw new ProgrammerError(`PGPORT is not an integer: ${env["PGPORT"]}`);
	}
	return {
		host: env["PGHOST"],
		port,
		database: env["PGDATABASE"],
		username: env["PGUSER"],
		password: env["PGPASSWORD"],
	};
}

/**
 * Build a pooled client. Nothing connects yet — `postgres` is lazy, so call
 * `assertReachable` when a stage must fail fast rather than at first query.
 */
export function createSql(config: DbConfig = dbConfigFromEnv()): Sql {
	const options: postgres.Options<DbTypes> = {
		max: config.max ?? 10,
		// Timestamps are carried as ISO strings end to end. Left alone, the driver
		// hands back Date objects and a round-trip would lose the exact string the
		// JSON-backed ledger stored.
		types: {
			date: {
				to: 1184,
				from: [1082, 1114, 1184],
				serialize: (v: string) => v,
				parse: (v: string) => v,
			},
		},
		onnotice: () => {},
		transform: { undefined: null },
		...(config.searchPath === undefined
			? {}
			: { connection: { search_path: config.searchPath } }),
	};
	if (config.url) return postgres(config.url, options);
	return postgres({
		...options,
		...(config.host === undefined ? {} : { host: config.host }),
		...(config.port === undefined ? {} : { port: config.port }),
		...(config.database === undefined ? {} : { database: config.database }),
		...(config.username === undefined ? {} : { username: config.username }),
		...(config.password === undefined ? {} : { password: config.password }),
	});
}

/**
 * An unreachable database is a deployment/configuration bug, not a transient provider
 * failure: it is raised as ProgrammerError so the classifier maps it to
 * PROGRAMMER_ERROR and no retry or fallback path can swallow it.
 */
export async function assertReachable(sql: Sql): Promise<void> {
	try {
		await sql`select 1`;
	} catch (cause) {
		throw new ProgrammerError(
			"PostgreSQL is unreachable; check that compose is up and DATABASE_URL points at it",
			{ cause },
		);
	}
}

/**
 * jsonb bind parameter. The driver's own `JSONValue` type is narrower than the
 * domain records that get stored (a `Record<string, unknown>` does not satisfy
 * it), and an already-stringified value would be double-encoded into a JSON
 * string, so every jsonb parameter goes through here.
 */
export function jsonParam(sql: Sql, value: unknown): ReturnType<Sql["json"]> {
	return sql.json(value as Parameters<Sql["json"]>[0]);
}
