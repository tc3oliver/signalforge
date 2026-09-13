import type { CollectorHealth, CollectorResult } from "../collectors/types.ts";
import { jsonParam, type Sql } from "./client.ts";

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/* -------------------------------------------------------------------------- */
/* Health state transition (pure).                                             */
/* -------------------------------------------------------------------------- */

/** The rolling summary carried on source_configs for one collector. */
export interface HealthState {
	lastHealth: CollectorHealth | undefined;
	lastRunAt: string | undefined;
	lastSuccessAt: string | undefined;
	lastFailureAt: string | undefined;
	consecutiveFailures: number;
	lastError: string | undefined;
}

/** The part of a run outcome the summary is derived from. */
export interface HealthOutcome {
	health: CollectorHealth;
	finishedAt: string;
	error?: string | undefined;
}

/**
 * What counts as success: health OK, and nothing else. Item count is
 * deliberately not part of it -- FRED on a day with no new observations, or any
 * incremental source with nothing new, returns 0 items and has done its job.
 * Turning a quiet day into a failure would make exactly the collectors that are
 * healthiest the noisiest.
 */
export function isSuccessfulRun(outcome: HealthOutcome): boolean {
	return outcome.health === "OK";
}

/**
 * Previous summary + this run's outcome -> next summary. Pure, so the whole
 * escalation matrix is testable without Postgres; the SQL below only applies
 * what this returns.
 *
 * consecutive_failures resets on a genuine success and on nothing else. The old
 * `case when health = 'FAILED' then +1 else 0 end` reset it on DEGRADED too, so
 * a permanently degraded collector never escalated. DISABLED is neither: a
 * source that is switched off is not failing, and its history is left standing
 * so the counter is still there when it is switched back on.
 */
export function nextHealthState(previous: HealthState, outcome: HealthOutcome): HealthState {
	if (outcome.health === "DISABLED") {
		return { ...previous, lastHealth: "DISABLED", lastRunAt: outcome.finishedAt };
	}
	if (isSuccessfulRun(outcome)) {
		return {
			lastHealth: outcome.health,
			lastRunAt: outcome.finishedAt,
			lastSuccessAt: outcome.finishedAt,
			lastFailureAt: previous.lastFailureAt,
			consecutiveFailures: 0,
			lastError: undefined,
		};
	}
	return {
		lastHealth: outcome.health,
		lastRunAt: outcome.finishedAt,
		lastSuccessAt: previous.lastSuccessAt,
		lastFailureAt: outcome.finishedAt,
		consecutiveFailures: previous.consecutiveFailures + 1,
		// Keep the previous reason rather than blanking it when a failing run
		// reports no text; an empty error would erase why it is failing.
		lastError: outcome.error ?? previous.lastError,
	};
}

interface HealthStateRow {
	last_health: string | null;
	last_run_at: string | null;
	last_success_at: string | null;
	last_failure_at: string | null;
	consecutive_failures: number;
	last_error: string | null;
}

const EMPTY_STATE: HealthState = {
	lastHealth: undefined, lastRunAt: undefined, lastSuccessAt: undefined,
	lastFailureAt: undefined, consecutiveFailures: 0, lastError: undefined,
};

function rowToHealthState(row: HealthStateRow | undefined): HealthState {
	if (!row) return EMPTY_STATE;
	return {
		lastHealth: (row.last_health ?? undefined) as CollectorHealth | undefined,
		lastRunAt: row.last_run_at ?? undefined,
		lastSuccessAt: row.last_success_at ?? undefined,
		lastFailureAt: row.last_failure_at ?? undefined,
		consecutiveFailures: row.consecutive_failures,
		lastError: row.last_error ?? undefined,
	};
}

/**
 * One row per collector execution plus a rolling summary on source_configs, so
 * "which source went quiet" is answerable without scanning the whole history.
 */
