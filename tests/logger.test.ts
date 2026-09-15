import { describe, expect, it } from "vitest";
import { createLogger, redact, type LogRecord } from "../src/runtime/logger.ts";

function capture() {
	const lines: string[] = [];
	const sunk: LogRecord[] = [];
	const logger = createLogger("curator", {
		write: (line) => lines.push(line),
		sink: (record) => sunk.push(record),
		now: () => new Date("2026-09-13T12:00:00.000Z"),
	});
	return { lines, sunk, logger };
}

describe("createLogger", () => {
	it("writes one JSON object per line", () => {
		const { lines, logger } = capture();
		logger.info("stage started", { stage: "CURATOR", items: 12 });

		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("\n");
		expect(JSON.parse(lines[0] as string)).toEqual({
			ts: "2026-09-13T12:00:00.000Z",
			level: "info",
			scope: "curator",
			msg: "stage started",
			stage: "CURATOR",
			items: 12,
		});
	});

	it("emits the right level for each method", () => {
		const { lines, logger } = capture();
		logger.info("a");
		logger.warn("b");
		logger.error("c");
		expect(lines.map((l) => JSON.parse(l).level)).toEqual(["info", "warn", "error"]);
	});

	it("mirrors records into the sink", () => {
		const { sunk, logger } = capture();
		logger.warn("falling back", { failureClass: "QUOTA" });
		expect(sunk).toHaveLength(1);
		expect(sunk[0]).toMatchObject({ level: "warn", msg: "falling back", failureClass: "QUOTA" });
	});

	it("never lets a field overwrite ts/level/scope/msg", () => {
		const { lines, logger } = capture();
		logger.info("real message", { msg: "spoofed", level: "error", scope: "evil" });
		expect(JSON.parse(lines[0] as string)).toMatchObject({
			msg: "real message",
			level: "info",
			scope: "curator",
		});
	});

	it("namespaces child loggers", () => {
		const { lines, logger } = capture();
		logger.child("fallback").info("x");
		expect(JSON.parse(lines[0] as string).scope).toBe("curator.fallback");
	});
});

describe("redaction", () => {
	it("redacts credential-shaped keys at every depth", () => {
		const { lines, logger } = capture();
		logger.error("auth failed", {
			apiKey: "sk-live-SECRET",
			request: {
				headers: { authorization: "Bearer LEAKED", cookie: "sid=LEAKED" },
				body: { access_token: "LEAKED", model: "gemini-3.8-flash" },
			},
			password: "hunter2",
		});

		const line = lines[0] as string;
		expect(line).not.toContain("SECRET");
		expect(line).not.toContain("LEAKED");
		expect(line).not.toContain("hunter2");
		expect(line).toContain("gemini-3.8-flash");

		const parsed = JSON.parse(line);
		expect(parsed.apiKey).toBe("[REDACTED]");
		expect(parsed.request.headers.authorization).toBe("[REDACTED]");
		expect(parsed.request.body.access_token).toBe("[REDACTED]");
		expect(parsed.request.body.model).toBe("gemini-3.8-flash");
	});

	it("redacts inside arrays", () => {
		expect(redact([{ secret: "s" }, { ok: 1 }])).toEqual([{ secret: "[REDACTED]" }, { ok: 1 }]);
	});

	it("reduces an Error to name and message", () => {
		expect(redact(new TypeError("bad"))).toEqual({ name: "TypeError", message: "bad" });
	});

	it("produces serializable output for a logged error", () => {
		const { lines, logger } = capture();
		logger.error("boom", { err: new Error("kaboom") });
		expect(JSON.parse(lines[0] as string).err).toEqual({ name: "Error", message: "kaboom" });
	});
});

describe("redact: credential-shaped values, not just keys", () => {
	it("redacts the newer secret key names the old regex missed", () => {
		expect(
			redact({
				auth: "a",
				credential: "b",
				credentials: "c",
				passphrase: "d",
				pwd: "e",
				jwt: "f",
				signature: "g",
				keep: 1,
			}),
		).toEqual({
			auth: "[REDACTED]",
			credential: "[REDACTED]",
			credentials: "[REDACTED]",
			passphrase: "[REDACTED]",
			pwd: "[REDACTED]",
			jwt: "[REDACTED]",
			signature: "[REDACTED]",
			keep: 1,
		});
	});

	it("scrubs a credential pasted into a string value under an innocent key", () => {
		// The field name gives nothing away, so only the value layer can catch it.
		expect(redact({ detail: "401 from provider: invalid key sk-live-ABCDEF123456" })).toEqual({
			detail: "401 from provider: invalid key [REDACTED]",
		});
	});

	it("scrubs bearer tokens, forge tokens and AWS access key ids", () => {
		expect(redact({ note: "sent Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc" })).toEqual({
			note: "sent Authorization: Bearer [REDACTED]",
		});
		expect(redact({ note: "token ghp_AbCdEf0123456789 rejected" })).toEqual({
			note: "token [REDACTED] rejected",
		});
		expect(redact({ note: "github_pat_11ABCDEFG0abcdefg expired" })).toEqual({
			note: "[REDACTED] expired",
		});
		expect(redact({ note: "xoxb-1234567890-abcdef failed" })).toEqual({
			note: "[REDACTED] failed",
		});
		expect(redact({ note: "AKIAIOSFODNN7EXAMPLE denied" })).toEqual({
			note: "[REDACTED] denied",
		});
	});

	it("strips the userinfo out of a connection URL but keeps the host", () => {
		expect(redact({ dsn: "postgres://di:hunter2@10.10.10.10:5432/signalforge" })).toEqual({
			dsn: "postgres://[REDACTED]@10.10.10.10:5432/signalforge",
		});
	});

	it("scrubs strings nested in arrays and errors too", () => {
		expect(redact(["plain", "key sk-live-ABCDEF123456"])).toEqual(["plain", "key [REDACTED]"]);
		expect(redact(new Error("bad Bearer eyJhbGciOiJIUzI1NiJ9.abc"))).toEqual({
			name: "Error",
			message: "bad Bearer [REDACTED]",
		});
	});

	it("leaves ordinary prose alone", () => {
		const message = "curator made no progress across 3 turns at 12/40 items decided";
		expect(redact({ msg: message })).toEqual({ msg: message });
	});
});
