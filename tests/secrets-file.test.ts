import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SECRETS_FILE, loadSecretsFile, loadSecretsFileAndReport } from "../src/config/secrets-file.ts";

function missing(): (path: string) => string {
	return () => {
		const err = new Error("ENOENT") as NodeJS.ErrnoException;
		err.code = "ENOENT";
		throw err;
	};
}

const mode600 = () => 0o600;

describe("loadSecretsFile", () => {
	it("sets only the names that actually have a value", () => {
		const env: NodeJS.ProcessEnv = {};
		const result = loadSecretsFile({
			path: "/x/secrets.env",
			env,
			statMode: mode600,
			readFile: () => "TAVILY_API_KEY=abc\nFRED_API_KEY=\nGITHUB_TOKEN=ghp_x\n",
		});

		expect(result.loaded).toEqual(["TAVILY_API_KEY", "GITHUB_TOKEN"]);
		expect(result.blank).toEqual(["FRED_API_KEY"]);
		expect(env["TAVILY_API_KEY"]).toBe("abc");
		// The one that matters: a blank placeholder must not exist in the
		// environment at all, or it would shadow a working Keychain entry.
		expect("FRED_API_KEY" in env).toBe(false);
	});

	it("does not override a variable the caller set explicitly", () => {
		const env: NodeJS.ProcessEnv = { TAVILY_API_KEY: "from-the-shell" };
		const result = loadSecretsFile({
			path: "/x/secrets.env",
			env,
			statMode: mode600,
			readFile: () => "TAVILY_API_KEY=from-the-file\n",
		});

		expect(env["TAVILY_API_KEY"]).toBe("from-the-shell");
		expect(result.alreadySet).toEqual(["TAVILY_API_KEY"]);
		expect(result.loaded).toEqual([]);
	});

	it("is a no-op when the file is absent, and says so without warning", () => {
		const env: NodeJS.ProcessEnv = {};
		const result = loadSecretsFile({ path: "/nope", env, readFile: missing(), statMode: () => undefined });

		expect(result.found).toBe(false);
		expect(result.loaded).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(Object.keys(env)).toEqual([]);
	});

	it("warns when the file is readable by anyone but itself", () => {
		const result = loadSecretsFile({
			path: "/x/secrets.env",
			env: {},
			statMode: () => 0o644,
			readFile: () => "TAVILY_API_KEY=abc\n",
		});

		expect(result.warnings.join(" ")).toMatch(/mode 644.*should be 600/);
		// It warns and carries on; refusing to start would be worse than a warning.
		expect(result.loaded).toEqual(["TAVILY_API_KEY"]);
	});

	it("ignores comments, blank lines and an export prefix, and strips quotes", () => {
		const env: NodeJS.ProcessEnv = {};
		loadSecretsFile({
			path: "/x/secrets.env",
			env,
			statMode: mode600,
			readFile: () =>
				["# a comment", "", "export SEC_USER_AGENT='Ada ada@example.test'", 'EXA_API_KEY="q"', "not a key line"].join("\n"),
		});

		expect(env["SEC_USER_AGENT"]).toBe("Ada ada@example.test");
		expect(env["EXA_API_KEY"]).toBe("q");
	});

	it("keeps a read failure's cause out of the message, and does not throw", () => {
		const result = loadSecretsFile({
			path: "/x/secrets.env",
			env: {},
			statMode: () => undefined,
			readFile: () => {
				const err = new Error("EACCES: permission denied, open '/x/secrets.env'") as NodeJS.ErrnoException;
				err.code = "EACCES";
				throw err;
			},
		});

		expect(result.found).toBe(false);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("EACCES");
	});
});

describe("what reaches the log", () => {
	it("never logs a value, only names and counts", () => {
		const lines: string[] = [];
		const log = vi.fn((msg: string, fields?: Record<string, unknown>) => {
			lines.push(`${msg} ${JSON.stringify(fields ?? {})}`);
		});

		loadSecretsFileAndReport(log, {
			path: "/x/secrets.env",
			env: {},
			statMode: mode600,
			readFile: () => "TAVILY_API_KEY=tvly-SUPERSECRET\nFRED_API_KEY=\nGITHUB_TOKEN=ghp_ALSOSECRET\n",
		});

		const all = lines.join("\n");
		expect(all).not.toContain("tvly-SUPERSECRET");
		expect(all).not.toContain("ghp_ALSOSECRET");
		expect(all).not.toContain("SUPERSECRET");
		// Names are safe and useful: "still blank" is the operator's to-do list.
		expect(all).toContain("FRED_API_KEY");
		expect(all).toMatch(/"set":2/);
	});

	it("says the file is absent rather than failing", () => {
		const log = vi.fn();
		const result = loadSecretsFileAndReport(log, {
			path: "/nope",
			env: {},
			readFile: missing(),
			statMode: () => undefined,
		});

		expect(result.found).toBe(false);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("absent"), expect.anything());
	});
});

describe("the path override", () => {
	it("is taken from the environment when no explicit path is given", () => {
		const env: NodeJS.ProcessEnv = { DAILY_INTELLIGENCE_SECRETS_FILE: "/elsewhere/creds.env" };
		const seen: string[] = [];

		const result = loadSecretsFile({
			env,
			statMode: () => 0o600,
			readFile: (p) => {
				seen.push(p);
				return "GITHUB_TOKEN=x\n";
			},
		});

		expect(seen).toEqual(["/elsewhere/creds.env"]);
		expect(result.path).toBe("/elsewhere/creds.env");
	});

	it("falls back to the default when the override is blank", () => {
		const result = loadSecretsFile({
			env: { DAILY_INTELLIGENCE_SECRETS_FILE: "   " },
			readFile: missing(),
			statMode: () => undefined,
		});
		expect(result.path).toBe(DEFAULT_SECRETS_FILE);
	});
});