export async function recordCollectionRun(
	sql: Sql,
	collectionRunId: string,
	result: CollectorResult,
	runId?: string,
): Promise<void> {
	await sql.begin(async (tx) => {
		await tx.unsafe(
			`insert into collection_runs (collection_run_id, run_id, collector_id, health,
				items_fetched, cursor, warnings, error, started_at, finished_at, latency_ms)
			 values ($1,$2,$3,$4,$5,$6,$7::text[],$8,$9::timestamptz,$10::timestamptz,$11)
			 on conflict (collection_run_id) do nothing`,
			[
				collectionRunId, runId ?? null, result.collectorId, result.health,
				result.itemsFetched, result.cursor ?? null, result.warnings,
				result.error ?? null, result.startedAt, result.finishedAt, result.latencyMs,
			],
		);
		// Read-modify-write inside the run's own transaction: the next state is
		// computed by nextHealthState, not by SQL, and the row is locked so two
		// concurrent runs of the same collector cannot both increment from the
		// same starting count.
		const [row] = await tx.unsafe<HealthStateRow[]>(
			`select last_health, consecutive_failures, last_error,
				to_char(last_run_at at time zone 'utc', ${ISO}) as last_run_at,
				to_char(last_success_at at time zone 'utc', ${ISO}) as last_success_at,
				to_char(last_failure_at at time zone 'utc', ${ISO}) as last_failure_at
			 from source_configs where collector_id = $1 for update`,
			[result.collectorId],
		);
		// No row means the collector has no source_configs entry; the update below
		// is then a no-op, exactly as before.
		const next = nextHealthState(rowToHealthState(row), result);
		await tx.unsafe(
			`update source_configs set
				cursor = coalesce($2, cursor),
				last_health = $3,
				last_run_at = $4::timestamptz,
				last_success_at = $5::timestamptz,
				last_failure_at = $6::timestamptz,
				consecutive_failures = $7,
				last_error = $8,
				updated_at = now()
			 where collector_id = $1`,
			[
				result.collectorId, result.cursor ?? null, next.lastHealth ?? null,
				next.lastRunAt ?? null, next.lastSuccessAt ?? null, next.lastFailureAt ?? null,
				next.consecutiveFailures, next.lastError ?? null,
			],
		);
	});
}

export interface CollectorStatus {
	collectorId: string;
	sourceType: string;
	enabled: boolean;
	lastHealth: CollectorHealth | undefined;
	lastRunAt: string | undefined;
	/** Most recent genuinely successful run; undefined means none on record. */
	lastSuccessAt: string | undefined;
	lastFailureAt: string | undefined;
	consecutiveFailures: number;
	/** Error of the most recent unsuccessful run, retained until it succeeds again. */
	lastError: string | undefined;
	cursor: string | undefined;
}

export async function upsertSourceConfig(
	sql: Sql,
	config: {
		collectorId: string;
		sourceType: string;
		enabled?: boolean;
		/** Logical secret names only — a secret value must never be stored here. */
		requiredSecrets?: readonly string[];
		config?: Record<string, unknown>;
	},
): Promise<void> {
	await sql.unsafe(
		`insert into source_configs (collector_id, source_type, enabled, config, required_secrets)
		 values ($1,$2,$3,$4::jsonb,$5::text[])
		 on conflict (collector_id) do update set
			source_type = excluded.source_type,
			enabled = excluded.enabled,
			config = excluded.config,
			required_secrets = excluded.required_secrets,
			updated_at = now()`,
		[
			config.collectorId, config.sourceType, config.enabled ?? true,
			jsonParam(sql, config.config ?? {}), (config.requiredSecrets ?? []) as string[],
		],
	);
}

export async function listCollectorStatus(sql: Sql): Promise<CollectorStatus[]> {
	const rows = await sql.unsafe<
		{
			collector_id: string; source_type: string; enabled: boolean;
			last_health: string | null; last_run_at: string | null;
			last_success_at: string | null; last_failure_at: string | null;
			consecutive_failures: number; last_error: string | null; cursor: string | null;
		}[]
	>(
		`select collector_id, source_type, enabled, last_health,
			to_char(last_run_at at time zone 'utc', ${ISO}) as last_run_at,
			to_char(last_success_at at time zone 'utc', ${ISO}) as last_success_at,
			to_char(last_failure_at at time zone 'utc', ${ISO}) as last_failure_at,
			consecutive_failures, last_error, cursor
		 from source_configs order by collector_id`,
		[],
	);
	return rows.map((r) => ({
		collectorId: r.collector_id,
		sourceType: r.source_type,
		enabled: r.enabled,
		lastHealth: (r.last_health ?? undefined) as CollectorHealth | undefined,
		lastRunAt: r.last_run_at ?? undefined,
		lastSuccessAt: r.last_success_at ?? undefined,
		lastFailureAt: r.last_failure_at ?? undefined,
		consecutiveFailures: r.consecutive_failures,
		lastError: r.last_error ?? undefined,
		cursor: r.cursor ?? undefined,
	}));
}

/* -------------------------------------------------------------------------- */
/* Read-only projections for the web reader (additive).                        */
/* -------------------------------------------------------------------------- */

export interface SourceConfigRow extends CollectorStatus {
	/**
	 * Logical secret names the collector needs. Values live in the keychain; a
	 * disabled source with a non-empty list is almost always a missing
	 * credential rather than a deliberate switch-off.
	 */
	requiredSecrets: string[];
	/** Config keys only. The config payload itself is never rendered. */
	configKeys: string[];
}

