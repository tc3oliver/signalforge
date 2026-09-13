/**
 * CLI shim between backup-db.sh and the pure `selectRetention` function.
 * Reads the real backup directory, parses each filename's embedded
 * timestamp, and prints one filename per line for everything that should be
 * pruned. All filesystem access lives here; the retention decision itself
 * stays in src/ops/retention.ts, where it is unit tested without touching
 * disk.
 */
import { readdirSync } from "node:fs";
import { selectRetention, type BackupEntry } from "./retention.ts";

// Matches "<database>-<YYYYMMDDTHHMMSSZ>.sql.gz", as written by backup-db.sh.
const BACKUP_NAME = /-(\d{8}T\d{6}Z)\.sql\.gz$/;

function parseTimestamp(name: string): Date | undefined {
	const match = BACKUP_NAME.exec(name);
	if (!match) return undefined;
	const raw = match[1] as string;
	const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`;
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

function main(): void {
	const dir = process.argv[2];
	if (!dir) {
		console.error("usage: list-prune-candidates.ts <backup-dir>");
		process.exit(1);
	}

	let filenames: string[];
	try {
		filenames = readdirSync(dir);
	} catch {
		// A missing/empty backup directory has nothing to prune.
		return;
	}

	const entries: BackupEntry[] = [];
	for (const name of filenames) {
		const date = parseTimestamp(name);
		if (date) entries.push({ name, date });
	}

	const { prune } = selectRetention(entries, new Date());
	for (const name of prune) {
		console.log(name);
	}
}

main();
