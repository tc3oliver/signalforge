import { describe, expect, it } from "vitest";
import {
	InvalidAgentOutputError,
	ProgrammerError,
	ToolLoopError,
	classifyError,
	sanitizeValue,
} from "../src/runtime/error-classifier.ts";

function withProps<T extends object>(err: Error, props: T): Error {
	return Object.assign(err, props);
}

describe("classifyError — HTTP status", () => {
	it.each([
		[401, "AUTH"],
		[403, "AUTH"],
		[402, "BILLING"],
		[404, "MODEL_UNAVAILABLE"],
		[500, "SERVER_ERROR"],
		[502, "SERVER_ERROR"],
		[503, "SERVER_ERROR"],
	])("maps status %i to %s", (status, expected) => {
		const err = withProps(new Error("upstream said no"), { status });
		expect(classifyError(err).failureClass).toBe(expected);
	});

	it("reads statusCode as well as status", () => {
		expect(classifyError(withProps(new Error("nope"), { statusCode: 503 })).failureClass).toBe("SERVER_ERROR");
	});

	it("reads a nested response.status", () => {
		const err = withProps(new Error("nope"), { response: { status: 401 } });
		expect(classifyError(err).failureClass).toBe("AUTH");
	});
});

describe("classifyError — 429 QUOTA vs RATE_LIMIT split", () => {
	it("is RATE_LIMIT when the message is only about pacing", () => {
		const err = withProps(new Error("Rate limit reached, please slow down"), { status: 429 });
		expect(classifyError(err).failureClass).toBe("RATE_LIMIT");
	});

	it.each([
		"You exceeded your current quota",
		"Insufficient credit balance",
		"billing hard limit reached",
		"exceeded your current plan allowance",
	])("is QUOTA when the message says %j", (message) => {
		const err = withProps(new Error(message), { status: 429 });
		expect(classifyError(err).failureClass).toBe("QUOTA");
	});
});

describe("classifyError — error codes", () => {
	it.each([
		["ENOTFOUND", "NETWORK"],
		["ECONNREFUSED", "NETWORK"],
		["ECONNRESET", "NETWORK"],
		["EAI_AGAIN", "NETWORK"],
		["ETIMEDOUT", "TIMEOUT"],
		["ABORT_ERR", "USER_ABORT"],
	])("maps code %s to %s", (code, expected) => {
		expect(classifyError(withProps(new Error("socket"), { code })).failureClass).toBe(expected);
	});
});

describe("classifyError — error names", () => {
	it("maps AbortError to USER_ABORT", () => {
		const err = new Error("aborted");
		err.name = "AbortError";
		expect(classifyError(err).failureClass).toBe("USER_ABORT");
	});

	it.each([new TypeError("x is not a function"), new ReferenceError("y is not defined"), new SyntaxError("bad")])(
		"maps %s to PROGRAMMER_ERROR",
		(err) => {
			expect(classifyError(err).failureClass).toBe("PROGRAMMER_ERROR");
		},
	);
});

describe("classifyError — app marker errors", () => {
	it("maps InvalidAgentOutputError", () => {
		expect(classifyError(new InvalidAgentOutputError("schema mismatch")).failureClass).toBe("INVALID_AGENT_OUTPUT");
	});

	it("maps ToolLoopError", () => {
		expect(classifyError(new ToolLoopError("12 tool calls, no answer")).failureClass).toBe("TOOL_LOOP");
	});

	it("maps ProgrammerError", () => {
		expect(classifyError(new ProgrammerError("unreachable")).failureClass).toBe("PROGRAMMER_ERROR");
	});
});

describe("classifyError — message heuristics", () => {
	it.each([
		["Request exceeds the maximum context length of the model", "CONTEXT_OVERFLOW"],
		["too many tokens in this request", "CONTEXT_OVERFLOW"],
		["context length exceeded", "CONTEXT_OVERFLOW"],
		["rate limit exceeded for requests", "RATE_LIMIT"],
		["model not found: gemini-9", "MODEL_UNAVAILABLE"],
		["unsupported model for this endpoint", "MODEL_UNAVAILABLE"],
		["The operation timed out", "TIMEOUT"],
		["payment required to continue", "BILLING"],
		["your quota has been used up", "QUOTA"],
	])("maps %j to %s", (message, expected) => {
		expect(classifyError(new Error(message)).failureClass).toBe(expected);
	});

	it("falls back to UNKNOWN", () => {
		expect(classifyError(new Error("something odd happened")).failureClass).toBe("UNKNOWN");
	});

	it("handles non-Error throws", () => {
		expect(classifyError("just a string").failureClass).toBe("UNKNOWN");
		expect(classifyError(undefined).failureClass).toBe("UNKNOWN");
		expect(classifyError(null).failureClass).toBe("UNKNOWN");
	});
});

