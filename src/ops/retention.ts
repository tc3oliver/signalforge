/**
 * Backup retention selection: 7 daily + 4 weekly + 3 monthly, GFS-style.
 *
 * This is the dangerous part of the backup system (decides what gets
 * deleted), so it is a pure function with no filesystem access — the shell
 * script only ever deletes filenames this function names in `prune`, all of
 * which are drawn from `entries` and never fabricated.
 */

export interface BackupEntry {
	/** Filename as it exists in the backup directory. Never a path. */
	name: string;
	date: Date;
}

export interface RetentionResult {
	keep: string[];
	prune: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function monthKey(d: Date): string {
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** ISO-ish week key: year + week number counted from `today`'s reference frame. */
function weekKey(d: Date, today: Date): string {
	const diffDays = Math.floor((today.getTime() - d.getTime()) / DAY_MS);
	const weekIndex = Math.floor(diffDays / 7);
	return `w${weekIndex}`;
}

/**
 * Given every backup on disk and "today", returns which filenames to keep
 * and which to prune. Keeps the newest backup found in each of: the last 7
 * calendar days, the last 4 rolling 7-day windows, and the last 3 calendar
 * months. A backup can qualify for more than one bucket — the union is what
 * is kept, so nothing is ever double-counted or double-pruned.
 */
export function selectRetention(entries: BackupEntry[], today: Date): RetentionResult {
	if (entries.length === 0) {
		return { keep: [], prune: [] };
	}

	const keepNames = new Set<string>();

	// Daily: newest entry for each of the last 7 calendar days.
	const byDay = new Map<string, BackupEntry>();
	for (let i = 0; i < 7; i++) {
		const target = dayKey(new Date(today.getTime() - i * DAY_MS));
		const candidates = entries.filter((e) => dayKey(e.date) === target);
		const newest = candidates.reduce<BackupEntry | undefined>(
			(best, e) => (!best || e.date > best.date ? e : best),
			undefined,
		);
		if (newest) byDay.set(target, newest);
	}
	for (const e of byDay.values()) keepNames.add(e.name);

	// Weekly: newest entry in each of the last 4 rolling 7-day windows.
	for (let w = 0; w < 4; w++) {
		const candidates = entries.filter((e) => weekKey(e.date, today) === `w${w}`);
		const newest = candidates.reduce<BackupEntry | undefined>(
			(best, e) => (!best || e.date > best.date ? e : best),
			undefined,
		);
		if (newest) keepNames.add(newest.name);
	}

	// Monthly: newest entry in each of the last 3 calendar months.
	const refMonth = today.getUTCFullYear() * 12 + today.getUTCMonth();
	for (let m = 0; m < 3; m++) {
		const target = refMonth - m;
		const targetKey = `${Math.floor(target / 12)}-${String(((target % 12) + 12) % 12 + 1).padStart(2, "0")}`;
		const candidates = entries.filter((e) => monthKey(e.date) === targetKey);
		const newest = candidates.reduce<BackupEntry | undefined>(
			(best, e) => (!best || e.date > best.date ? e : best),
			undefined,
		);
		if (newest) keepNames.add(newest.name);
	}

	const keep: string[] = [];
	const prune: string[] = [];
	for (const e of entries) {
		if (keepNames.has(e.name)) keep.push(e.name);
		else prune.push(e.name);
	}
	return { keep, prune };
}
