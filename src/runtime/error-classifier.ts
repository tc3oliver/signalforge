import type { FailureClass } from "../schemas/run.ts";
import { redactValue, scrubSecrets } from "./redact.ts";

const MAX_MESSAGE_LENGTH = 500;
const MAX_SANITIZE_DEPTH = 4;
const MAX_SANITIZE_ARRAY = 20;

/* -------------------------------------------------------------------------- */
/* Marker errors the app throws itself                                        */
/* -------------------------------------------------------------------------- */

/** The agent returned something that does not satisfy the stage's schema. */
export class InvalidAgentOutputError extends Error {
	override readonly name = "InvalidAgentOutputError";
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
	}
}

/** The agent kept calling tools without converging on a final answer. */
export class ToolLoopError extends Error {
	override readonly name = "ToolLoopError";
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
	}
}

/*
 * The provider accepted the turn and ran nothing.
 *
 * Not a hypothetical. From 2026-09-17 the whole `github-copilot` provider began
 * returning empty completions in this Pi installation -- no text, no tool call,
 * no error, and a usage report of zero tokens -- while `pi auth check` still
 * said "ready" and a plain `pi` chat without custom tools still answered. Every
 * model under it behaved identically, so it is the provider and not a schema
 * the model disliked.
 *
 * The pipeline could not see that. A session that is handed nothing makes no
 * progress, so it was classified TOOL_LOOP for the curator and
 * INVALID_AGENT_OUTPUT for the editor -- both of which say "the model answered
 * badly", both of which earn a retry, and neither of which is true. The chain
 * absorbed it as an ordinary fallback and three days of production ran entirely
 * on the expensive model with nothing anywhere saying the cheap one had died.
 *
 * Zero provider-reported tokens across a whole attempt is the evidence, and it
 * is unambiguous: a model that thought about the task and declined still bills
 * for the prompt. So this maps to MODEL_UNAVAILABLE, which already means "do
 * not retry, fall back now".
 */
export class ModelSilentError extends Error {
	override readonly name = "ModelSilentError";
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
	}
}

/** A bug in this codebase. Never retried, never fallen back from. */
export class ProgrammerError extends Error {
	override readonly name = "ProgrammerError";
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
	}
}

/* -------------------------------------------------------------------------- */
/* Sanitization                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Recursively strip anything that looks like a credential. Applied to every
 * value that reaches errorMeta, so a provider SDK error carrying request
 * headers can never leak an Authorization bearer token into run artifacts.
 *
 * The matching rules live in `runtime/redact.ts` and are shared with the
 * logger; this wrapper only adds the classifier's own limits.
 *
 * Note the asymmetry with classification: only the *persisted* copy is
 * scrubbed. `classifyError` reads the original error, so redacting a message
 * like "invalid api key sk-live-..." cannot change which FailureClass it maps
 * to.
 */
export function sanitizeValue(value: unknown, depth = 0): unknown {
	return redactValue(
		value,
		{ truncate: MAX_MESSAGE_LENGTH, maxArray: MAX_SANITIZE_ARRAY, maxDepth: MAX_SANITIZE_DEPTH },
		depth,
	);
}

/** Scrub, then truncate: a secret must not survive by sitting past the cut. */
function truncate(s: string): string {
	const safe = scrubSecrets(s);
	return safe.length > MAX_MESSAGE_LENGTH ? `${safe.slice(0, MAX_MESSAGE_LENGTH)}…` : safe;
}

/* -------------------------------------------------------------------------- */
/* Classification                                                             */
/* -------------------------------------------------------------------------- */

function asRecord(err: unknown): Record<string, unknown> | undefined {
	return typeof err === "object" && err !== null ? (err as Record<string, unknown>) : undefined;
}

function numberProp(rec: Record<string, unknown> | undefined, ...names: string[]): number | undefined {
	if (!rec) return undefined;
	for (const n of names) {
		const v = rec[n];
		if (typeof v === "number" && Number.isFinite(v)) return v;
		if (typeof v === "string" && /^\d{3}$/.test(v)) return Number(v);
	}
	return undefined;
}

function stringProp(rec: Record<string, unknown> | undefined, name: string): string | undefined {
	const v = rec?.[name];
	return typeof v === "string" ? v : undefined;
}

function messageOf(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	const m = stringProp(asRecord(err), "message");
	return m ?? "";
}