describe("classifyError — cause chain recursion", () => {
	it("classifies from a nested cause", () => {
		const root = withProps(new Error("getaddrinfo failed"), { code: "ENOTFOUND" });
		const wrapper = new Error("curator stage failed", { cause: root });
		expect(classifyError(wrapper).failureClass).toBe("NETWORK");
	});

	it("classifies from a two-deep cause", () => {
		const root = withProps(new Error("no seats left"), { status: 402 });
		const mid = new Error("provider call failed", { cause: root });
		const outer = new Error("stage failed", { cause: mid });
		expect(classifyError(outer).failureClass).toBe("BILLING");
	});

	it("prefers the outermost structural signal over an inner one", () => {
		const inner = withProps(new Error("inner"), { status: 500 });
		const outer = withProps(new Error("outer"), { status: 401, cause: inner });
		expect(classifyError(outer).failureClass).toBe("AUTH");
	});

	it("prefers any structural signal over a message heuristic", () => {
		// Outer message alone would read as TIMEOUT; the inner status is stronger.
		const inner = withProps(new Error("inner"), { status: 402 });
		const outer = new Error("the request timed out waiting for upstream", { cause: inner });
		expect(classifyError(outer).failureClass).toBe("BILLING");
	});

	it("records the cause chain in errorMeta", () => {
		const root = new Error("root cause");
		const outer = new Error("outer", { cause: root });
		const chain = classifyError(outer).errorMeta["causeChain"] as Array<{ name: string; message: string }>;
		expect(chain).toHaveLength(1);
		expect(chain[0]).toEqual({ name: "Error", message: "root cause" });
	});

	it("survives a cyclic cause chain", () => {
		const a: Error & { cause?: unknown } = new Error("a");
		const b: Error & { cause?: unknown } = new Error("b", { cause: a });
		a.cause = b;
		expect(() => classifyError(b)).not.toThrow();
	});
});

describe("classifyError — errorMeta sanitization", () => {
	it("strips nested headers.authorization and apiKey", () => {
		const err = withProps(new Error("Unauthorized"), {
			status: 401,
			apiKey: "sk-live-SUPERSECRET",
			headers: { authorization: "Bearer x", "content-type": "application/json" },
			config: { auth: { api_key: "sk-nested-SECRET" } },
		});

		const { failureClass, errorMeta } = classifyError(err);
		expect(failureClass).toBe("AUTH");

		const serialized = JSON.stringify(errorMeta);
		expect(serialized).not.toContain("SUPERSECRET");
		expect(serialized).not.toContain("sk-nested-SECRET");
		expect(serialized).not.toContain("Bearer x");
		expect(serialized.toLowerCase()).not.toContain("authorization");
		expect(errorMeta).not.toHaveProperty("apiKey");
		expect(errorMeta).not.toHaveProperty("headers");
		expect(errorMeta).not.toHaveProperty("config");
	});

	it("keeps only name, status, code, message and causeChain", () => {
		const err = withProps(new Error("boom"), { status: 500, code: "E_BOOM", env: process.env });
		const { errorMeta } = classifyError(err);
		expect(Object.keys(errorMeta).sort()).toEqual(["code", "message", "name", "status"]);
		expect(errorMeta).toMatchObject({ name: "Error", status: 500, code: "E_BOOM", message: "boom" });
	});

	it("truncates a long message to 500 characters plus an ellipsis", () => {
		const { errorMeta } = classifyError(new Error("z".repeat(5_000)));
		const message = errorMeta["message"] as string;
		expect(message).toHaveLength(501);
		expect(message.endsWith("…")).toBe(true);
	});
});

