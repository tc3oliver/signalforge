import type { AgentAttempt, RunState, Stage } from "../schemas/run.ts";
import { ISO, jsonParam, type Sql } from "./client.ts";

/** Re-running a stage must not create a second run row for the same runId. */
export async function upsertRun(
	sql: Sql,
	run: RunState,
	lineage = "default",
): Promise<void> {
	await sql.unsafe(
		`insert into daily_runs (run_id, lineage, date, status, total_items, processed_items,
			story_count, failure_reason, degraded_reason, created_at, updated_at)
		 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz)
		 on conflict (run_id) do update set
			status = excluded.status,
			total_items = excluded.total_items,
			processed_items = excluded.processed_items,
			story_count = excluded.story_count,
			failure_reason = excluded.failure_reason,
			degraded_reason = excluded.degraded_reason,
			updated_at = excluded.updated_at`,
		[
			run.runId, lineage, run.date, run.status, run.totalItems, run.processedItems,
			run.storyCount, run.failureReason ?? null, run.degradedReason ?? null,
			run.createdAt, run.updatedAt,
		],
	);
}

export async function getRun(sql: Sql, runId: string): Promise<RunState | undefined> {
	const rows = await sql.unsafe<
		{
			run_id: string; date: string; status: string; total_items: number;
			processed_items: number; story_count: number; failure_reason: string | null;
			degraded_reason: string | null;
			created_at: string; updated_at: string;
		}[]
	>(
		`select run_id, date, status, total_items, processed_items, story_count, failure_reason,
			degraded_reason,
			to_char(created_at at time zone 'utc', ${ISO}) as created_at,
			to_char(updated_at at time zone 'utc', ${ISO}) as updated_at
		 from daily_runs where run_id = $1`,
		[runId],
	);
	const r = rows[0];
	if (!r) return undefined;
	return {
		runId: r.run_id,
		date: r.date,
		status: r.status as RunState["status"],
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		totalItems: r.total_items,
		processedItems: r.processed_items,
		storyCount: r.story_count,
		...(r.failure_reason === null ? {} : { failureReason: r.failure_reason }),
		...(r.degraded_reason === null ? {} : { degradedReason: r.degraded_reason }),
	};
}

export async function listRunsForDate(
	sql: Sql,
	lineage: string,
	date: string,
): Promise<string[]> {
	const rows = await sql<{ run_id: string }[]>`
		select run_id from daily_runs where lineage = ${lineage} and date = ${date}
		order by created_at
	`;
	return rows.map((r) => r.run_id);
}

export async function startAgentRun(
	sql: Sql,
	runId: string,
	stage: Stage,
	startedAt: string,
): Promise<void> {
	await sql.unsafe(
		`insert into agent_runs (run_id, stage, status, started_at)
		 values ($1,$2,'RUNNING',$3::timestamptz)
		 on conflict (run_id, stage) do update set
			status = 'RUNNING', started_at = excluded.started_at,
			finished_at = null, duration_ms = null, updated_at = now()`,
		[runId, stage, startedAt],
	);
}

export async function finishAgentRun(
	sql: Sql,
	runId: string,
	stage: Stage,
	outcome: { status: "SUCCESS" | "FAILED"; finishedAt: string; durationMs: number; provider?: string; model?: string },
): Promise<void> {
	await sql.unsafe(
		`update agent_runs set status = $3, finished_at = $4::timestamptz, duration_ms = $5,
			provider = coalesce($6, provider), model = coalesce($7, model), updated_at = now()
		 where run_id = $1 and stage = $2`,
		[runId, stage, outcome.status, outcome.finishedAt, outcome.durationMs,
			outcome.provider ?? null, outcome.model ?? null],
	);
}

/** Attempt rows are append-only history; re-recording the same id is a no-op. */
export async function recordAttempt(
	sql: Sql,
	runId: string,
	attempt: AgentAttempt,
): Promise<void> {
	await sql.unsafe(
		`insert into agent_attempts (attempt_id, run_id, stage, provider, model, started_at,
			finished_at, duration_ms, status, failure_class, fallback_reason, error_meta, fault_injected)
		 values ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8,$9,$10,$11,$12::jsonb,$13::jsonb)
		 on conflict (attempt_id) do nothing`,
		[
			attempt.attemptId, runId, attempt.stage, attempt.provider, attempt.model,
			attempt.startedAt, attempt.finishedAt, attempt.durationMs, attempt.status,
			attempt.failureClass ?? null, attempt.fallbackReason ?? null,
			jsonParam(sql, attempt.errorMeta ?? null),
			jsonParam(sql, attempt.faultInjected ?? null),
		],
	);
}

export async function countAttempts(sql: Sql, runId: string): Promise<number> {
	const rows = await sql<{ n: string }[]>`
		select count(*)::text as n from agent_attempts where run_id = ${runId}
	`;
	return Number(rows[0]?.n ?? 0);
}

