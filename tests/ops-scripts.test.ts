import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT_DIR = new URL("../scripts/", import.meta.url);

const SCRIPTS = [
	"install-launchagent.sh",
	"uninstall-launchagent.sh",
	"backup-db.sh",
	"restore-db.sh",
	"lib-db-env.sh",
] as const;

describe.each(SCRIPTS)("%s", (name) => {
	const path = new URL(name, SCRIPT_DIR);

	it("exists", () => {
		expect(() => accessSync(path)).not.toThrow();
	});

	it("is executable", () => {
		expect(() => accessSync(path, constants.X_OK)).not.toThrow();
	});

	it("passes bash syntax check", () => {
		// bash -n only parses the script; it never executes it. This is the
		// only invocation these tests make against the installer/uninstaller
		// -- they are never actually run here, only syntax-checked.
		expect(() => execFileSync("bash", ["-n", path.pathname])).not.toThrow();
	});

	it("uses set -euo pipefail, unless it is a sourced-only library", () => {
		const content = readFileSync(path, "utf8");
		if (name === "lib-db-env.sh") {
			// Sourced into a caller that already sets -euo pipefail; setting it
			// again here is redundant, and this file is never executed directly.
			expect(content).toContain("Sourced, never executed directly");
		} else {
			expect(content).toContain("set -euo pipefail");
		}
	});

	it("never invokes sudo", () => {
		const content = readFileSync(path, "utf8");
		expect(content).not.toMatch(/\bsudo\b/);
	});
});

describe("backup-db.sh / restore-db.sh credential handling", () => {
	for (const name of ["backup-db.sh", "restore-db.sh"] as const) {
		it(`${name} never passes a password on the command line`, () => {
			const content = readFileSync(new URL(name, SCRIPT_DIR), "utf8");
			// A password must only ever travel via the PGPASSWORD environment
			// variable or a .pgpass file -- never as a literal -password/--pw
			// style argument to pg_dump/psql.
			expect(content).not.toMatch(/--password[= ]/);
			expect(content).not.toMatch(/-W\s+\S+/);
		});

		it(`${name} does not hardcode a credential value`, () => {
			const content = readFileSync(new URL(name, SCRIPT_DIR), "utf8");
			expect(content).not.toMatch(/PGPASSWORD\s*=\s*["']?[^"'\s$]/);
		});
	}
});

describe("restore-db.sh safety", () => {
	const content = readFileSync(new URL("restore-db.sh", SCRIPT_DIR), "utf8");

	it("refuses to restore into the production database without --force", () => {
		expect(content).toMatch(/refusing to restore into production database/);
	});

	it("defaults to a scratch database name", () => {
		expect(content).toMatch(/_restore_test/);
	});

	it("refuses a --target not derived from the configured database name", () => {
		expect(content).toMatch(/refusing to restore into '\$\{TARGET_DB\}'/);
		expect(content).toMatch(/PGDATABASE\}_"\*/);
	});
});

describe("lib-db-env.sh connection resolution", () => {
	const content = readFileSync(new URL("lib-db-env.sh", SCRIPT_DIR), "utf8");

	it("treats DATABASE_URL as canonical, PG* vars as fallback", () => {
		expect(content).toMatch(/DATABASE_URL:-/);
		expect(content).toMatch(/PGUSER="\$\{BASH_REMATCH\[2\]\}"/);
	});

	it("refuses any host other than loopback", () => {
		expect(content).toMatch(/127\.0\.0\.1 \| localhost/);
		expect(content).toMatch(/refusing non-loopback PGHOST/);
	});

	it("actually resolves a real DATABASE_URL when sourced", () => {
		// Exercises the real bash regex end-to-end (not just a string match on
		// the source), including that a password never leaks into a resolved
		// PGHOST/PGPORT/PGDATABASE/PGUSER printout.
		const script = `
			set -euo pipefail
			source "${new URL("lib-db-env.sh", SCRIPT_DIR).pathname}"
			ENV_FILE="$(mktemp)"
			echo 'DATABASE_URL=postgres://daily_intelligence:s3cret@127.0.0.1:55432/daily_intelligence' > "$ENV_FILE"
			resolve_db_env "$ENV_FILE"
			echo "HOST=$PGHOST PORT=$PGPORT DB=$PGDATABASE USER=$PGUSER PASS_SET=\${PGPASSWORD:+yes}"
		`;
		const out = execFileSync("bash", ["-c", script], { encoding: "utf8" });
		expect(out).toContain("HOST=127.0.0.1 PORT=55432 DB=daily_intelligence USER=daily_intelligence PASS_SET=yes");
		expect(out).not.toContain("s3cret");
	});

	it("rejects a non-loopback DATABASE_URL host end-to-end", () => {
		const script = `
			set -uo pipefail
			source "${new URL("lib-db-env.sh", SCRIPT_DIR).pathname}"
			ENV_FILE="$(mktemp)"
			echo 'DATABASE_URL=postgres://user:pw@some-other-host:5432/otherdb' > "$ENV_FILE"
			resolve_db_env "$ENV_FILE"
			echo "exit=$?"
		`;
		const out = execFileSync("bash", ["-c", script], { encoding: "utf8" });
		expect(out).toContain("exit=1");
	});
});

describe("backup-db.sh safety", () => {
	const content = readFileSync(new URL("backup-db.sh", SCRIPT_DIR), "utf8");

	it("writes backups under the repo, not /Volumes/Data", () => {
		expect(content).toMatch(/BACKUP_DIR="\$\{PROJECT_ROOT\}/);
	});

	it("prints what it would prune before deleting", () => {
		const printIdx = content.indexOf("will be pruned");
		const rmIdx = content.indexOf("rm -f -- \"${target}\"");
		expect(printIdx).toBeGreaterThan(-1);
		expect(rmIdx).toBeGreaterThan(-1);
		expect(printIdx).toBeLessThan(rmIdx);
	});

	it("guards deletion to paths inside the backup dir", () => {
		expect(content).toMatch(/refusing to delete path outside backup dir/);
	});
});
