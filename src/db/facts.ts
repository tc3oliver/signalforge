import type { StructuredFact } from "../schemas/fact.ts";
import { ISO, type Sql } from "./client.ts";

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

/** How many facts go into one `unnest` statement; see the note in items.ts. */
const CHUNK = 500;

/**
 * Re-ingesting the same reading overwrites it rather than duplicating it.
 *
 * Chunked `unnest`: a numeric collector brings back a reading per series per
 * day and this was one round trip each. `on conflict do update` may not touch
 * the same row twice in one statement, so a fact id repeated within the batch is
 * collapsed to its last occurrence, which is what the per-row loop did by
 * overwriting.
 */
export async function upsertFacts(
	sql: Sql,
	lineage: string,
	facts: readonly StructuredFact[],
): Promise<void> {
	if (facts.length === 0) return;
	const byId = new Map<string, StructuredFact>();
	for (const f of facts) byId.set(f.factId, f);
	const unique = [...byId.values()];
	await sql.begin(async (tx) => {
		for (let i = 0; i < unique.length; i += CHUNK) {
			const chunk = unique.slice(i, i + CHUNK);
			await tx.unsafe(
				`insert into structured_facts (lineage, fact_id, kind, label, value, unit, as_of,
					source_item_id, previous_value, change_pct)
				 select $1, t.fact_id, t.kind, t.label, t.value, t.unit, t.as_of,
					t.source_item_id, t.previous_value, t.change_pct
				 from unnest($2::text[], $3::text[], $4::text[], $5::double precision[], $6::text[],
					$7::timestamptz[], $8::text[], $9::double precision[], $10::double precision[])
					as t(fact_id, kind, label, value, unit, as_of, source_item_id, previous_value, change_pct)
				 on conflict (lineage, fact_id) do update set
					kind = excluded.kind, label = excluded.label, value = excluded.value,
					unit = excluded.unit, as_of = excluded.as_of,
					source_item_id = excluded.source_item_id,
					previous_value = excluded.previous_value, change_pct = excluded.change_pct,
					updated_at = now()`,
				[
					lineage,
					chunk.map((f) => f.factId),
					chunk.map((f) => f.kind),
					chunk.map((f) => f.label),
					chunk.map((f) => f.value),
					chunk.map((f) => f.unit),
					chunk.map((f) => f.asOf),
					chunk.map((f) => f.sourceItemId),
					chunk.map((f) => f.previousValue ?? null),
					chunk.map((f) => f.changePct ?? null),
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
