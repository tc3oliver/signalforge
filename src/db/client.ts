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
	/** Seconds to wait for a connection before giving up. */
	connectTimeoutSeconds?: number;
	/** Seconds an unused pooled connection is kept before it is closed. */
	idleTimeoutSeconds?: number;
	/**
	 * Server-side cap on a single statement, in milliseconds. Omitted by
	 * default: the pipeline's scans and bulk writes are legitimately long, and a
	 * cap that suits a page render would abort them.
	 */
	statementTimeoutMs?: number;
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

/*
 * Defaults chosen so an unreachable database fails instead of hanging.
 *
 * On 2026-09-15 the host suspended its container VM. Sockets stayed open from
 * this side and no reply ever came, so every caller waited forever: the reader
 * served nothing for ten minutes while its supervisor saw a live process and
 * left it alone. An unreachable database has to surface as an error, and these
 * are the two places it can be made to.
 */
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 60;

/**
 * Build a pooled client. Nothing connects yet — `postgres` is lazy, so call
 * `assertReachable` when a stage must fail fast rather than at first query.
 */
export function createSql(config: DbConfig = dbConfigFromEnv()): Sql {
	/*
	 * `statement_timeout` is a connection parameter rather than a driver option,
	 * so it rides along with search_path on the same connection settings.
	 */
	const connection: Record<string, string> = {};
	if (config.searchPath !== undefined) connection["search_path"] = config.searchPath;
	if (config.statementTimeoutMs !== undefined) {
		connection["statement_timeout"] = String(config.statementTimeoutMs);
	}

	const options: postgres.Options<DbTypes> = {
		max: config.max ?? 10,
		connect_timeout: config.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS,
		idle_timeout: config.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS,
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
		...(Object.keys(connection).length === 0 ? {} : { connection }),
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
