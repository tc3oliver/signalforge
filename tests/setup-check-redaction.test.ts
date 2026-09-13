import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `pnpm setup:check` is the first command a new operator runs, and it reports on
 * credentials. It must therefore be incapable of printing one.
 *
 * This drives the real CLI rather than a unit of it, because the risk is not in
 * any single function -- it is in some future line deciding that echoing the
 * connection string would be helpful.
 */
describe("setup:check output", () => {
	const ROOT = join(import.meta.dirname, "..");
	const PASSWORD = "SUPERSECRETPASSWORD1234";
	const TOKEN = "ghp_SUPERSECRETTOKENVALUE0000000000000000";

	function run(): string {
		try {
			return execFileSync("pnpm", ["exec", "tsx", "src/cli/setup-check.ts"], {
				cwd: ROOT,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					DATABASE_URL: `postgres://someuser:${PASSWORD}@127.0.0.1:59999/nodb`,
					GITHUB_TOKEN: TOKEN,
					// Point the secrets file somewhere that does not exist, so the run
					// reports on this environment rather than the operator's real file.
					DAILY_INTELLIGENCE_SECRETS_FILE: "/nonexistent/setup-check-test/secrets.env",
				},
			});
		} catch (err) {
			// A failing database check exits non-zero, which is the expected path
			// here; the output is still what is under test.
			const e = err as { stdout?: string; stderr?: string };
			return `${e.stdout ?? ""}${e.stderr ?? ""}`;
		}
	}

	it("never prints a password from DATABASE_URL", () => {
		expect(run()).not.toContain(PASSWORD);
	});

	it("never prints a credential value from the environment", () => {
		expect(run()).not.toContain(TOKEN);
	});

	it("still names where it tried to connect, so the failure is actionable", () => {
		const out = run();
		expect(out).toContain("127.0.0.1:59999");
		expect(out).toContain("not reachable");
	});

	it("reports credential names, not values", () => {
		const out = run();
		expect(out).toContain("GITHUB_TOKEN");
	});
});
