/**
 * The single place where "what does a credential look like" is written down.
 *
 * Both the error classifier (which persists error metadata into run artifacts)
 * and the logger (which writes every log field to stderr and to `events.jsonl`)
 * redact through here. They used to carry a near-identical regex each, which is
 * the classic way a key gets added to one copy and not the other.
 *
 * Two layers, because a credential reaches a record two different ways:
 *
 *  - by key: `{ authorization: "Bearer ..." }` — the field name gives it away.
 *  - by value: `"401: invalid key sk-live-abc..."` — a provider pasted the
 *    credential into a human-readable message, and no field name marks it.
 *
 * The value layer is why this is not just a key filter. Truncating such a
 * message, which is all the classifier used to do, keeps the secret.
 */

export const REDACTED = "[REDACTED]";

/**
 * Field names whose value never leaves this process, whatever it contains.
 *
 * Matched per name segment rather than as a bare substring. A substring match
 * reads as the safer choice and is not: `auth` matches `author`, `key` matches
 * `monkey` and `keyword`, `pass` matches `passed` and `bypass`. Redacting those
 * costs an operator the diagnostic fields they need to read a failed run, in a
 * system whose whole premise is being trustworthy without being checked. The
 * value layer below is what catches a credential this list does not name.
 */
const SECRET_SEGMENTS = new Set([
	"token",
	"tokens",
	"key",
	"keys",
	"apikey",
	"secret",
	"secrets",
	"auth",
	"authorization",
	"credential",
	"credentials",
	"cookie",
	"cookies",
	"bearer",
	"pass",
	"password",
	"passwd",
	"passphrase",
	"pwd",
	"jwt",
	"signature",
	"sig",
	"session",
	"sid",
	"nonce",
	/*
	 * `dsn` is deliberately absent: the URL-userinfo pattern in the value layer
	 * already removes the password from `postgres://user:pw@host/db` while
	 * keeping the host, which is the half an operator needs to see.
	 */
]);

/** Split `X-Auth-Token`, `api_key`, `accessToken` alike into lowercase parts. */
function keySegments(key: string): string[] {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.flatMap((part) => part.split(" "))
		.map((part) => part.toLowerCase())
		.filter((part) => part.length > 0);
}

/**
 * Names that contain a secret word but never carry a credential here. They are
 * the fields an operator reads first when a run fails: `sourceKey` says which
 * collector broke. Redacting them protects nothing and teaches the reader that
 * [REDACTED] is noise, which is what makes the next real one easy to ignore.
 */
const NEVER_SECRET = new Set([
	"sourcekey",
	"sourcekeys",
	"enabledsourcekeys",
	"eventkey",
	"eventkeys",
	"datekey",
	"sortkey",
	"cachekey",
	"configkeys",
	"idempotencykey",
	"partitionkey",
]);

/**
 * Whether this field's value must never be serialised.
 *
 * Takes the value as well as the name, because a boolean or a number cannot be
 * a credential: `hasSecret: false` is the answer to "was the key configured at
 * all", and redacting it hides the diagnostic while protecting nothing. A
 * string credential that no name marks is the value layer's job, not this one.
 */
export function isSecretKey(key: string, value?: unknown): boolean {
	if (typeof value === "boolean" || typeof value === "number") return false;
	if (NEVER_SECRET.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""))) return false;
	return keySegments(key).some((segment) => SECRET_SEGMENTS.has(segment));
}

/**
 * Credential-shaped substrings, for values that no field name marks as secret.
 * Each pattern keeps enough surrounding text that the message still reads —
 * "Bearer [REDACTED]" is a more useful log line than "[REDACTED]".
 */
const VALUE_PATTERNS: Array<[RegExp, string]> = [
	// URL userinfo: https://user:pass@host -> https://[REDACTED]@host
	[/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${REDACTED}@`],
	/*
	 * Query and form parameters whose NAME marks the value. This is the shape
	 * this project's own collectors actually emit: FRED, YouTube and CoinGecko
	 * all key their requests in the query string, so any 4xx that quotes the
	 * request URL carries a live key into the error message.
	 */
	[
		/([?&#][^=&\s]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|signature|password|apikey|sig)[^=&\s]*=)[^&\s#]+/gi,
		`$1${REDACTED}`,
	],
	[/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
	[/\bBasic\s+[A-Za-z0-9+/=]{16,}/gi, `Basic ${REDACTED}`],
	[/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED],
	[/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/g, REDACTED],
	[/\bgithub_pat_[A-Za-z0-9_]{8,}/g, REDACTED],
	[/\bxox[abpsre]-[A-Za-z0-9-]{8,}/g, REDACTED],
	[/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
	// Google API keys, as used by the YouTube collector.
	[/\bAIza[A-Za-z0-9_-]{16,}/g, REDACTED],
	// A bare JWT, which is not always introduced by "Bearer".
	[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
	[/\b(?:glpat|npm|xapp|tvly|sk_live|pk_live)[-_][A-Za-z0-9_-]{8,}/g, REDACTED],
];

/** Strip credential-shaped substrings out of one string value. */
export function scrubSecrets(value: string): string {
	let out = value;
	for (const [pattern, replacement] of VALUE_PATTERNS) {
		out = out.replace(pattern, replacement);
	}
	return out;
}

export interface RedactOptions {
	/** Cap string length at this many characters, appending an ellipsis. */
	truncate?: number;
	/** Keep at most this many array elements. */
	maxArray?: number;
	/** Stop descending at this depth, dropping anything deeper. */
	maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 4;

function truncateTo(s: string, max: number | undefined): string {
	if (max === undefined || s.length <= max) return s;
	return `${s.slice(0, max)}…`;
}

/**
 * Recursively redact a value: secret-looking keys become {@link REDACTED}, and
 * every surviving string is scrubbed of credential-shaped substrings.
 *
 * Returns `undefined` for values that must not be serialised at all (functions,
 * symbols, anything past `maxDepth`); callers drop those keys.
 */
export function redactValue(value: unknown, options: RedactOptions = {}, depth = 0): unknown {
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
	if (value === null || value === undefined) return value;
	const t = typeof value;
	if (t === "string") return truncateTo(scrubSecrets(value as string), options.truncate);
	if (t === "number" || t === "boolean") return value;
	if (t === "bigint") return (value as bigint).toString();
	if (t === "function" || t === "symbol") return undefined;
	/*
	 * A Buffer enumerates as a map of byte indices, so neither layer below would
	 * ever see the credential it holds — it would serialise as plain numbers and
	 * decode trivially. Nothing puts one here today; this keeps it that way.
	 */
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return REDACTED;
	if (depth >= maxDepth) return undefined;
	if (Array.isArray(value)) {
		const items = options.maxArray === undefined ? value : value.slice(0, options.maxArray);
		return items.map((v) => redactValue(v, options, depth + 1));
	}
	if (value instanceof Error) {
		return {
			name: value.name,
			message: truncateTo(scrubSecrets(value.message), options.truncate),
		};
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (isSecretKey(k, v)) {
			out[k] = REDACTED;
			continue;
		}
		const r = redactValue(v, options, depth + 1);
		if (r !== undefined) out[k] = r;
	}
	return out;
}