/** Flatten the cause chain, outermost first, with a cycle/length guard. */
function causeChain(err: unknown): unknown[] {
	const chain: unknown[] = [];
	const seen = new Set<unknown>();
	let cur: unknown = err;
	while (cur !== undefined && cur !== null && chain.length < 8) {
		if (typeof cur === "object" && seen.has(cur)) break;
		if (typeof cur === "object") seen.add(cur);
		chain.push(cur);
		cur = asRecord(cur)?.["cause"];
	}
	return chain;
}

/** Message mentions running out of money/allowance rather than going too fast. */
function looksLikeQuota(message: string): boolean {
	return /quota|credit|billing|insufficient|exceeded your current/i.test(message);
}

function classifyStatus(status: number, message: string): FailureClass | undefined {
	if (status === 401 || status === 403) return "AUTH";
	if (status === 402) return "BILLING";
	if (status === 429) return looksLikeQuota(message) ? "QUOTA" : "RATE_LIMIT";
	if (status === 404) return "MODEL_UNAVAILABLE";
	if (status === 408 || status === 504) return "TIMEOUT";
	if (status >= 500 && status <= 599) return "SERVER_ERROR";
	return undefined;
}

function classifyCode(code: string): FailureClass | undefined {
	switch (code) {
		case "ENOTFOUND":
		case "ECONNREFUSED":
		case "ECONNRESET":
		case "EAI_AGAIN":
		case "EPIPE":
		case "EHOSTUNREACH":
		case "ENETUNREACH":
			return "NETWORK";
		case "UND_ERR_SOCKET":
		case "ECONNABORTED":
			return "NETWORK";
		case "ETIMEDOUT":
		case "ESOCKETTIMEDOUT":
		case "UND_ERR_HEADERS_TIMEOUT":
		case "UND_ERR_BODY_TIMEOUT":
		case "UND_ERR_CONNECT_TIMEOUT":
			return "TIMEOUT";
		case "ABORT_ERR":
			return "USER_ABORT";
		default:
			return undefined;
	}
}

function classifyName(name: string): FailureClass | undefined {
	switch (name) {
		case "InvalidAgentOutputError":
			return "INVALID_AGENT_OUTPUT";
		case "ToolLoopError":
			return "TOOL_LOOP";
		case "ModelSilentError":
			return "MODEL_UNAVAILABLE";
		case "ProgrammerError":
			return "PROGRAMMER_ERROR";
		case "AbortError":
			return "USER_ABORT";
		case "TypeError":
		case "ReferenceError":
		case "SyntaxError":
		case "RangeError":
			return "PROGRAMMER_ERROR";
		case "TimeoutError":
			return "TIMEOUT";
		default:
			return undefined;
	}
}

/** An abort/timeout distinction: only the message says which one happened. */
function looksLikeTimeout(message: string): boolean {
	return /timed? ?out|timeout/i.test(message);
}

/**
 * undici (Node's fetch) reports ordinary transport failures as
 * `TypeError: fetch failed` and hangs the real reason off `cause`. Taking that
 * built-in name at face value would classify a socket reset as our own bug and
 * kill the run without ever touching the fallback chain, so a built-in error
 * that carries a cause — or undici's marker message — declines to answer and
 * lets the link below it in the chain speak instead. A genuine programmer
 * TypeError/ReferenceError has neither a cause nor that message, so it still
 * fails fast.
 */
function isTransportWrapper(rec: Record<string, unknown> | undefined, message: string): boolean {
	const cause = rec?.["cause"];
	return (cause !== undefined && cause !== null) || /fetch failed/i.test(message);
}

const BUILTIN_BUG_NAMES = new Set(["TypeError", "ReferenceError", "SyntaxError", "RangeError"]);