export async function listSourceConfigs(sql: Sql): Promise<SourceConfigRow[]> {
	const rows = await sql.unsafe<
		{
			collector_id: string; source_type: string; enabled: boolean;
			last_health: string | null; last_run_at: string | null;
			last_success_at: string | null; last_failure_at: string | null;
			consecutive_failures: number; last_error: string | null; cursor: string | null;
			required_secrets: string[]; config_keys: string[];
		}[]
	>(
		`select collector_id, source_type, enabled, last_health,
			to_char(last_run_at at time zone 'utc', ${ISO}) as last_run_at,
			to_char(last_success_at at time zone 'utc', ${ISO}) as last_success_at,
			to_char(last_failure_at at time zone 'utc', ${ISO}) as last_failure_at,
			consecutive_failures, last_error, cursor, required_secrets,
			coalesce((select array_agg(k order by k) from jsonb_object_keys(config) k), '{}'::text[]) as config_keys
		 from source_configs order by collector_id`,
		[],
	);
	return rows.map((r) => ({
		collectorId: r.collector_id,
		sourceType: r.source_type,
		enabled: r.enabled,
		lastHealth: (r.last_health ?? undefined) as CollectorHealth | undefined,
		lastRunAt: r.last_run_at ?? undefined,
		lastSuccessAt: r.last_success_at ?? undefined,
		lastFailureAt: r.last_failure_at ?? undefined,
		consecutiveFailures: r.consecutive_failures,
		lastError: r.last_error ?? undefined,
		cursor: r.cursor ?? undefined,
		requiredSecrets: r.required_secrets,
		configKeys: r.config_keys,
	}));
}

export interface CollectorThroughput {
	collectorId: string;
	runs: number;
	itemsFetched: number;
	itemsInserted: number;
	avgLatencyMs: number;
	maxLatencyMs: number;
	lastError: string | undefined;
	lastStartedAt: string | undefined;
}

/**
 * Fetched vs inserted per collector over a window. They diverge when a source
 * keeps re-serving the same records, which is the signal that a feed has gone
 * quiet without failing.
 */
export async function collectorThroughput(
	sql: Sql,
	sinceHours = 168,
): Promise<CollectorThroughput[]> {
	const rows = await sql.unsafe<
		{
			collector_id: string; runs: string; items_fetched: string; items_inserted: string;
			avg_latency_ms: number; max_latency_ms: number; last_error: string | null;
			last_started_at: string | null;
		}[]
	>(
		`select c.collector_id,
			count(*)::text as runs,
			coalesce(sum(c.items_fetched), 0)::text as items_fetched,
			(select count(*) from raw_items r
			 where r.collection_run_id in (
				select c2.collection_run_id from collection_runs c2
				where c2.collector_id = c.collector_id
				  and c2.started_at > now() - make_interval(hours => $1)
			 ))::text as items_inserted,
			coalesce(avg(c.latency_ms), 0)::float8 as avg_latency_ms,
			coalesce(max(c.latency_ms), 0) as max_latency_ms,
			(array_remove(array_agg(c.error order by c.started_at desc), null))[1] as last_error,
			to_char(max(c.started_at) at time zone 'utc', ${ISO}) as last_started_at
		 from collection_runs c
		 where c.started_at > now() - make_interval(hours => $1)
		 group by c.collector_id
		 order by c.collector_id`,
		[sinceHours],
	);
	return rows.map((r) => ({
		collectorId: r.collector_id,
		runs: Number(r.runs),
		itemsFetched: Number(r.items_fetched),
		itemsInserted: Number(r.items_inserted),
		avgLatencyMs: Math.round(r.avg_latency_ms),
		maxLatencyMs: r.max_latency_ms,
		lastError: r.last_error ?? undefined,
		lastStartedAt: r.last_started_at ?? undefined,
	}));
}

export interface CollectionRunRow {
	collectionRunId: string;
	runId: string | undefined;
	collectorId: string;
	health: CollectorHealth;
	itemsFetched: number;
	warnings: string[];
	error: string | undefined;
	startedAt: string;
	finishedAt: string;
	latencyMs: number;
}

/** Recent collection runs, newest first — the scan-coverage log. */
export async function listCollectionRuns(
	sql: Sql,
	limit = 50,
): Promise<CollectionRunRow[]> {
	const rows = await sql.unsafe<
		{
			collection_run_id: string; run_id: string | null; collector_id: string;
			health: string; items_fetched: number; warnings: string[]; error: string | null;
			started_at: string; finished_at: string; latency_ms: number;
		}[]
	>(
		`select collection_run_id, run_id, collector_id, health, items_fetched, warnings, error,
			to_char(started_at at time zone 'utc', ${ISO}) as started_at,
			to_char(finished_at at time zone 'utc', ${ISO}) as finished_at,
			latency_ms
		 from collection_runs order by started_at desc limit $1`,
		[limit],
	);
	return rows.map((r) => ({
		collectionRunId: r.collection_run_id,
		runId: r.run_id ?? undefined,
		collectorId: r.collector_id,
		health: r.health as CollectorHealth,
		itemsFetched: r.items_fetched,
		warnings: r.warnings,
		error: r.error ?? undefined,
		startedAt: r.started_at,
		finishedAt: r.finished_at,
		latencyMs: r.latency_ms,
	}));
}
