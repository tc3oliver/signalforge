import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveDraft } from "../src/db/briefs.ts";
import { createSql, type Sql } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import { announceSkip, probeDatabase, purgeLineage, testLineage } from "../src/db/test-support.ts";

const probe = await probeDatabase();
announceSkip("db-draft-concurrency", probe);

const DATE = "2026-09-14";
/** A separate day, so the lock test cannot disturb the numbering above. */
const LOCK_DATE = "2026-09-15";

describe.skipIf(!probe.available)("racing draft writers", () => {
	let sql: Sql;
	let second: Sql;
	let lineage: string;
	let runA: string;
	let runB: string;

	beforeAll(async () => {
		sql = createSql();
		// A second pool, so a "concurrent" save is genuinely a second backend
		// racing the first rather than two calls serialised onto one connection.
		second = createSql();
		await migrate(sql);
		lineage = testLineage("draft-race");
		runA = `${lineage}-a`;
		runB = `${lineage}-b`;
		for (const runId of [runA, runB]) {
			await sql`
				insert into daily_runs (run_id, lineage, date, status)
				values (${runId}, ${lineage}, ${DATE}, 'WRITING')
			`;
		}
	});

	afterAll(async () => {
		if (lineage) {
			await purgeLineage(sql, lineage);
			await sql`delete from daily_runs where lineage = ${lineage}`;
		}
		await second?.end({ timeout: 5 });
		await sql?.end({ timeout: 5 });
	});

	it("gives two runs racing on one day two distinct draft numbers", async () => {
		// The next draft number was read and written without a lock, so both runs
		// saw the same max(draft_no), both inserted that number plus one, and one
		// died on the (lineage, date, draft_no) primary key — losing a draft that
		// had already cost a model run.
		const [a, b] = await Promise.all([
			saveDraft(sql, lineage, DATE, { stories: [], writer: "a" }, {
				producedAt: "2026-09-14T09:00:00.000Z",
				runId: runA,
			}),
			saveDraft(second, lineage, DATE, { stories: [], writer: "b" }, {
				producedAt: "2026-09-14T09:00:01.000Z",
				runId: runB,
			}),
		]);

		expect(new Set([a, b])).toEqual(new Set([1, 2]));
		const rows = await sql<{ draft_no: number; run_id: string }[]>`
			select draft_no, run_id from daily_brief_drafts
			where lineage = ${lineage} and date = ${DATE} order by draft_no
		`;
		// Both attempts survive: neither writer overwrote or displaced the other.
		expect(rows.map((r) => r.draft_no)).toEqual([1, 2]);
		expect(new Set(rows.map((r) => r.run_id))).toEqual(new Set([runA, runB]));
	});

	it("waits for a holder of the day's lock instead of racing it to a number", async () => {
		// Deterministic form of the same race. A second backend holds the
		// lineage+date lock while it appends a draft and has not yet committed.
		// The unlocked read-and-insert would read max(draft_no) without seeing
		// that uncommitted row, pick the number the holder is already using, and
		// die on the primary key the moment the holder commits.
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let ready: () => void = () => {};
		const locked = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const holder = second.begin(async (tx) => {
			await tx.unsafe("select pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))", [
				lineage,
				LOCK_DATE,
			]);
			await tx.unsafe(
				`insert into daily_brief_drafts (lineage, date, draft_no, run_id, body, produced_at,
					validation_status, validation_errors)
				 values ($1, $2, 1, $3, '{}'::jsonb, $4::timestamptz, 'PENDING', '[]'::jsonb)`,
				[lineage, LOCK_DATE, runB, "2026-09-15T09:00:00.000Z"],
			);
			ready();
			await gate;
		});
		await locked;

		let settled = false;
		const waiting = saveDraft(sql, lineage, LOCK_DATE, { stories: [] }, {
			producedAt: "2026-09-15T11:00:00.000Z",
			runId: runA,
		}).then((n) => {
			settled = true;
			return n;
		});

		// Long enough that an unlocked writer would have read and inserted by now.
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(settled).toBe(false);

		release();
		await holder;
		// It gets the next number rather than a duplicate-key error.
		await expect(waiting).resolves.toBe(2);
	});

	it("still records a verdict in place without touching the attempt's provenance", async () => {
		const before = await sql<{ run_id: string; produced_at: string }[]>`
			select run_id, to_char(produced_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
				as produced_at
			from daily_brief_drafts where lineage = ${lineage} and date = ${DATE} and draft_no = 1
		`;

		const updated = await saveDraft(sql, lineage, DATE, { stories: [] }, {
			producedAt: "2026-09-14T10:00:00.000Z",
			runId: runB,
			validationStatus: "FAILED",
			validationErrors: ["missing story"],
			draftNo: 1,
		});
		expect(updated).toBe(1);

		const after = await sql<
			{ run_id: string; produced_at: string; validation_status: string }[]
		>`
			select run_id, to_char(produced_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
				as produced_at, validation_status
			from daily_brief_drafts where lineage = ${lineage} and date = ${DATE} and draft_no = 1
		`;
		expect(after[0]?.validation_status).toBe("FAILED");
		// run_id and produced_at belong to the attempt that authored the body.
		expect(after[0]?.run_id).toBe(before[0]?.run_id);
		expect(after[0]?.produced_at).toBe(before[0]?.produced_at);
		// And the update path appended nothing.
		const count = await sql<{ n: string }[]>`
			select count(*)::text as n from daily_brief_drafts
			where lineage = ${lineage} and date = ${DATE}
		`;
		expect(count[0]?.n).toBe("2");
	});
});
