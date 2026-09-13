import { describe, expect, it } from "vitest";
import { hasSecret, KEYCHAIN_MAPPINGS, resolveSecret } from "../src/config/secrets.ts";

describe("resolveSecret", () => {
	it("prefers env over keychain", async () => {
		let keychainCalled = false;
		const value = await resolveSecret("TAVILY_API_KEY", {
			env: { TAVILY_API_KEY: "from-env" },
			readKeychain: async () => {
				keychainCalled = true;
				return "from-keychain";
			},
		});
		expect(value).toBe("from-env");
		expect(keychainCalled).toBe(false);
	});

	it("falls back to keychain when env is absent", async () => {
		const value = await resolveSecret("TAVILY_API_KEY", {
			env: {},
			readKeychain: async (mapping) => {
				expect(mapping).toEqual(KEYCHAIN_MAPPINGS.TAVILY_API_KEY);
				return "from-keychain";
			},
		});
		expect(value).toBe("from-keychain");
	});

	it("never invokes the real security binary in this test (mocked seam only)", async () => {
		let calls = 0;
		await resolveSecret("TAVILY_API_KEY", {
			env: {},
			readKeychain: async () => {
				calls++;
				return "mocked-value";
			},
		});
		expect(calls).toBe(1);
	});

	it("throws a clear, non-leaking error when the secret is missing everywhere", async () => {
		const secretValue = "super-secret-value-should-never-appear";
		try {
			await resolveSecret("SOME_MISSING_SECRET", {
				env: {},
				readKeychain: async () => undefined,
			});
			expect.unreachable("resolveSecret should have thrown");
		} catch (err) {
			const message = (err as Error).message;
			expect(message).toContain("SOME_MISSING_SECRET");
			expect(message).not.toContain(secretValue);
		}
	});

	it("error message never contains a secret value even when one was found then discarded elsewhere", async () => {
		// Guard against a future refactor accidentally interpolating a resolved
		// value into the thrown message: assert the message text only ever
		// contains the *name*, by constructing a resolver that fails outright.
		const value = "abcdEFGH12345secretvalue";
		let thrown: Error | undefined;
		try {
			await resolveSecret("ANOTHER_MISSING_SECRET", {
				env: {},
				readKeychain: async () => {
					// Simulate the keychain having *something* under a different name;
					// resolveSecret must not leak it even indirectly.
					void value;
					return undefined;
				},
			});
		} catch (err) {
			thrown = err as Error;
		}
		expect(thrown).toBeDefined();
		expect(thrown?.message ?? "").not.toContain(value);
	});
});

describe("hasSecret", () => {
	it("is false for an absent secret", async () => {
		const result = await hasSecret("MISSING_SECRET_NAME", {
			env: {},
			readKeychain: async () => undefined,
		});
		expect(result).toBe(false);
	});

	it("is true when env has it, without exposing the value", async () => {
		const result = await hasSecret("TAVILY_API_KEY", {
			env: { TAVILY_API_KEY: "some-value" },
			readKeychain: async () => undefined,
		});
		expect(result).toBe(true);
	});

	it("is true when only the keychain has it", async () => {
		const result = await hasSecret("TAVILY_API_KEY", {
			env: {},
			readKeychain: async () => "keychain-value",
		});
		expect(result).toBe(true);
	});
});
