import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT_DIR = new URL("../scripts/", import.meta.url);

const SCRIPTS = [
	"install-launchagent.sh",
	"uninstall-launchagent.sh",
	"backup-db.sh",
	"restore-db.sh",
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

	it("uses set -euo pipefail", () => {
		const content = readFileSync(path, "utf8");
		expect(content).toContain("set -euo pipefail");
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
