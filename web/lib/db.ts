import { createSql, type Sql } from "../../src/db/client.ts";

/*
 * Server-only database access.
 *
 * The connection string is read from DATABASE_URL, which is a plain server
 * environment variable — deliberately not NEXT_PUBLIC_, so it is never inlined
 * into a client bundle. The guard below turns a mistaken client import into a
 * loud failure instead of a silently shipped credential.
 */
if (typeof window !== "undefined") {
	throw new Error("web/lib/db.ts was imported into a client bundle; it is server-only.");
}

/** Ledger namespace. A synthetic lineage must never read production rows. */
export const LINEAGE: string = process.env["DI_LINEAGE"]?.trim() || "default";

/*
 * One pool per process. Next's dev server re-evaluates modules on edit, so the
 * pool is parked on globalThis; without that, every save would leak a pool and
 * exhaust max_connections within a few minutes of editing.
 */
const POOL_KEY = Symbol.for("daily-intelligence.web.sql");
type PoolHolder = { [POOL_KEY]?: Sql };

export function db(): Sql {
	const holder = globalThis as unknown as PoolHolder;
	holder[POOL_KEY] ??= createSql({ ...dbConfig(), max: 5 });
	return holder[POOL_KEY];
}

function dbConfig(): { url?: string } {
	const url = process.env["DATABASE_URL"]?.trim();
	if (!url) {
		throw new Error(
			"DATABASE_URL is not set. The reader serves published rows from Postgres and has no other source.",
		);
	}
	return { url };
}