/* -------------------------------------------------------------------------- */
/* Read-only projections for the web reader (additive).                        */
/* -------------------------------------------------------------------------- */

export interface RunSummary extends RunState {
	lineage: string;
}

/** Newest runs first; the run table on /admin/runs. */
export async function listRecentRuns(
	sql: Sql,
	lineage: string,
	limit = 50,
): Promise<RunSummary[]> {
	const rows = await sql.unsafe<
		{
			run_id: string; lineage: string; date: string; status: string; total_items: number;
			processed_items: number; story_count: number; failure_reason: string | null;
			degraded_reason: string | null;
			created_at: string; updated_at: string;
		}[]
	>(
		`select run_id, lineage, date, status, total_items, processed_items, story_count,
			failure_reason, degraded_reason,
			to_char(created_at at time zone 'utc', ${ISO}) as created_at,
			to_char(updated_at at time zone 'utc', ${ISO}) as updated_at
		 from daily_runs where lineage = $1
		 order by created_at desc limit $2`,
		[lineage, limit],
	);
	return rows.map((r) => ({
		runId: r.run_id,
		lineage: r.lineage,
		date: r.date,
		status: r.status as RunState["status"],
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		totalItems: r.total_items,
		processedItems: r.processed_items,
		storyCount: r.story_count,
		...(r.failure_reason === null ? {} : { failureReason: r.failure_reason }),
		...(r.degraded_reason === null ? {} : { degradedReason: r.degraded_reason }),
	}));
}

export interface AgentRunRow {
	runId: string;
	stage: Stage;
	status: "RUNNING" | "SUCCESS" | "FAILED";
	provider: string | undefined;
	model: string | undefined;
	startedAt: string;
	finishedAt: string | undefined;
	durationMs: number | undefined;
}

/** Per-stage timings for a set of runs, in one query (the stage table). */
export async function listAgentRuns(
	sql: Sql,
	runIds: readonly string[],
): Promise<AgentRunRow[]> {
	if (runIds.length === 0) return [];
	const rows = await sql.unsafe<
		{
			run_id: string; stage: string; status: string; provider: string | null;
			model: string | null; started_at: string; finished_at: string | null;
			duration_ms: number | null;
		}[]
	>(
		`select run_id, stage, status, provider, model,
			to_char(started_at at time zone 'utc', ${ISO}) as started_at,
			to_char(finished_at at time zone 'utc', ${ISO}) as finished_at,
			duration_ms
		 from agent_runs where run_id = any($1::text[])
		 order by run_id, started_at`,
		[runIds as string[]],
	);
	return rows.map((r) => ({
		runId: r.run_id,
		stage: r.stage as Stage,
		status: r.status as AgentRunRow["status"],
		provider: r.provider ?? undefined,
		model: r.model ?? undefined,
		startedAt: r.started_at,
		finishedAt: r.finished_at ?? undefined,
		durationMs: r.duration_ms ?? undefined,
	}));
}

export interface AttemptRow extends AgentAttempt {
	runId: string;
}

/**
 * Attempt history for a set of runs. A run with more than one attempt per stage
 * is a fallback event, and `faultInjected` marks the synthetic ones so the
 * admin view never reports a test fault as a real provider failure.
 */
export async function listAttempts(
	sql: Sql,
	runIds: readonly string[],
): Promise<AttemptRow[]> {
	if (runIds.length === 0) return [];
	const rows = await sql.unsafe<
		{
			attempt_id: string; run_id: string; stage: string; provider: string; model: string;
			started_at: string; finished_at: string; duration_ms: number; status: string;
			failure_class: string | null; fallback_reason: string | null;
			error_meta: Record<string, unknown> | null;
			fault_injected: AgentAttempt["faultInjected"] | null;
		}[]
	>(
		`select attempt_id, run_id, stage, provider, model,
			to_char(started_at at time zone 'utc', ${ISO}) as started_at,
			to_char(finished_at at time zone 'utc', ${ISO}) as finished_at,
			duration_ms, status, failure_class, fallback_reason, error_meta, fault_injected
		 from agent_attempts where run_id = any($1::text[])
		 order by run_id, started_at`,
		[runIds as string[]],
	);
	return rows.map((r) => ({
		runId: r.run_id,
		attemptId: r.attempt_id,
		stage: r.stage as Stage,
		provider: r.provider,
		model: r.model,
		startedAt: r.started_at,
		finishedAt: r.finished_at,
		durationMs: r.duration_ms,
		status: r.status as AgentAttempt["status"],
		...(r.failure_class === null ? {} : { failureClass: r.failure_class as AgentAttempt["failureClass"] }),
		...(r.fallback_reason === null ? {} : { fallbackReason: r.fallback_reason }),
		...(r.error_meta === null ? {} : { errorMeta: r.error_meta }),
		...(r.fault_injected === null ? {} : { faultInjected: r.fault_injected }),
	}));
}
