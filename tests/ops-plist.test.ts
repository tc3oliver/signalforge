import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderPlist, validatePlist } from "../src/ops/plist.ts";

/*
 * Representative values, not this machine's. The installer resolves the real
 * ones at install time (`id -u` for UID, `which` for the binaries); nothing
 * here may be hardcoded anywhere a run would read it, so the test uses
 * stand-ins that are merely shaped like absolute paths.
 */
const TOKENS = {
	PROJECT_ROOT: "/home/example/daily-intelligence",
	NODE_BIN: "/opt/runtimes/node/24/bin/node",
	PNPM_BIN: "/opt/runtimes/pnpm/10/pnpm",
	NODE_BIN_DIR: "/opt/runtimes/node/24/bin",
	LOG_DIR: "/home/example/daily-intelligence/logs",
	UID: "501",
};

const TEMPLATES = [
	"../launchd/daily.plist.template",
	"../launchd/incremental.plist.template",
] as const;

describe.each(TEMPLATES)("plist template %s", (path) => {
	const template = readFileSync(new URL(path, import.meta.url), "utf8");

	it("has no unfilled tokens after rendering", () => {
		const rendered = renderPlist(template, TOKENS);
		expect(rendered).not.toContain("{{");
		expect(rendered).not.toContain("}}");
	});

	it("passes structural validation once rendered", () => {
		const rendered = renderPlist(template, TOKENS);
		const result = validatePlist(rendered);
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it("contains only absolute paths", () => {
		const rendered = renderPlist(template, TOKENS);
		const strings = rendered.match(/<string>([^<]*)<\/string>/g) ?? [];
		for (const raw of strings) {
			const value = raw.slice("<string>".length, -"</string>".length);
			const looksLikePath = value.includes("/") && !value.includes(" ");
			if (looksLikePath) {
				expect(value.startsWith("/")).toBe(true);
			}
		}
	});

	it("does not hardcode a uid", () => {
		// The template itself must never spell out a literal uid -- it is
		// resolved at install time via `id -u` and only ever reaches the
		// launchctl domain argument, never the plist body.
		expect(template).not.toMatch(/gui\/\d+/);
	});

	it("declares RunAtLoad false so installing never triggers an immediate run", () => {
		const rendered = renderPlist(template, TOKENS);
		expect(rendered).toMatch(/<key>RunAtLoad<\/key>\s*<false\s*\/>/);
	});
});

describe("renderPlist", () => {
	it("substitutes every occurrence of a token", () => {
		const out = renderPlist("{{A}} and {{A}} and {{B}}", { A: "x", B: "y" });
		expect(out).toBe("x and x and y");
	});

	it("leaves unknown tokens untouched", () => {
		const out = renderPlist("{{KNOWN}} {{UNKNOWN}}", { KNOWN: "ok" });
		expect(out).toBe("ok {{UNKNOWN}}");
	});
});

describe("validatePlist", () => {
	const validXml = readFileSync(new URL("../launchd/daily.plist.template", import.meta.url), "utf8");

	it("flags a leftover template token", () => {
		const rendered = renderPlist(validXml, { ...TOKENS, PROJECT_ROOT: "" });
		const result = validatePlist(`${rendered}\n<!-- {{OOPS}} -->`);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("token"))).toBe(true);
	});

	it("flags a missing required key", () => {
		const rendered = renderPlist(validXml, TOKENS).replace(/<key>Label<\/key>\s*<string>[^<]*<\/string>/, "");
		const result = validatePlist(rendered);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("missing required key: Label");
	});

	it("flags unbalanced tags", () => {
		const result = validatePlist("<plist><dict><key>Label</key></plist>");
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("unbalanced XML tags");
	});

	it("does not contain a credential-looking value", () => {
		const rendered = renderPlist(validXml, TOKENS);
		expect(rendered).not.toMatch(/password/i);
		expect(rendered).not.toMatch(/api[_-]?key/i);
		expect(rendered).not.toMatch(/secret/i);
		expect(rendered).not.toMatch(/token/i);
	});
});
