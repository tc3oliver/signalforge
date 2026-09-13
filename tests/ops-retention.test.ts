import { describe, expect, it } from "vitest";
import { selectRetention, type BackupEntry } from "../src/ops/retention.ts";

const TODAY = new Date("2026-09-13T06:00:00.000Z");

function daysAgo(n: number, name?: string): BackupEntry {
	const date = new Date(TODAY.getTime() - n * 24 * 60 * 60 * 1000);
	return { name: name ?? `backup-${date.toISOString()}`, date };
}

describe("selectRetention", () => {
	it("returns nothing for an empty directory", () => {
		const result = selectRetention([], TODAY);
		expect(result).toEqual({ keep: [], prune: [] });
	});

	it("keeps every entry when exactly 7 dailies exist, one per day", () => {
		const entries = Array.from({ length: 7 }, (_, i) => daysAgo(i));
		const result = selectRetention(entries, TODAY);
		expect(result.prune).toEqual([]);
		expect(result.keep.sort()).toEqual(entries.map((e) => e.name).sort());
	});

	it("prunes a backup older than every retention window", () => {
		const stale = daysAgo(400, "ancient");
		const recent = daysAgo(0, "today");
		const result = selectRetention([stale, recent], TODAY);
		expect(result.keep).toContain("today");
		expect(result.prune).toContain("ancient");
	});

	it("handles a gap in dates without crashing or over-keeping", () => {
		// Only day 0 and day 6 exist; days 1-5 are missing entirely.
		const entries = [daysAgo(0, "d0"), daysAgo(6, "d6")];
		const result = selectRetention(entries, TODAY);
		expect(result.keep.sort()).toEqual(["d0", "d6"]);
		expect(result.prune).toEqual([]);
	});

	it("keeps one backup per month across a month boundary", () => {
		// Two backups in the same older month, well past the 7-day and
		// 4-week windows -- only the newer of the two should survive via
		// the monthly bucket.
		const older = { name: "july-1", date: new Date("2026-07-01T00:00:00.000Z") };
		const newer = { name: "july-20", date: new Date("2026-07-20T00:00:00.000Z") };
		const result = selectRetention([older, newer], TODAY);
		expect(result.keep).toEqual(["july-20"]);
		expect(result.prune).toEqual(["july-1"]);
	});

	it("never selects a name that was not in the input", () => {
		const entries = [daysAgo(0), daysAgo(40), daysAgo(200)];
		const result = selectRetention(entries, TODAY);
		const validNames = new Set(entries.map((e) => e.name));
		for (const name of [...result.keep, ...result.prune]) {
			expect(validNames.has(name)).toBe(true);
		}
	});

	it("keep and prune partition the input exactly, with no overlap", () => {
		const entries = Array.from({ length: 20 }, (_, i) => daysAgo(i * 5));
		const result = selectRetention(entries, TODAY);
		const keepSet = new Set(result.keep);
		const pruneSet = new Set(result.prune);
		expect(keepSet.size).toBe(result.keep.length);
		for (const k of keepSet) expect(pruneSet.has(k)).toBe(false);
		expect(result.keep.length + result.prune.length).toBe(entries.length);
	});

	it("keeps the newest backup of a day when multiple exist on the same day", () => {
		const a = { name: "morning", date: new Date("2026-09-13T02:00:00.000Z") };
		const b = { name: "evening", date: new Date("2026-09-13T20:00:00.000Z") };
		const result = selectRetention([a, b], new Date("2026-09-13T21:00:00.000Z"));
		expect(result.keep).toEqual(["evening"]);
		expect(result.prune).toEqual(["morning"]);
	});
});
