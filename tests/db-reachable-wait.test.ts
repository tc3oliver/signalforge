import { describe, expect, it, vi } from "vitest";
import { assertReachable } from "../src/db/client.ts";
import type { Sql } from "../src/db/client.ts";

/*
 * The 2026-09-16 brief was lost here. The host had suspended the OrbStack VM
 * overnight; launchd fired the 05:30 job on time, the first `select 1` came back
 * `write CONNECT_TIMEOUT 127.0.0.1:55432`, and the run ended on that one
 * attempt. The VM resumed by itself at 05:59 -- twenty-nine minutes later, with
 * nothing left to use it.
 *
 * "Unreachable" has to mean "did not answer within the window", not "did not
 * answer the first time", because at the first attempt a typo'd connection
 * string and a container host mid-resume are indistinguishable, and they are not
 * the same problem.
 */

/** A database that fails `failures` times and then answers. */
function flakySql(failures: number, message = "write CONNECT_TIMEOUT 127.0.0.1:55432") {
	let calls = 0;
	const fn = (async () => {
		calls += 1;
		if (calls <= failures) throw new Error(message);
		return [{ "?column?": 1 }];
	}) as unknown as Sql;
	return { sql: fn, calls: () => calls };
}

describe("assertReachable", () => {
	it("returns as soon as the database answers", async () => {
		const { sql, calls } = flakySql(0);
		await expect(assertReachable(sql)).resolves.toBeUndefined();
		expect(calls()).toBe(1);
	});

	it("waits through a host that is still resuming, then succeeds", async () => {
		const { sql, calls } = flakySql(3);
		const seen: number[] = [];
		await expect(
			assertReachable(sql, { waitMs: 1000, pollMs: 1, onRetry: ({ attempt }) => seen.push(attempt) }),
		).resolves.toBeUndefined();
		expect(calls()).toBe(4);
		// Each wait is announced, so a scheduled run sitting here is not a silent hang.
		expect(seen).toEqual([1, 2, 3]);
	});

	it("still fails, and says how long it tried, when nothing ever answers", async () => {
		const { sql, calls } = flakySql(Number.MAX_SAFE_INTEGER, "getaddrinfo ENOTFOUND nope");
		await expect(assertReachable(sql, { waitMs: 30, pollMs: 10 })).rejects.toThrow(
			/did not answer within .*attempt\(s\)/,
		);
		expect(calls()).toBeGreaterThan(1);
	});

	it("keeps the original failure as the cause", async () => {
		// A wrong DATABASE_URL must still be diagnosable; the wait changes when we
		// give up, not what we report.
		const { sql } = flakySql(Number.MAX_SAFE_INTEGER, "getaddrinfo ENOTFOUND typo-host");
		const err = await assertReachable(sql, { waitMs: 30, pollMs: 10 }).catch((e: unknown) => e);
		expect((err as { cause?: Error }).cause?.message).toContain("typo-host");
	});

	it("does not exceed its window", async () => {
		const { sql } = flakySql(Number.MAX_SAFE_INTEGER);
		const startedAt = Date.now();
		await assertReachable(sql, { waitMs: 120, pollMs: 20 }).catch(() => {});
		expect(Date.now() - startedAt).toBeLessThan(2000);
	});
});
