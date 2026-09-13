import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import type { AgentAttempt, RunState, RunStatus } from "../schemas/run.ts";
import { readJson, readJsonIfExists, writeJsonAtomic } from "./atomic-json.ts";

export const RUN_STATE_FILE = "run-state.json";
export const ATTEMPTS_FILE = "attempts.json";
export const EVENTS_FILE = "events.jsonl";

/**
 * The fixture/offline run lifecycle. Anything not listed here is a bug in the
 * caller, not a recoverable condition — a run that reaches WRITING without
 * MATERIALS_READY would silently produce a brief from stale materials.
 *
 * This is deliberately NOT the production pipeline's state machine (that one
 * lives in `src/pipeline/daily-run.ts` and is keyed by `PipelineState`). The two
 * differ on purpose: the fixture runner retries a stage in place on the next
 * model in the chain (CURATING -> CURATING), treats a stage failure as terminal
 * for the run, and finishes at COMPLETED; the production pipeline forbids the
 * self-loops, offers failure -> retry edges, and finishes at PUBLISHED.
 *
 * The `Record<RunStatus, ...>` is exhaustive on purpose: widening `RunStatus`
 * must break this build so the new state gets an explicit decision here.
 */
const LEGAL_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = Object.freeze({
	CREATED: ["CURATING"],
	// Collection is a production-pipeline concern; the fixture runner starts
	// from committed fixtures and never collects. No state below targets these,
	// so they are unreachable here rather than merely terminal.
	COLLECTING: [],
	COLLECTED: [],
	COLLECTION_FAILED: [],
	// The fixture runner finishes at COMPLETED; PUBLISHED means "pushed to the
	// live site", which an offline run must never claim.
	PUBLISHED: [],
	// Self-transition is a retry of the same stage on another model.
	CURATING: ["CURATING", "MATERIALS_READY", "CURATION_FAILED"],
	MATERIALS_READY: ["WRITING"],
	WRITING: ["WRITING", "DRAFT_READY", "EDITOR_FAILED"],
	DRAFT_READY: ["VALIDATING"],
	VALIDATING: ["COMPLETED", "VALIDATION_FAILED"],
	COMPLETED: [],
	CURATION_FAILED: [],
	EDITOR_FAILED: [],
	VALIDATION_FAILED: [],
});

export function isLegalTransition(from: RunStatus, to: RunStatus): boolean {
	return LEGAL_TRANSITIONS[from].includes(to);
}

/** `<date>-<8 hex>`, e.g. `2026-09-13-3f9a1c04`. */
export function generateRunId(date: string): string {
	return `${date}-${randomBytes(4).toString("hex")}`;
}

export type RunEvent = {
	ts: string;
	kind: string;
	[field: string]: unknown;
};

export class RunStateStore {
	readonly runId: string;
	readonly date: string;
	readonly dir: string;
	readonly #now: () => Date;

	private constructor(dir: string, runId: string, date: string, now: () => Date) {
		this.dir = dir;
		this.runId = runId;
		this.date = date;
		this.#now = now;
	}

	/** Create the run directory and its initial CREATED state. */
	static create(opts: { root: string; date: string; runId?: string; now?: () => Date }): RunStateStore {
		const now = opts.now ?? (() => new Date());
		const runId = opts.runId ?? generateRunId(opts.date);
		const dir = resolve(opts.root, opts.date, runId);
		mkdirSync(dir, { recursive: true });
		const store = new RunStateStore(dir, runId, opts.date, now);
		const ts = now().toISOString();
		store.save({
			runId,
			date: opts.date,
			status: "CREATED",
			createdAt: ts,
			updatedAt: ts,
			totalItems: 0,
			processedItems: 0,
			storyCount: 0,
		});
		return store;
	}

	/** Reopen an existing run directory. */
	static open(opts: { root: string; date: string; runId: string; now?: () => Date }): RunStateStore {
		const dir = resolve(opts.root, opts.date, opts.runId);
		if (!existsSync(join(dir, RUN_STATE_FILE))) {
			throw new Error(`No run state at ${dir}`);
		}
		return new RunStateStore(dir, opts.runId, opts.date, opts.now ?? (() => new Date()));
	}

	/** Absolute path to a named artifact inside this run's directory. */
	pathFor(name: string): string {
		return join(this.dir, name);
	}

	load(): RunState {
		return readJson<RunState>(this.pathFor(RUN_STATE_FILE));
	}

	save(state: RunState): void {
		writeJsonAtomic(this.pathFor(RUN_STATE_FILE), state);
	}

	/** Apply a patch to the persisted state, refreshing `updatedAt`. */
	patch(fields: Partial<Omit<RunState, "runId" | "date" | "createdAt">>): RunState {
		const next: RunState = { ...this.load(), ...fields, updatedAt: this.#now().toISOString() };
		this.save(next);
		return next;
	}

	/** Move to `next`, rejecting any transition the lifecycle does not allow. */
	transition(next: RunStatus): RunState {
		const current = this.load();
		if (!isLegalTransition(current.status, next)) {
			throw new Error(`Illegal run transition: ${current.status} -> ${next} (run ${this.runId})`);
		}
		const updated: RunState = { ...current, status: next, updatedAt: this.#now().toISOString() };
		this.save(updated);
		this.appendEvent({ kind: "run.transition", from: current.status, to: next });
		return updated;
	}

	readAttempts(): AgentAttempt[] {
		return readJsonIfExists<AgentAttempt[]>(this.pathFor(ATTEMPTS_FILE)) ?? [];
	}

	appendAttempt(attempt: AgentAttempt): void {
		const all = this.readAttempts();
		all.push(attempt);
		writeJsonAtomic(this.pathFor(ATTEMPTS_FILE), all);
	}

	/**
	 * Append-only audit log, one JSON object per line. Written with O_APPEND +
	 * fsync rather than atomically replaced, so a crash truncates at most the
	 * final line instead of losing the history.
	 */
	appendEvent(event: { kind: string; ts?: string; [field: string]: unknown }): RunEvent {
		const record: RunEvent = { ts: event.ts ?? this.#now().toISOString(), ...event, kind: event.kind };
		const path = this.pathFor(EVENTS_FILE);
		mkdirSync(this.dir, { recursive: true });
		appendFileSync(path, `${JSON.stringify(record)}\n`);
		const fd = openSync(path, "r+");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		return record;
	}

	readEvents(): RunEvent[] {
		const path = this.pathFor(EVENTS_FILE);
		if (!existsSync(path)) return [];
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as RunEvent);
	}
}