describe("classifyError — undici transport failures wearing a TypeError", () => {
	/** The exact shape `fetch()` throws: a bare TypeError with the truth in `cause`. */
	function fetchFailed(code: string, causeMessage: string): Error {
		const cause = withProps(new Error(causeMessage), { code });
		return new TypeError("fetch failed", { cause });
	}

	it.each([
		["ECONNRESET", "read ECONNRESET", "NETWORK"],
		["ENOTFOUND", "getaddrinfo ENOTFOUND api.example.com", "NETWORK"],
		["ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:443", "NETWORK"],
		["UND_ERR_SOCKET", "other side closed", "NETWORK"],
		["UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error", "TIMEOUT"],
	])("classifies fetch failed / %s as %s rather than PROGRAMMER_ERROR", (code, causeMessage, expected) => {
		expect(classifyError(fetchFailed(code, causeMessage)).failureClass).toBe(expected);
	});

	it("still classifies fetch failed when the cause carries no recognised code", () => {
		const err = new TypeError("fetch failed", { cause: new Error("terminated") });
		expect(classifyError(err).failureClass).toBe("NETWORK");
	});

	it("does not mask a genuine programmer TypeError with no cause", () => {
		expect(classifyError(new TypeError("undefined is not a function")).failureClass).toBe("PROGRAMMER_ERROR");
		expect(classifyError(new ReferenceError("storyId is not defined")).failureClass).toBe("PROGRAMMER_ERROR");
	});

	it("keeps a schema validation failure failing fast", () => {
		const zodish = withProps(new Error("Invalid input: expected string, received number"), { name: "ZodError" });
		expect(classifyError(new InvalidAgentOutputError("materials failed validation", { cause: zodish })).failureClass).toBe(
			"INVALID_AGENT_OUTPUT",
		);
		expect(classifyError(new ProgrammerError("config schema rejected", { cause: zodish })).failureClass).toBe(
			"PROGRAMMER_ERROR",
		);
	});
});

describe("classifyError — abort is not automatically the user's doing", () => {
	it("treats a provider's 'request aborted' as NETWORK, not USER_ABORT", () => {
		expect(classifyError(new Error("upstream request aborted")).failureClass).toBe("NETWORK");
	});

	it("still honours an explicit user cancellation", () => {
		expect(classifyError(new Error("The operation was cancelled by the user")).failureClass).toBe("USER_ABORT");
		const named = withProps(new Error("aborted"), { name: "AbortError" });
		expect(classifyError(named).failureClass).toBe("USER_ABORT");
	});

	it("reads an AbortError raised by a deadline as TIMEOUT", () => {
		const named = withProps(new Error("This operation was aborted due to timeout"), { name: "AbortError" });
		expect(classifyError(named).failureClass).toBe("TIMEOUT");
		const coded = withProps(new Error("The operation timed out and was aborted"), { code: "ABORT_ERR" });
		expect(classifyError(coded).failureClass).toBe("TIMEOUT");
	});
});

describe("errorMeta redaction", () => {
	it("scrubs a credential out of the persisted message instead of only truncating it", () => {
		const err = new Error("401 Unauthorized: invalid api key sk-live-ABCDEF123456");
		const { errorMeta } = classifyError(err);
		expect(errorMeta["message"]).toBe("401 Unauthorized: invalid api key [REDACTED]");
	});

	it("classifies on the original message, not the scrubbed copy", () => {
		// The scrub removes the key but must not remove the words the classifier
		// reads, or a real AUTH failure would degrade to UNKNOWN and be retried.
		const err = new Error("invalid api key sk-live-ABCDEF123456");
		expect(classifyError(err).failureClass).toBe("AUTH");
	});

	it("redacts the newer secret key names on an error's own properties", () => {
		const err = withProps(new Error("boom"), {
			auth: "a",
			credentials: "b",
			passphrase: "c",
			pwd: "d",
			jwt: "e",
			signature: "f",
		});
		const meta = classifyError(err).errorMeta as Record<string, unknown>;
		// buildErrorMeta whitelists the fields it copies, so assert through
		// sanitizeValue, which is what guards anything that does get copied.
		const sanitized = sanitizeValue({
			auth: "a",
			credentials: "b",
			passphrase: "c",
			pwd: "d",
			jwt: "e",
			signature: "f",
		}) as Record<string, unknown>;
		expect(sanitized).toEqual({
			auth: "[REDACTED]",
			credentials: "[REDACTED]",
			passphrase: "[REDACTED]",
			pwd: "[REDACTED]",
			jwt: "[REDACTED]",
			signature: "[REDACTED]",
		});
		expect(meta["name"]).toBe("Error");
	});

	it("scrubs a credential in a cause-chain message", () => {
		const inner = new Error("connect failed to postgres://di:hunter2@10.10.10.10:5432/sf");
		const outer = new Error("fetch failed", { cause: inner });
		const { errorMeta } = classifyError(outer);
		const chain = errorMeta["causeChain"] as Array<{ message: string }>;
		expect(chain[0]?.message).toBe(
			"connect failed to postgres://[REDACTED]@10.10.10.10:5432/sf",
		);
	});

	it("still truncates a long message after scrubbing it", () => {
		const err = new Error(`${"x".repeat(600)} Bearer eyJhbGciOiJIUzI1NiJ9.abc`);
		const message = errorMetaMessage(err);
		expect(message.endsWith("…")).toBe(true);
		expect(message).not.toContain("eyJhbGciOiJIUzI1NiJ9");
	});
});

function errorMetaMessage(err: unknown): string {
	return String(classifyError(err).errorMeta["message"]);
}
