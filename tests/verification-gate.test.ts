import { describe, expect, it } from "vitest";
import {
	REQUIRE_INTEGRATION_ENV_VAR,
	announceMissingFixtures,
	announceSkip,
	integrationRequired,
} from "../src/db/test-support.ts";

/*
 * The suite reported "622 passed | 42 skipped", exit 0, green, on a machine with
 * no database — with the whole DB layer, the pipeline state machine and the
 * gold-isolation security test silently absent. These tests are the guard on the
 * guard: they assert that the fast command may still skip, and that the
 * mandatory one cannot.
 */

const UNAVAILABLE = { available: false, reason: "no TCP listener on 127.0.0.1:5432" } as const;
const AVAILABLE = { available: true, reason: "reachable" } as const;

describe("integrationRequired", () => {
	it("is off when the variable is absent", () => {
		expect(integrationRequired({})).toBe(false);
	});

	it("treats the ways an operator says no as no", () => {
		for (const value of ["", " ", "0", "false", "FALSE"]) {
			expect(integrationRequired({ [REQUIRE_INTEGRATION_ENV_VAR]: value })).toBe(false);
		}
	});

	it("is on for any other value", () => {
		for (const value of ["1", "true", "yes"]) {
			expect(integrationRequired({ [REQUIRE_INTEGRATION_ENV_VAR]: value })).toBe(true);
		}
	});
});

describe("announceSkip", () => {
	it("skips quietly when integration is not required", () => {
		delete process.env[REQUIRE_INTEGRATION_ENV_VAR];
		expect(() => announceSkip("suite", UNAVAILABLE)).not.toThrow();
	});

	it("throws when the database is required and absent", () => {
		process.env[REQUIRE_INTEGRATION_ENV_VAR] = "1";
		try {
			expect(() => announceSkip("db-items", UNAVAILABLE)).toThrow(/PostgreSQL is required/);
			// The message has to tell the operator what to do about it.
			expect(() => announceSkip("db-items", UNAVAILABLE)).toThrow(/docker compose up -d/);
		} finally {
			delete process.env[REQUIRE_INTEGRATION_ENV_VAR];
		}
	});

	it("does nothing at all when the database is there", () => {
		process.env[REQUIRE_INTEGRATION_ENV_VAR] = "1";
		try {
			expect(() => announceSkip("db-items", AVAILABLE)).not.toThrow();
		} finally {
			delete process.env[REQUIRE_INTEGRATION_ENV_VAR];
		}
	});
});

describe("announceMissingFixtures", () => {
	it("throws for the gold-isolation suite when fixtures are required and absent", () => {
		process.env[REQUIRE_INTEGRATION_ENV_VAR] = "1";
		try {
			expect(() => announceMissingFixtures("gold-isolation", false, "manifest missing")).toThrow(
				/pnpm phase1:generate/,
			);
		} finally {
			delete process.env[REQUIRE_INTEGRATION_ENV_VAR];
		}
	});

	it("skips quietly otherwise", () => {
		delete process.env[REQUIRE_INTEGRATION_ENV_VAR];
		expect(() => announceMissingFixtures("gold-isolation", false, "manifest missing")).not.toThrow();
		expect(() => announceMissingFixtures("gold-isolation", true, "")).not.toThrow();
	});
});
