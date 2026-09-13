import type { DailyMaterials } from "../schemas/materials.ts";
import { jsonParam, type Sql } from "./client.ts";

/* Bind parameter, not inlined SQL: see the note in src/db/items.ts. */
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
/*
 * Same format as ISO, but without the SQL string quotes: inside a tagged
 * template the value is sent as a bound parameter, so quoting it here would
 * put literal quote characters into the to_char format string.
 */
const ISO_FMT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

/** Whole-document write: the curator submits one materials package per date. */
export async function saveMaterials(
	sql: Sql,
	lineage: string,
	materials: DailyMaterials,
	runId?: string,
): Promise<void> {
	await sql.begin(async (tx) => {
		await tx.unsafe(
			`insert into daily_materials (lineage, date, run_id, produced_at, curator_notes, emerging_signals)
			 values ($1,$2,$3,$4::timestamptz,$5,$6::jsonb)
			 on conflict (lineage, date) do update set
				run_id = excluded.run_id, produced_at = excluded.produced_at,
				curator_notes = excluded.curator_notes,
				emerging_signals = excluded.emerging_signals, updated_at = now()`,
			[lineage, materials.date, runId ?? null, materials.producedAt, materials.curatorNotes,
				jsonParam(sql, materials.emergingSignals)],
		);
		// Replaced wholesale: a resubmitted package must not leave last attempt's
		// stories behind as phantom selections.
		await tx`delete from daily_material_stories where lineage = ${lineage} and date = ${materials.date}`;
		for (const [index, story] of materials.stories.entries()) {
			await tx.unsafe(
				`insert into daily_material_stories (lineage, date, story_id, ordinal, tier,
					canonical_title, why_selected, change_type, importance, novelty, confidence,
					source_item_ids, primary_source_ids, fact_refs)
				 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text[],$13::text[],$14::text[])`,
				[
					lineage, materials.date, story.storyId, index, story.tier, story.canonicalTitle,
					story.whySelected, story.changeType, story.importance, story.novelty,
					story.confidence, story.sourceItemIds, story.primarySourceIds, story.factRefs,
				],
			);
		}
	});
}

export async function getMaterials(
	sql: Sql,
	lineage: string,
	date: string,
): Promise<DailyMaterials | undefined> {
	const head = await sql<
		{ produced_at: string; curator_notes: string; emerging_signals: DailyMaterials["emergingSignals"] }[]
	>`
		select to_char(produced_at at time zone 'utc', ${ISO_FMT}) as produced_at, curator_notes, emerging_signals
		from daily_materials where lineage = ${lineage} and date = ${date}
	`;
	const h = head[0];
	if (!h) return undefined;
	const stories = await sql<
		{
			story_id: string; tier: string; canonical_title: string; why_selected: string;
			change_type: string; importance: number; novelty: number; confidence: number;
			source_item_ids: string[]; primary_source_ids: string[]; fact_refs: string[];
		}[]
	>`
		select story_id, tier, canonical_title, why_selected, change_type, importance,
			novelty, confidence, source_item_ids, primary_source_ids, fact_refs
		from daily_material_stories where lineage = ${lineage} and date = ${date}
		order by ordinal
	`;
	return {
		date,
		producedAt: h.produced_at,
		curatorNotes: h.curator_notes,
		emergingSignals: h.emerging_signals,
		stories: stories.map((s) => ({
			storyId: s.story_id,
			tier: s.tier as DailyMaterials["stories"][number]["tier"],
			canonicalTitle: s.canonical_title,
			whySelected: s.why_selected,
			changeType: s.change_type as DailyMaterials["stories"][number]["changeType"],
			importance: s.importance,
			novelty: s.novelty,
			confidence: s.confidence,
			sourceItemIds: s.source_item_ids,
			primarySourceIds: s.primary_source_ids,
			factRefs: s.fact_refs,
		})) as DailyMaterials["stories"],
	};
}
