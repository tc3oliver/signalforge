/**
 * Structured logging. stdout belongs to the CLI's own output, so every log line
 * goes to stderr as a single JSON object; an optional sink lets a run mirror the
 * same records into its `events.jsonl`.
 */

import { redactValue, scrubSecrets } from "./redact.ts";

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
 *
 * The rules are shared with the error classifier (`runtime/redact.ts`) so a key
 * added for one is never missing from the other. Log records are not truncated:
 * a log line is diagnostic and losing its tail costs more than it saves.
 */
export function redact(value: unknown, depth = 0): unknown {
	return redactValue(value, { maxDepth: MAX_DEPTH }, depth);
}

export function createLogger(scope: string, options: LoggerOptions = {}): Logger {
	const now = options.now ?? (() => new Date());
	const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));

	function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
		const safeFields = (fields ? redact(fields) : {}) as Record<string, unknown>;
		// `msg` is spread in after the redacted fields, so it would otherwise reach
		// stderr and events.jsonl verbatim. Every call site passes a constant
		// today; this is what stops the first interpolated URL from leaking.
		const record: LogRecord = {
			...safeFields,
			ts: now().toISOString(),
			level,
			scope,
			msg: scrubSecrets(msg),
		};
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
