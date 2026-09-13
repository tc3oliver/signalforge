/**
 * Structured logging. stdout belongs to the CLI's own output, so every log line
 * goes to stderr as a single JSON object; an optional sink lets a run mirror the
 * same records into its `events.jsonl`.
 */

const SECRET_KEY_RE = /token|key|secret|authorization|cookie|bearer|password/i;
const REDACTED = "[REDACTED]";
const MAX_DEPTH = 4;

export type LogLevel = "info" | "warn" | "error";

export type LogRecord = {
	ts: string;
	level: LogLevel;
	scope: string;
	msg: string;
	[field: string]: unknown;
};

export type LogSink = (record: LogRecord) => void;

export type Logger = {
	scope: string;
	info: (msg: string, fields?: Record<string, unknown>) => void;
	warn: (msg: string, fields?: Record<string, unknown>) => void;
	error: (msg: string, fields?: Record<string, unknown>) => void;
	child: (subScope: string) => Logger;
};

export type LoggerOptions = {
	/** Mirror every record somewhere else (e.g. the run's events.jsonl). */
	sink?: LogSink;
	/** Override the stderr writer; used by tests. */
	write?: (line: string) => void;
	now?: () => Date;
};

/**
 * Recursively redact credential-shaped fields. Log fields are frequently built
 * by spreading a provider response, so this runs on every value, not just the
 * top level.
 */
export function redact(value: unknown, depth = 0): unknown {
	if (value === null || value === undefined) return value;
	const t = typeof value;
	if (t === "string" || t === "number" || t === "boolean") return value;
	if (t === "bigint") return (value as bigint).toString();
	if (t === "function" || t === "symbol") return undefined;
	if (depth >= MAX_DEPTH) return undefined;
	if (value instanceof Error) return { name: value.name, message: value.message };
	if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (SECRET_KEY_RE.test(k)) {
			out[k] = REDACTED;
			continue;
		}
		const r = redact(v, depth + 1);
		if (r !== undefined) out[k] = r;
	}
	return out;
}

export function createLogger(scope: string, options: LoggerOptions = {}): Logger {
	const now = options.now ?? (() => new Date());
	const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));

	function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
		const safeFields = (fields ? redact(fields) : {}) as Record<string, unknown>;
		const record: LogRecord = { ...safeFields, ts: now().toISOString(), level, scope, msg };
		write(JSON.stringify(record));
		options.sink?.(record);
	}

	return {
		scope,
		info: (msg, fields) => emit("info", msg, fields),
		warn: (msg, fields) => emit("warn", msg, fields),
		error: (msg, fields) => emit("error", msg, fields),
		child: (subScope) => createLogger(`${scope}.${subScope}`, options),
	};
}
