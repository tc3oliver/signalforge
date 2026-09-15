import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, localConfigName, reloadConfig } from "../src/config/loader.ts";

/**
 * Every config/*.yaml in the repository is a shipped default. The operator's
 * real configuration lives beside it as *.local.yaml, is gitignored, and wins
 * outright -- which is what keeps one person's interests and watchlists out of
 * a public repository without any of it becoming a runtime special case.
 */
describe("localConfigName", () => {
	it("inserts .local before the extension", () => {
		expect(localConfigName("interests.yaml")).toBe("interests.local.yaml");
		expect(localConfigName("agent.yaml")).toBe("agent.local.yaml");
	});

	it("splits on the last dot, so a dotted stem survives", () => {
		expect(localConfigName("a.b.yaml")).toBe("a.b.local.yaml");
	});
});

describe("config resolution", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
		reloadConfig();
	});

	function makeRoot(files: Record<string, string>): string {
		const root = mkdtempSync(join(tmpdir(), "sf-config-"));
		roots.push(root);
		mkdirSync(join(root, "config"));
		for (const [name, body] of Object.entries(files)) {
			writeFileSync(join(root, "config", name), body, "utf8");
		}
		return root;
	}

	const SHIPPED = "topics:\n  - id: shipped\n    label: Shipped\n    weight: 0.1\n";
	const LOCAL = "topics:\n  - id: mine\n    label: Mine\n    weight: 1.0\n";
	/*
	 * sources.yaml and agent.yaml have to name every collector and every stage,
	 * so the repository's own shipped defaults stand in rather than a stub that
	 * would need updating whenever a collector is added. Only interests.yaml
	 * varies between these cases; it is the one under test.
	 */
	const REPO_CONFIG = join(import.meta.dirname, "..", "config");
	const OTHERS = {
		"watchlists.yaml": readFileSync(join(REPO_CONFIG, "watchlists.yaml"), "utf8"),
		"sources.yaml": readFileSync(join(REPO_CONFIG, "sources.yaml"), "utf8"),
		"discovery.yaml": readFileSync(join(REPO_CONFIG, "discovery.yaml"), "utf8"),
		"agent.yaml": readFileSync(join(REPO_CONFIG, "agent.yaml"), "utf8"),
	};

	it("reads the shipped file when no local override exists", () => {
		reloadConfig();
		const root = makeRoot({ "interests.yaml": SHIPPED, ...OTHERS });
		expect(loadConfig(root).interests.topics[0]!.id).toBe("shipped");
	});

	it("prefers the local override when it exists", () => {
		reloadConfig();
		const root = makeRoot({ "interests.yaml": SHIPPED, "interests.local.yaml": LOCAL, ...OTHERS });
		expect(loadConfig(root).interests.topics[0]!.id).toBe("mine");
	});

	it("replaces rather than merges, so a shipped default cannot leak through", () => {
		reloadConfig();
		const root = makeRoot({ "interests.yaml": SHIPPED, "interests.local.yaml": LOCAL, ...OTHERS });
		const ids = loadConfig(root).interests.topics.map((t) => t.id);
		expect(ids).toEqual(["mine"]);
		expect(ids).not.toContain("shipped");
	});

	it("validates the local override against the same schema", () => {
		reloadConfig();
		const root = makeRoot({ "interests.yaml": SHIPPED, "interests.local.yaml": "topics: []\n", ...OTHERS });
		expect(() => loadConfig(root)).toThrow(/interests\.local\.yaml/);
	});

	/*
	 * The cache used to be a single slot that ignored `root`, so the second root
	 * here silently received the first root's configuration. Note there is no
	 * reloadConfig() between the two calls: needing one is the bug.
	 */
	it("caches per root, so a second root is not served the first root's config", () => {
		reloadConfig();
		const first = makeRoot({ "interests.yaml": SHIPPED, ...OTHERS });
		const second = makeRoot({ "interests.yaml": LOCAL, ...OTHERS });
		expect(loadConfig(first).interests.topics[0]!.id).toBe("shipped");
		expect(loadConfig(second).interests.topics[0]!.id).toBe("mine");
	});

	it("still returns the same object for repeated calls on one root", () => {
		reloadConfig();
		const root = makeRoot({ "interests.yaml": SHIPPED, ...OTHERS });
		expect(loadConfig(root)).toBe(loadConfig(root));
	});

	it("reloadConfig clears every root, not just the last one", () => {
		reloadConfig();
		const root = makeRoot({ "interests.yaml": SHIPPED, ...OTHERS });
		const before = loadConfig(root);
		reloadConfig();
		expect(loadConfig(root)).not.toBe(before);
	});
});
