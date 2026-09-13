import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `web/` is a separate package with its own lockfile, not a pnpm workspace
 * member, so a root `pnpm install` does not reach it. On a machine where
 * `web/node_modules` already existed that was invisible; on a fresh clone
 * `pnpm verify` got all the way through 745 passing tests and then died on
 * `next: command not found`.
 *
 * A `postinstall` hook closes it. This test states the dependency so that
 * removing the hook fails here, with the reason, rather than three minutes into
 * a stranger's first build.
 */
describe("a fresh clone installs everything it needs", () => {
	const root = join(import.meta.dirname, "..");
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		scripts: Record<string, string>;
	};

	it("installs the web package's dependencies from the root install", () => {
		expect(pkg.scripts["postinstall"]).toBeDefined();
		expect(pkg.scripts["postinstall"]).toContain("--dir web");
		expect(pkg.scripts["postinstall"]).toContain("install");
	});

	it("still builds web as part of build, so the two stay in step", () => {
		expect(pkg.scripts["build"]).toContain("--dir web");
	});
});
