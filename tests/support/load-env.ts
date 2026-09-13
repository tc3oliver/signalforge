import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Loads the repo `.env` into `process.env` before any test module is evaluated.
 *
 * Without this, `pnpm test` ran with no DATABASE_URL and every Postgres-backed
 * suite skipped itself -- quietly, while the summary still said the run passed.
 * A green `pnpm test` that silently excluded the database layer is worse than a
 * red one, so the env file is loaded here rather than left to whoever remembers
 * the right flag on the command line.
 *
 * Values already present in the environment win, so CI or a one-off
 * `DATABASE_URL=... pnpm test` still overrides the file.
 */
function loadEnvFile(path: string): void {
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch {
		return; // No .env is a perfectly normal way to run the non-DB suites.
	}
	for (const rawLine of contents.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		if (process.env[key] !== undefined) continue;
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		process.env[key] = value;
	}
}

loadEnvFile(join(process.cwd(), ".env"));
