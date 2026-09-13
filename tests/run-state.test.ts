import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentAttempt, RunStatus } from "../src/schemas/run.ts";
import { RunState as RunStateSchema } from "../src/schemas/run.ts";
import { RunStateStore, generateRunId, isLegalTransition } from "../src/runtime/run-state.ts";

const DATE = "2026-09-13";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "di-run-state-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function newStore(): RunStateStore {
	return RunStateStore.create({ root: join(root, "runs"), date: DATE });
}

function attempt(overrides: Partial<AgentAttempt> = {}): AgentAttempt {
	return {
		attemptId: "a1",
		stage: "CURATOR",
		provider: "github-copilot",
		model: "gemini-3.8-flash",
		startedAt: "2026-09-13T12:00:00.000Z",
		finishedAt: "2026-09-13T12:00:01.000Z",
		durationMs: 1000,
		status: "SUCCESS",
		...overrides,
	};
}

describe("generateRunId", () => {
	it("is <date>-<8 hex>", () => {
		const id = generateRunId(DATE);
		expect(id).toMatch(/^2026-09-13-[0-9a-f]{8}$/);
	});

	it("is unique across calls", () => {
		const ids = new Set(Array.from({ length: 200 }, () => generateRunId(DATE)));
		expect(ids.size).toBe(200);
	});
});

describe("RunStateStore.create", () => {
	it("creates runs/<date>/<run-id>/ and a CREATED state", () => {
		const store = newStore();
		expect(store.dir).toContain(join("runs", DATE, store.runId));
		const state = store.load();
		expect(state.status).toBe("CREATED");
		expect(state.runId).toBe(store.runId);
		expect(state.date).toBe(DATE);
		expect(() => RunStateSchema.parse(state)).not.toThrow();
	});

	it("pathFor returns an absolute path inside the run dir", () => {
		const store = newStore();
		const p = store.pathFor("materials.json");
		expect(p.startsWith("/")).toBe(true);
		expect(p).toBe(join(store.dir, "materials.json"));
	});

	it("open reopens an existing run and rejects a missing one", () => {
		const store = newStore();
		const reopened = RunStateStore.open({ root: join(root, "runs"), date: DATE, runId: store.runId });
		expect(reopened.load().status).toBe("CREATED");
		expect(() => RunStateStore.open({ root: join(root, "runs"), date: DATE, runId: "nope" })).toThrow();
	});
});

describe("transition — legal paths", () => {
	it("walks the full happy path", () => {
		const store = newStore();
		const path: RunStatus[] = ["CURATING", "MATERIALS_READY", "WRITING", "DRAFT_READY", "VALIDATING", "COMPLETED"];
		for (const next of path) {
			expect(store.transition(next).status).toBe(next);
		}
		expect(store.load().status).toBe("COMPLETED");
	});

	it("allows CURATING -> CURATING and WRITING -> WRITING as retries", () => {
		const store = newStore();
		store.transition("CURATING");
		expect(store.transition("CURATING").status).toBe("CURATING");
		store.transition("MATERIALS_READY");
		store.transition("WRITING");
		expect(store.transition("WRITING").status).toBe("WRITING");
	});

	it.each([
		["CURATING", "CURATION_FAILED"],
		["WRITING", "EDITOR_FAILED"],
		["VALIDATING", "VALIDATION_FAILED"],
	] as Array<[RunStatus, RunStatus]>)("allows %s -> %s", (from, to) => {
		expect(isLegalTransition(from, to)).toBe(true);
	});

	it("bumps updatedAt but keeps createdAt", () => {
		const store = newStore();
		const before = store.load();
		const after = store.transition("CURATING");
		expect(after.createdAt).toBe(before.createdAt);
		expect(Date.parse(after.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before.updatedAt));
	});
});

