import { describe, expect, it } from "vitest";
import { isSecretKey, redactValue, scrubSecrets } from "../src/runtime/redact.ts";

/**
 * Redaction has two failure modes and only one of them is loud.
 *
 * A credential that survives is the obvious one. The quiet one is a diagnostic
 * field destroyed by an over-broad match: an operator who sees [REDACTED] where
 * `sourceKey` should be cannot tell which collector failed, and learns that the
 * marker is noise -- which is what makes the next genuine redaction easy to
 * ignore. This file pins both directions, because the matcher is a hand-kept
 * list and a new `*Key` field is exactly the kind of drift nothing else catches.
 */

/** Real field names from this codebase that must stay readable. */
const MUST_STAY_READABLE: Array<[string, unknown]> = [
	["sourceKey", "github"],
	["enabledSourceKeys", ["github", "arxiv"]],
	["eventKey", "evt-1"],
	["dateKey", "2026-09-15"],
	["sortKey", "date"],
	["configKeys", ["agent", "sources"]],
	["keywords", ["llm"]],
	["author", "Jane Roe"],
	["authors", ["Jane Roe"]],
	["authorCount", 2],
	["hasKey", true],
	["hasToken", false],
	["hasSecret", false],
	["tokenOverlap", 0.42],
	["token_overlap", 0.42],
	["pass", true],
	["overallPass", true],
	["passed", 12],
	["bypass", "none"],
	["passthrough", "off"],
];

/** Names that must never serialise their value, whatever it holds. */
const MUST_BE_REDACTED: string[] = [
	"apiKey",
	"api_key",
	"authorization",
	"Authorization",
	"X-Auth-Token",
	"password",
	"passphrase",
	"pwd",
	"sessionToken",
	"accessToken",
	"refreshToken",
	"clientSecret",
	"privateKey",
	"cookie",
	"jwt",
	"signature",
	"credentials",
	"sessionId",
	"nonce",
];

describe("secret key policy", () => {
	it.each(MUST_STAY_READABLE)("keeps %s readable", (key, value) => {
		expect(isSecretKey(key, value)).toBe(false);
	});

	it.each(MUST_BE_REDACTED)("redacts %s", (key) => {
		expect(isSecretKey(key, "a-credential-shaped-string")).toBe(true);
	});

	it("never redacts a boolean or a number, because neither can be a credential", () => {
		// `hasSecret: false` answers "was the key configured at all". Redacting it
		// hides the answer and protects nothing.
		expect(redactValue({ apiKey: false, tokenCount: 3 })).toEqual({
			apiKey: false,
			tokenCount: 3,
		});
	});

	it("still redacts a credential in a field the name does not mark", () => {
		// This is the value layer's job, and it is why the key list can afford to
		// be narrow rather than matching every name containing "key".
		expect(redactValue({ note: "GET /x?api_key=abcdef0123456789abcdef0123456789 failed" })).toEqual(
			{ note: "GET /x?api_key=[REDACTED] failed" },
		);
	});

	it("scrubs the query-string credentials this project's own collectors emit", () => {
		expect(scrubSecrets("https://api.stlouisfed.org/fred/series?id=GDP&api_key=abcdef0123456789")).toBe(
			"https://api.stlouisfed.org/fred/series?id=GDP&api_key=[REDACTED]",
		);
		expect(scrubSecrets("https://www.googleapis.com/youtube/v3/search?part=id&key=AIzaSyFAKE0000FAKE0000FAKE")).toBe(
			"https://www.googleapis.com/youtube/v3/search?part=id&key=[REDACTED]",
		);
		expect(scrubSecrets("GET /simple/price?ids=btc&x_cg_demo_api_key=CG-fakedemokey0123456789")).toBe(
			"GET /simple/price?ids=btc&x_cg_demo_api_key=[REDACTED]",
		);
	});

	it("does not serialise a Buffer as a decodable byte map", () => {
		const held = redactValue({ body: Buffer.from("authorization: Bearer ghp_FAKEFAKEFAKE") });
		expect(JSON.stringify(held)).not.toContain("97");
		expect(held).toEqual({ body: "[REDACTED]" });
	});
});