function classifyMessage(message: string): FailureClass | undefined {
	if (!message) return undefined;
	if (/context length|too many tokens|maximum context|context window/i.test(message)) {
		return "CONTEXT_OVERFLOW";
	}
	if (/rate limit|too many requests/i.test(message)) {
		// "rate limit exceeded, you are out of credits" is really a quota problem.
		return looksLikeQuota(message) ? "QUOTA" : "RATE_LIMIT";
	}
	if (/\bbilling\b|payment required|add a payment method/i.test(message)) return "BILLING";
	if (/quota|credit|insufficient|exceeded your current/i.test(message)) return "QUOTA";
	if (/model not found|unsupported model|unknown model|no such model/i.test(message)) {
		return "MODEL_UNAVAILABLE";
	}
	if (/unauthorized|invalid api key|authentication failed|forbidden/i.test(message)) return "AUTH";
	// Only an explicit statement that somebody cancelled counts. Providers say
	// "request aborted" for their own transport hiccups, and treating that as a
	// user decision would fail the run instead of falling back.
	if (/\b(?:user|caller) (?:has )?(?:aborted|cancell?ed)\b|\b(?:aborted|cancell?ed) by (?:the )?(?:user|caller)\b/i.test(message)) {
		return "USER_ABORT";
	}
	if (/timed? ?out|timeout/i.test(message)) return "TIMEOUT";
	// "fetch failed" is undici's own wording for any failed transport.
	if (/socket hang up|network|dns|connection refused|connection reset|fetch failed|aborted/i.test(message)) {
		return "NETWORK";
	}
	return undefined;
}

/** Structural signals on a single link of the cause chain. */
function classifyStructural(err: unknown): FailureClass | undefined {
	if (err instanceof InvalidAgentOutputError) return "INVALID_AGENT_OUTPUT";
	if (err instanceof ToolLoopError) return "TOOL_LOOP";
	if (err instanceof ModelSilentError) return "MODEL_UNAVAILABLE";
	if (err instanceof ProgrammerError) return "PROGRAMMER_ERROR";

	const rec = asRecord(err);
	const message = messageOf(err);

	const status = numberProp(rec, "status", "statusCode", "httpStatus") ?? numberProp(asRecord(rec?.["response"]), "status", "statusCode");
	if (status !== undefined) {
		const byStatus = classifyStatus(status, message);
		if (byStatus) return byStatus;
	}

	const code = stringProp(rec, "code");
	if (code) {
		const byCode = classifyCode(code);
		// A deadline the runtime enforced for us aborts the same way a user does.
		if (byCode === "USER_ABORT" && looksLikeTimeout(message)) return "TIMEOUT";
		if (byCode) return byCode;
	}

	const name = err instanceof Error ? err.name : stringProp(rec, "name");
	if (name) {
		if (BUILTIN_BUG_NAMES.has(name) && isTransportWrapper(rec, message)) return undefined;
		const byName = classifyName(name);
		if (byName === "USER_ABORT" && looksLikeTimeout(message)) return "TIMEOUT";
		if (byName) return byName;
	}
	return undefined;
}

function buildErrorMeta(err: unknown): Record<string, unknown> {
	const chain = causeChain(err);
	const head = chain[0];
	const rec = asRecord(head);
	const meta: Record<string, unknown> = {};

	const name = head instanceof Error ? head.name : stringProp(rec, "name");
	if (name) meta["name"] = name;

	const status = numberProp(rec, "status", "statusCode", "httpStatus") ?? numberProp(asRecord(rec?.["response"]), "status", "statusCode");
	if (status !== undefined) meta["status"] = status;

	const code = stringProp(rec, "code");
	if (code) meta["code"] = code;

	const message = messageOf(head);
	if (message) meta["message"] = truncate(message);

	if (chain.length > 1) {
		meta["causeChain"] = chain.slice(1).map((c) => {
			const cr = asRecord(c);
			return {
				name: (c instanceof Error ? c.name : stringProp(cr, "name")) ?? typeof c,
				message: truncate(messageOf(c)),
			};
		});
	}

	// Whitelist above already excludes headers/auth payloads; sanitize is the
	// belt-and-braces pass so a hostile `name`/`code` cannot smuggle anything.
	return sanitizeValue(meta) as Record<string, unknown>;
}

/**
 * Map an arbitrary thrown value onto a {@link FailureClass} plus sanitized
 * metadata safe to persist in run artifacts.
 */
export function classifyError(err: unknown): { failureClass: FailureClass; errorMeta: Record<string, unknown> } {
	const errorMeta = buildErrorMeta(err);
	const chain = causeChain(err);

	// Pass 1: structural signals, outermost cause first.
	for (const link of chain) {
		const c = classifyStructural(link);
		if (c) return { failureClass: c, errorMeta };
	}
	// Pass 2: message heuristics, same order.
	for (const link of chain) {
		const c = classifyMessage(messageOf(link));
		if (c) return { failureClass: c, errorMeta };
	}
	return { failureClass: "UNKNOWN", errorMeta };
}
