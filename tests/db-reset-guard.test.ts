import { describe, expect, it } from "vitest";
import {
	confirmationAccepted,
	decideReset,
	DROP_FLAG,
	resolveTarget,
	type ResetContext,
} from "../src/db/migrate.ts";

// No database anywhere in this file: decideReset takes every input it needs, so
// the refusal matrix is exercised even when Postgres is down.
const base: ResetContext = {
	argv: ["--reset"],
	isTTY: false,
	resolvedDbName: "daily_intelligence",
	host: "127.0.0.1",
};

describe("decideReset", () => {
	it("does nothing when --reset was not requested", () => {
		expect(decideReset({ ...base, argv: [] })).toEqual({ kind: "skip" });
	});

	it("fails closed on a bare --reset with no TTY and no authorisation", () => {
		const decision = decideReset(base);
		expect(decision.kind).toBe("refuse");
		if (decision.kind !== "refuse") return;
		// The message has to say exactly what to pass, or the operator guesses.
		expect(decision.reason).toContain(`${DROP_FLAG}=daily_intelligence`);
	});

	it("proceeds when the flag names the resolved database", () => {
		expect(decideReset({ ...base, argv: ["--reset", `${DROP_FLAG}=daily_intelligence`] }))
			.toEqual({ kind: "proceed" });
	});

	it("refuses when the flag names a different database", () => {
		const decision = decideReset({ ...base, argv: ["--reset", `${DROP_FLAG}=prod`] });
		expect(decision.kind).toBe("refuse");
		if (decision.kind !== "refuse") return;
		expect(decision.reason).toContain("daily_intelligence");
	});

	it("refuses a valueless flag", () => {
		expect(decideReset({ ...base, argv: ["--reset", DROP_FLAG] }).kind).toBe("refuse");
	});

	it("refuses a non-loopback host even with the flag and a TTY", () => {
		const decision = decideReset({
			...base,
			host: "203.0.113.10", // RFC 5737 documentation address, deliberately not a real host
			isTTY: true,
			argv: ["--reset", `${DROP_FLAG}=daily_intelligence`],
		});
		expect(decision.kind).toBe("refuse");
		if (decision.kind !== "refuse") return;
		expect(decision.reason).toContain("non-loopback");
	});

	it("accepts the loopback spellings the driver can produce", () => {
		for (const host of ["127.0.0.1", "localhost", "::1", undefined]) {
			const ctx = { ...base, host, argv: ["--reset", `${DROP_FLAG}=daily_intelligence`] };
			expect(decideReset(ctx)).toEqual({ kind: "proceed" });
		}
	});

	it("refuses when the target database cannot be identified", () => {
		const decision = decideReset({ ...base, isTTY: true, resolvedDbName: undefined });
		expect(decision.kind).toBe("refuse");
	});

	it("demands the database name be typed when stdin is a TTY", () => {
		const decision = decideReset({ ...base, isTTY: true });
		expect(decision.kind).toBe("confirm");
		if (decision.kind !== "confirm") return;
		expect(decision.expected).toBe("daily_intelligence");
		expect(decision.prompt).toContain("daily_intelligence");
	});
});

describe("confirmationAccepted", () => {
	it("accepts the exact name, ignoring the newline the reader leaves behind", () => {
		expect(confirmationAccepted("daily_intelligence", " daily_intelligence \n")).toBe(true);
	});

	it("rejects anything else, including yes", () => {
		for (const typed of ["", "yes", "y", "daily-intelligence", "DAILY_INTELLIGENCE"]) {
			expect(confirmationAccepted("daily_intelligence", typed)).toBe(false);
		}
	});
});

describe("resolveTarget", () => {
	it("reads host and database out of DATABASE_URL", () => {
		expect(resolveTarget({ url: "postgres://u:p@127.0.0.1:5432/daily_intelligence" }))
			.toEqual({ host: "127.0.0.1", database: "daily_intelligence" });
	});

	it("falls back to the discrete settings", () => {
		expect(resolveTarget({ host: "localhost", database: "di" }))
			.toEqual({ host: "localhost", database: "di" });
	});

	it("identifies nothing when the URL is unparseable, so decideReset refuses", () => {
		const target = resolveTarget({ url: "not a url" });
		expect(target.database).toBeUndefined();
		expect(decideReset({ ...base, isTTY: true, ...{ resolvedDbName: target.database } }).kind)
			.toBe("refuse");
	});
});
