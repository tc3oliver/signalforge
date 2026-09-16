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
	PNPM_BIN_DIR: "/opt/runtimes/pnpm/10",
	LOG_DIR: "/home/example/daily-intelligence/logs",
	UID: "501",
	// Baked in rather than inherited: the date a run is stamped with depends on it.
	TIMEZONE: "Asia/Taipei",
	// Likewise baked in: the origin the reader's absolute metadata URLs are
	// built from. A stand-in, for the same reason the paths above are.
	SITE_URL: "https://reader.example.com",
};

/** Every template, for the checks that hold whatever the job does. */
const TEMPLATES = [
	"../launchd/daily.plist.template",
	"../launchd/incremental.plist.template",
	"../launchd/web.plist.template",
] as const;

/**
 * The scheduled jobs. The reader is excluded: it is a long-lived service, so
 * starting at load is the point rather than an accident to guard against.
 */
const SCHEDULED_TEMPLATES = [
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
			// A slash does not make a value a path: an IANA zone has one too, and
			// so does a URL, which is an absolute address of a different kind.
			if (value === TOKENS.TIMEZONE) continue;
			if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) continue;
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

});

describe.each(SCHEDULED_TEMPLATES)("scheduled job %s", (path) => {
	const template = readFileSync(new URL(path, import.meta.url), "utf8");

	it("declares RunAtLoad false so installing never triggers an immediate run", () => {
		const rendered = renderPlist(template, TOKENS);
		expect(rendered).toMatch(/<key>RunAtLoad<\/key>\s*<false\s*\/>/);
	});
});

describe("reader service template", () => {
	const template = readFileSync(new URL("../launchd/web.plist.template", import.meta.url), "utf8");

	it("starts at load and is restarted when it exits", () => {
		const rendered = renderPlist(template, TOKENS);
		expect(rendered).toMatch(/<key>RunAtLoad<\/key>\s*<true\s*\/>/);
		expect(rendered).toMatch(/<key>KeepAlive<\/key>\s*<true\s*\/>/);
		expect(rendered).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>\d+<\/integer>/);
	});

	it("binds every interface so the edge can proxy to it", () => {
		const rendered = renderPlist(template, TOKENS);
		expect(rendered).toContain("<key>WEB_HOST</key>");
		expect(rendered).toContain("<string>0.0.0.0</string>");
		expect(rendered).toContain("<key>WEB_PORT</key>");
	});

	it("never enables the admin routes", () => {
		// Admin is off unless SIGNALFORGE_ADMIN is set, and a public vhost is
		// exactly where it must stay off.
		expect(template).not.toContain("SIGNALFORGE_ADMIN");
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

/*
 * The scheduled jobs go through a preflight rather than straight to pnpm.
 *
 * macOS suspends the OrbStack VM when the host sleeps and OrbStack resumes it
 * only on a real user wake, so a job that fires on time can find its database
 * gone while the host-side port forwarder still accepts TCP -- the failure
 * arrives as a connect timeout, not a refusal. On 2026-09-16 that took the whole
 * brief: launchd fired at 05:30, the first query timed out, the run ended, and
 * the VM came back at 05:59 because a network packet happened to arrive.
 */
describe("scheduled jobs wait for their container host", () => {
	const PREFLIGHT = "scripts/with-container-host.sh";

	/** The rendered ProgramArguments of one template, in order. */
	function programArguments(job: "daily" | "incremental" | "web"): string[] {
		const template = readFileSync(
			new URL(`../launchd/${job}.plist.template`, import.meta.url),
			"utf8",
		);
		const block = renderPlist(template, TOKENS).match(
			/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/,
		);
		return Array.from(block?.[1]?.matchAll(/<string>([\s\S]*?)<\/string>/g) ?? []).map((m) => m[1] ?? "");
	}

	for (const job of ["daily", "incremental"] as const) {
		it(`${job} runs through the preflight, with its command unchanged after it`, () => {
			const args = programArguments(job);
			expect(args[0], `${job} does not start with the preflight`).toContain(PREFLIGHT);
			// The preflight execs what follows, so the original invocation has to
			// survive intact -- a wrapper that rewrote the command would be a second
			// place for the job definition to drift.
			expect(args.slice(1, 3)).toEqual([TOKENS.PNPM_BIN, "run"]);
			expect(args[3]).toBe(job === "daily" ? "daily" : "collect");
		});
	}

	it("leaves the always-on reader alone", () => {
		// The reader is not scheduled; it is restarted by launchd when it exits, and
		// it has to come up and report its own failure rather than block on a host.
		expect(programArguments("web")[0]).not.toContain(PREFLIGHT);
	});
});
