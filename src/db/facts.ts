import type { StructuredFact } from "../schemas/fact.ts";
import type { Sql } from "./client.ts";

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

const COLUMNS = `fact_id, kind, label, value, unit,
	to_char(as_of at time zone 'utc', ${ISO}) as as_of,
	source_item_id, previous_value, change_pct`;

interface FactRow {
	fact_id: string; kind: string; label: string; value: number; unit: string;
	as_of: string; source_item_id: string; previous_value: number | null; change_pct: number | null;
}

function toFact(r: FactRow): StructuredFact {
	return {
		factId: r.fact_id,
		kind: r.kind as StructuredFact["kind"],
		label: r.label,
		value: r.value,
		unit: r.unit,
		asOf: r.as_of,
		sourceItemId: r.source_item_id,
		...(r.previous_value === null ? {} : { previousValue: r.previous_value }),
		...(r.change_pct === null ? {} : { changePct: r.change_pct }),
	};
}

/** Re-ingesting the same reading overwrites it rather than duplicating it. */
export async function upsertFacts(
	sql: Sql,
	lineage: string,
	facts: readonly StructuredFact[],
): Promise<void> {
	if (facts.length === 0) return;
	await sql.begin(async (tx) => {
		for (const f of facts) {
			await tx.unsafe(
				`insert into structured_facts (lineage, fact_id, kind, label, value, unit, as_of,
					source_item_id, previous_value, change_pct)
				 values ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,$10)
				 on conflict (lineage, fact_id) do update set
					kind = excluded.kind, label = excluded.label, value = excluded.value,
					unit = excluded.unit, as_of = excluded.as_of,
					source_item_id = excluded.source_item_id,
					previous_value = excluded.previous_value, change_pct = excluded.change_pct,
					updated_at = now()`,
				[
					lineage, f.factId, f.kind, f.label, f.value, f.unit, f.asOf,
					f.sourceItemId, f.previousValue ?? null, f.changePct ?? null,
				],
			);
		}
	});
}

export async function getFacts(
	sql: Sql,
	lineage: string,
	factIds: readonly string[],
): Promise<StructuredFact[]> {
	if (factIds.length === 0) return [];
	const rows = await sql.unsafe<FactRow[]>(
		`select ${COLUMNS} from structured_facts
		 where lineage = $1 and fact_id = any($2::text[]) order by fact_id`,
		[lineage, factIds as string[]],
	);
	return rows.map(toFact);
}

export async function listFactsByKind(
	sql: Sql,
	lineage: string,
	kind: StructuredFact["kind"],
): Promise<StructuredFact[]> {
	const rows = await sql.unsafe<FactRow[]>(
		`select ${COLUMNS} from structured_facts
		 where lineage = $1 and kind = $2 order by as_of desc`,
		[lineage, kind],
	);
	return rows.map(toFact);
}
