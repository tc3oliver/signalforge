import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Loads credentials from a file outside the repository into `process.env`, so
 * an operator has one place to put keys that is not a tracked config, not a
 * dotfile beside the code, and not shell history.
 *
 * It sits in front of the resolver in `secrets.ts`, which already reads the
 * environment first and the Keychain second. That ordering is deliberately not
 * changed here: this file only populates the environment, so the resulting
 * precedence is
 *
 *   explicit environment variable  >  secrets.env  >  Keychain
 *
 * An explicit variable wins because someone who typed it for this invocation
 * meant it. A blank line in the file sets nothing at all, so it cannot shadow a
 * Keychain entry that works today — which is what keeps a file full of empty
 * placeholders from breaking an auth flow that was already fine.
 *
 * Nothing here ever logs a value, and no caller is given one: the result says
 * which NAMES were set and nothing more.
 */

export const DEFAULT_SECRETS_FILE = join(homedir(), ".config", "daily-intelligence", "secrets.env");

/** Points the loader somewhere else. For tests, and for an operator who keeps this file elsewhere. */
export const SECRETS_FILE_ENV_VAR = "DAILY_INTELLIGENCE_SECRETS_FILE";

function defaultPath(env: NodeJS.ProcessEnv): string {
	const override = env[SECRETS_FILE_ENV_VAR];
	return override !== undefined && override.trim() !== "" ? override.trim() : DEFAULT_SECRETS_FILE;
}

export interface SecretsFileResult {
	path: string;
	/** False when the file is simply absent, which is a normal way to run. */
	found: boolean;
	/** Names set into the environment by this call. Never any value. */
	loaded: string[];
	/** Names present in the file but left blank, so deliberately not set. */
	blank: string[];
	/** Names skipped because the environment already had them. */
	alreadySet: string[];
	/** Non-fatal problems worth telling an operator about. Never contains a value. */
	warnings: string[];
}

export interface LoadSecretsFileOptions {
	path?: string;
	env?: NodeJS.ProcessEnv;
	/** Test seam; defaults to the real filesystem. */
	readFile?: (path: string) => string;
	/** Test seam; returns the file's permission bits, or undefined if unknown. */
	statMode?: (path: string) => number | undefined;
}

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Reads the file if it is there and returns what it would set. A missing file is
 * not an error: the product is expected to run with no credentials at all, with
 * the optional collectors reporting DISABLED.
 */
export function loadSecretsFile(options: LoadSecretsFileOptions = {}): SecretsFileResult {
	const env = options.env ?? process.env;
	const path = options.path ?? defaultPath(env);
	const readFile = options.readFile ?? ((p: string) => readFileSync(p, "utf8"));
	const statMode =
		options.statMode ??
		((p: string) => {
			try {
				return statSync(p).mode & 0o777;
			} catch {
				return undefined;
			}
		});

	const result: SecretsFileResult = {
		path,
		found: false,
		loaded: [],
		blank: [],
		alreadySet: [],
		warnings: [],
	};

	let contents: string;
	try {
		contents = readFile(path);
	} catch (err) {
		// ENOENT is the ordinary case and says nothing. Anything else is worth
		// surfacing, but only its code -- an error from a credentials file has no
		// business carrying the file's contents into a log.
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			result.warnings.push(`could not read ${path} (${code ?? "unknown error"}); continuing without it`);
		}
		return result;
	}
	result.found = true;

	const mode = statMode(path);
	if (mode !== undefined && (mode & 0o077) !== 0) {
		result.warnings.push(
			`${path} is mode ${mode.toString(8).padStart(3, "0")}; it holds credentials and should be 600`,
		);
	}

	for (const rawLine of contents.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;

		const match = KEY_LINE.exec(line.startsWith("export ") ? line.slice("export ".length).trim() : line);
		if (!match) {
			// Naming the line number rather than the line: a malformed line in this
			// particular file may well be a malformed credential.
			continue;
		}

		const key = match[1]!;
		let value = match[2]!.trim();
		if (
			(value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
			(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
		) {
			value = value.slice(1, -1);
		}

		if (value === "") {
			result.blank.push(key);
			continue;
		}
		if (env[key] !== undefined && env[key] !== "") {
			result.alreadySet.push(key);
			continue;
		}
		env[key] = value;
		result.loaded.push(key);
	}

	return result;
}

/**
 * Loads the file and reports what happened in terms an operator can act on:
 * how many names were set, which were left blank, and any warning. The names
 * are safe to print; the values are never read back out of here.
 */
export function loadSecretsFileAndReport(
	log: (msg: string, fields?: Record<string, unknown>) => void,
	options: LoadSecretsFileOptions = {},
): SecretsFileResult {
	const result = loadSecretsFile(options);

	for (const warning of result.warnings) log(`secrets file: ${warning}`);

	if (!result.found) {
		log("secrets file absent; running with the environment and Keychain only", { path: result.path });
		return result;
	}

	log("secrets file loaded", {
		path: result.path,
		set: result.loaded.length,
		blank: result.blank.length,
		...(result.alreadySet.length > 0 ? { overriddenByEnvironment: result.alreadySet.length } : {}),
		// Names, never values. `blank` is the useful half for an operator: it is
		// exactly the list of things still waiting to be filled in.
		...(result.blank.length > 0 ? { stillBlank: result.blank.join(", ") } : {}),
	});
	return result;
}
