import type { Sql } from "./client.ts";
import type { ScreeningDecision, ScreeningVerdict } from "../screening/types.ts";

/*
 * Reads and writes for `item_screening` (migration 012).
 *
 * Unlike `item_triage`, this table HAS a pipeline read path -- that is the
 * point of it -- but only one, `loadRoutedDropItemIds`, and it is only
 * consulted in route mode. The reads for measurement live in
 * src/observation/queries.ts.
 */

export interface ScreeningRowInput extends ScreeningDecision {
	auditSampled: boolean;
	/** True only when this DROP actually withheld the item from the default scan. */
	routed: boolean;
}

export interface ScreeningWriteOptions {
	lineage: string;
	date: string;
	provider: string;
	model: string;
	policyVersion: string;
	runId?: string;
}

/**
 * Writes one row per decision. On conflict the row is replaced: a re-screen of
 * the same item under the same (model, policy) is the newer opinion of the same
 * screener, and there is nothing to keep from the older one.
 */
export async function saveScreening(
	sql: Sql,
	opts: ScreeningWriteOptions,
	rows: readonly ScreeningRowInput[],
): Promise<number> {
	if (rows.length === 0) return 0;
	const CHUNK = 500;
	let written = 0;
	for (let i = 0; i < rows.length; i += CHUNK) {
		const chunk = rows.slice(i, i + CHUNK).map((r) => ({
			lineage: opts.lineage,
			date: opts.date,
			item_id: r.itemId,
			provider: opts.provider,
			model: opts.model,
			policy_version: opts.policyVersion,
			run_id: opts.runId ?? null,
			verdict: r.verdict,
			reason_code: r.reasonCode,
			reason: r.reason,
			audit_sampled: r.auditSampled,
			routed: r.routed,
		}));
		await sql`
			insert into item_screening ${sql(
				chunk,
				"lineage",
				"date",
				"item_id",
				"provider",
				"model",
				"policy_version",
				"run_id",
				"verdict",
				"reason_code",
				"reason",
				"audit_sampled",
				"routed",
			)}
			on conflict (lineage, date, item_id, model, policy_version) do update set
				provider = excluded.provider,
				run_id = excluded.run_id,
				verdict = excluded.verdict,
				reason_code = excluded.reason_code,
				reason = excluded.reason,
				audit_sampled = excluded.audit_sampled,
				routed = excluded.routed
		`;
		written += chunk.length;
	}
	return written;
}

/** Which of these items already carry a verdict from this screener version. */
export async function screenedItemIds(
	sql: Sql,
	opts: { lineage: string; date: string; model: string; policyVersion: string },
): Promise<Set<string>> {
	const rows = await sql<{ item_id: string }[]>`
		select item_id from item_screening
		where lineage = ${opts.lineage} and date = ${opts.date}
		  and model = ${opts.model} and policy_version = ${opts.policyVersion}
	`;
	return new Set(rows.map((r) => r.item_id));
}

/**
 * The item ids a route-mode run withholds from the Curator's default scan.
 *
 * Only rows that say `routed = true` count, and only for the trusted (model,
 * policy_version). Everything else -- KEEP, UNSURE, an audit-sampled DROP, a
 * DROP from a version that is not trusted, or a row that does not exist --
 * falls open to the Curator by not being in this set.
 */
export async function loadRoutedDropItemIds(
	sql: Sql,
	opts: { lineage: string; date: string; trustedModel: string; trustedPolicyVersion: string },
): Promise<Set<string>> {
	const rows = await sql<{ item_id: string }[]>`
		select item_id from item_screening
		where lineage = ${opts.lineage} and date = ${opts.date}
		  and model = ${opts.trustedModel} and policy_version = ${opts.trustedPolicyVersion}
		  and verdict = 'DROP' and routed = true and audit_sampled = false
	`;
	return new Set(rows.map((r) => r.item_id));
}

/** Per-verdict counts for one screener version on one day. */
export async function screeningTally(
	sql: Sql,
	opts: { lineage: string; date: string; model: string; policyVersion: string },
): Promise<Record<ScreeningVerdict, number>> {
	const rows = await sql<{ verdict: ScreeningVerdict; n: number }[]>`
		select verdict, count(*)::int as n from item_screening
		where lineage = ${opts.lineage} and date = ${opts.date}
		  and model = ${opts.model} and policy_version = ${opts.policyVersion}
		group by verdict
	`;
	const tally: Record<ScreeningVerdict, number> = { DROP: 0, KEEP: 0, UNSURE: 0 };
	for (const r of rows) tally[r.verdict] = r.n;
	return tally;
}
