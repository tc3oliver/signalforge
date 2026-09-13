import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * A web request must never invoke a language model. The reader serves rows the
 * pipeline already published; the moment an agent runtime becomes reachable
 * from a page, latency, cost and non-determinism all enter the request path and
 * the "published output only" guarantee is gone.
 *
 * This suite pins that structurally rather than by review: it walks every
 * source file under web/ and fails if any of them can reach the agent runtime.
 */

const WEB_ROOT = fileURLToPath(new URL("../web", import.meta.url));

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "out", ".turbo"]);
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Anything that would put an agent runtime on the request path. */
const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; why: string }> = [
	{ pattern: /@earendil-works\/pi-coding-agent/, why: "the Pi coding agent SDK" },
	{ pattern: /runtime\/pi-runtime/, why: "the Pi runtime wrapper" },
	{ pattern: /\/curator\//, why: "the curator agent stage" },
	{ pattern: /\/editor\//, why: "the editor agent stage" },
];

async function walk(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".") && entry.name !== ".") {
			if (SKIP_DIRS.has(entry.name)) continue;
		}
		if (SKIP_DIRS.has(entry.name)) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await walk(full)));
		} else if (SOURCE_EXT.test(entry.name)) {
			files.push(full);
		}
	}
	return files;
}

const files = await walk(WEB_ROOT);

describe("no LLM on the request path", () => {
	it("finds source files to check", () => {
		// A silently empty walk would make every assertion below vacuous.
		expect(files.length).toBeGreaterThan(10);
	});

	it("never imports an agent runtime anywhere under web/", async () => {
		const offenders: string[] = [];
		for (const file of files) {
			const source = await readFile(file, "utf8");
			for (const { pattern, why } of FORBIDDEN) {
				if (pattern.test(source)) {
					offenders.push(`${relative(WEB_ROOT, file)} references ${why}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it("never renders source-derived text as raw HTML", async () => {
		const offenders: string[] = [];
		for (const file of files) {
			const source = await readFile(file, "utf8");
			if (source.includes("dangerouslySetInnerHTML")) {
				offenders.push(relative(WEB_ROOT, file));
			}
		}
		expect(offenders).toEqual([]);
	});

	it("never exposes the database connection to the client bundle", async () => {
		const offenders: string[] = [];
		for (const file of files) {
			const source = await readFile(file, "utf8");
			if (/NEXT_PUBLIC_[A-Z_]*(DATABASE|PG|POSTGRES|DB_URL)/.test(source)) {
				offenders.push(relative(WEB_ROOT, file));
			}
			// A client component must not be able to pull in the pool module.
			if (/^\s*["']use client["']/m.test(source) && /lib\/(db|queries)\.ts/.test(source)) {
				offenders.push(`${relative(WEB_ROOT, file)} is a client component importing server data access`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
