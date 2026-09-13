import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Absolute path, never a shell alias: this must work from a non-interactive
// shell (launchd, cron-like schedulers) that never sources ~/.zshrc.
const SECURITY_BIN = "/usr/bin/security";

/** Keychain generic-password coordinates for one logical secret name. */
export type KeychainMapping = {
	service: string;
	account: string;
};

/**
 * Known logical-secret -> Keychain (service, account) mappings. Extend this as
 * new collectors are wired up; a name with no mapping simply cannot be found
 * in the Keychain (env can still supply it).
 */
export const KEYCHAIN_MAPPINGS: Readonly<Record<string, KeychainMapping>> = Object.freeze({
	TAVILY_API_KEY: { service: "pi-tavily", account: "oliver" },
});

/** Injectable for tests: never invoke the real Keychain in a unit test. */
export type KeychainReader = (mapping: KeychainMapping) => Promise<string | undefined>;

async function defaultKeychainReader(mapping: KeychainMapping): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync(SECURITY_BIN, [
			"find-generic-password",
			"-s",
			mapping.service,
			"-a",
			mapping.account,
			"-w",
		]);
		const value = stdout.trim();
		return value.length > 0 ? value : undefined;
	} catch {
		// Not found, access denied, or Keychain unavailable — all indistinguishable
		// from "no secret" for our purposes, and none of it is worth surfacing the
		// underlying stderr for (it can include the account name but never a value;
		// we still don't propagate it to keep this function's contract simple).
		return undefined;
	}
}

export type SecretResolverOptions = {
	/** Test seam; defaults to reading `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Test seam; defaults to calling `/usr/bin/security`. */
	readKeychain?: KeychainReader;
	mappings?: Readonly<Record<string, KeychainMapping>>;
};

/**
 * Resolves a logical secret name to its value: process env first, then macOS
 * Keychain. Throws a descriptive error if neither has it — the error names
 * the secret and where it was looked for, NEVER a value (there is none to leak
 * in the not-found case, and the found case never reaches the error path).
 */
export async function resolveSecret(name: string, options: SecretResolverOptions = {}): Promise<string> {
	const env = options.env ?? process.env;
	const readKeychain = options.readKeychain ?? defaultKeychainReader;
	const mappings = options.mappings ?? KEYCHAIN_MAPPINGS;

	const fromEnv = env[name];
	if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;

	const mapping = mappings[name];
	if (mapping) {
		const fromKeychain = await readKeychain(mapping);
		if (fromKeychain !== undefined && fromKeychain.length > 0) return fromKeychain;
	}

	const lookedIn = mapping
		? `env var "${name}" or Keychain item (service="${mapping.service}", account="${mapping.account}")`
		: `env var "${name}" (no Keychain mapping configured for this name)`;
	throw new Error(`Secret "${name}" not found. Looked in: ${lookedIn}.`);
}

/** Checks whether a secret is available WITHOUT returning its value. */
export async function hasSecret(name: string, options: SecretResolverOptions = {}): Promise<boolean> {
	try {
		await resolveSecret(name, options);
		return true;
	} catch {
		return false;
	}
}