describe("transition — illegal paths throw", () => {
	it.each([
		["CREATED", "WRITING"],
		["CREATED", "COMPLETED"],
		["CURATING", "WRITING"],
		["MATERIALS_READY", "MATERIALS_READY"],
		["MATERIALS_READY", "COMPLETED"],
		["DRAFT_READY", "COMPLETED"],
		["VALIDATING", "WRITING"],
	] as Array<[RunStatus, RunStatus]>)("rejects %s -> %s", (from, to) => {
		expect(isLegalTransition(from, to)).toBe(false);
	});

	it("throws and leaves the persisted state untouched", () => {
		const store = newStore();
		expect(() => store.transition("COMPLETED")).toThrow(/Illegal run transition: CREATED -> COMPLETED/);
		expect(store.load().status).toBe("CREATED");
	});

	it("rejects any transition out of a terminal status", () => {
		const store = newStore();
		store.transition("CURATING");
		store.transition("CURATION_FAILED");
		expect(() => store.transition("CURATING")).toThrow(/Illegal run transition/);
	});
});

describe("appendAttempt", () => {
	it("accumulates attempts in order", () => {
		const store = newStore();
		store.appendAttempt(attempt({ attemptId: "a1" }));
		store.appendAttempt(attempt({ attemptId: "a2", status: "FAILED", failureClass: "QUOTA" }));
		store.appendAttempt(attempt({ attemptId: "a3", stage: "EDITOR" }));

		const all = store.readAttempts();
		expect(all.map((a) => a.attemptId)).toEqual(["a1", "a2", "a3"]);
		expect(all[1]?.failureClass).toBe("QUOTA");
		expect(JSON.parse(readFileSync(store.pathFor("attempts.json"), "utf8"))).toHaveLength(3);
	});

	it("starts from an empty list", () => {
		expect(newStore().readAttempts()).toEqual([]);
	});
});

describe("events.jsonl", () => {
	it("appends one JSON object per line, in order", () => {
		const store = newStore();
		store.appendEvent({ kind: "run.started", runId: store.runId });
		store.appendEvent({ kind: "stage.started", stage: "CURATOR" });
		store.appendEvent({ kind: "stage.finished", stage: "CURATOR", storyCount: 7 });

		const raw = readFileSync(store.pathFor("events.jsonl"), "utf8");
		const lines = raw.split("\n").filter((l) => l.length > 0);
		expect(lines).toHaveLength(3);
		expect(raw.endsWith("\n")).toBe(true);
		for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();

		const events = store.readEvents();
		expect(events.map((e) => e.kind)).toEqual(["run.started", "stage.started", "stage.finished"]);
		expect(events[2]?.["storyCount"]).toBe(7);
		for (const e of events) expect(typeof e.ts).toBe("string");
	});

	it("records transitions as events, preserving order with manual events", () => {
		const store = newStore();
		store.appendEvent({ kind: "run.started" });
		store.transition("CURATING");
		store.appendEvent({ kind: "curator.item", index: 1 });
		store.transition("MATERIALS_READY");

		expect(store.readEvents().map((e) => e.kind)).toEqual([
			"run.started",
			"run.transition",
			"curator.item",
			"run.transition",
		]);
	});

	it("never rewrites earlier lines", () => {
		const store = newStore();
		store.appendEvent({ kind: "first" });
		const afterFirst = readFileSync(store.pathFor("events.jsonl"), "utf8");
		store.appendEvent({ kind: "second" });
		const afterSecond = readFileSync(store.pathFor("events.jsonl"), "utf8");
		expect(afterSecond.startsWith(afterFirst)).toBe(true);
	});
});

describe("atomic writes", () => {
	it("leaves no .tmp- file behind after state, attempt and event writes", () => {
		const store = newStore();
		store.transition("CURATING");
		store.patch({ totalItems: 42, processedItems: 7 });
		store.appendAttempt(attempt());
		store.appendAttempt(attempt({ attemptId: "a2" }));
		store.appendEvent({ kind: "tick" });

		const entries = readdirSync(store.dir);
		expect(entries.filter((f) => f.includes(".tmp-"))).toEqual([]);
		expect(entries.sort()).toEqual(["attempts.json", "events.jsonl", "run-state.json"]);
		expect(store.load()).toMatchObject({ totalItems: 42, processedItems: 7, status: "CURATING" });
	});
});
