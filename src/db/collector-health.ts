import type { CollectorHealth, CollectorResult } from "../collectors/types.ts";
import type { Sql } from "./client.ts";

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

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
		await tx.unsafe(
			`update source_configs set
				cursor = coalesce($2, cursor),
				last_health = $3,
				last_run_at = $4::timestamptz,
				consecutive_failures = case when $3 = 'FAILED' then consecutive_failures + 1 else 0 end,
				updated_at = now()
			 where collector_id = $1`,
			[result.collectorId, result.cursor ?? null, result.health, result.finishedAt],
		);
	});
}

export interface CollectorStatus {
	collectorId: string;
	sourceType: string;
	enabled: boolean;
	lastHealth: CollectorHealth | undefined;
	lastRunAt: string | undefined;
	consecutiveFailures: number;
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
			JSON.stringify(config.config ?? {}), (config.requiredSecrets ?? []) as string[],
		],
	);
}

export async function listCollectorStatus(sql: Sql): Promise<CollectorStatus[]> {
	const rows = await sql.unsafe<
		{
			collector_id: string; source_type: string; enabled: boolean;
			last_health: string | null; last_run_at: string | null;
			consecutive_failures: number; cursor: string | null;
		}[]
	>(
		`select collector_id, source_type, enabled, last_health,
			to_char(last_run_at at time zone 'utc', ${ISO}) as last_run_at,
			consecutive_failures, cursor
		 from source_configs order by collector_id`,
		[],
	);
	return rows.map((r) => ({
		collectorId: r.collector_id,
		sourceType: r.source_type,
		enabled: r.enabled,
		lastHealth: (r.last_health ?? undefined) as CollectorHealth | undefined,
		lastRunAt: r.last_run_at ?? undefined,
		consecutiveFailures: r.consecutive_failures,
		cursor: r.cursor ?? undefined,
	}));
}
