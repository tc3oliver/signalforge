import type { DailyBrief } from "../schemas/brief.ts";
import type { Sql } from "./client.ts";

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * Every editor attempt is kept. A validation failure is only diagnosable if the
 * rejected draft is still there next to the one that replaced it.
 */
export async function saveDraft(
	sql: Sql,
	lineage: string,
	date: string,
	draft: unknown,
	meta: { producedAt: string; runId?: string; validationStatus?: "PENDING" | "PASSED" | "FAILED"; validationErrors?: unknown[] },
): Promise<number> {
	const rows = await sql.unsafe<{ draft_no: number }[]>(
		`insert into daily_brief_drafts (lineage, date, draft_no, run_id, body, produced_at,
			validation_status, validation_errors)
		 select $1, $2,
			coalesce((select max(draft_no) from daily_brief_drafts where lineage = $1 and date = $2), 0) + 1,
			$3, $4::jsonb, $5::timestamptz, $6, $7::jsonb
		 returning draft_no`,
		[
			lineage, date, meta.runId ?? null, JSON.stringify(draft), meta.producedAt,
			meta.validationStatus ?? "PENDING", JSON.stringify(meta.validationErrors ?? []),
		],
	);
	const row = rows[0];
	if (!row) throw new Error("draft insert returned no row");
	return row.draft_no;
}

export async function saveBrief(
	sql: Sql,
	lineage: string,
	brief: DailyBrief,
	runId?: string,
): Promise<void> {
	await sql.begin(async (tx) => {
		await tx.unsafe(
			`insert into daily_briefs (lineage, date, run_id, produced_at, daily_analysis,
				watch_next, emerging_signals)
			 values ($1,$2,$3,$4::timestamptz,$5,$6::text[],$7::jsonb)
			 on conflict (lineage, date) do update set
				run_id = excluded.run_id, produced_at = excluded.produced_at,
				daily_analysis = excluded.daily_analysis, watch_next = excluded.watch_next,
				emerging_signals = excluded.emerging_signals, updated_at = now()`,
			[
				lineage, brief.date, runId ?? null, brief.producedAt, brief.dailyAnalysis,
				brief.watchNext, JSON.stringify(brief.emergingSignals),
			],
		);
		await tx`delete from daily_brief_stories where lineage = ${lineage} and date = ${brief.date}`;
		for (const [index, story] of brief.stories.entries()) {
			await tx.unsafe(
				`insert into daily_brief_stories (lineage, date, story_id, ordinal, section, must_know,
					title, what_happened, why_it_matters, what_changed, impact, confidence,
					source_item_ids, fact_refs)
				 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::text[],$14::text[])`,
				[
					lineage, brief.date, story.storyId, index, story.section, story.mustKnow,
					story.title, story.whatHappened, story.whyItMatters, story.whatChanged,
					story.impact, story.confidence, story.sourceItemIds, story.factRefs,
				],
			);
		}
	});
}

export async function getBrief(
	sql: Sql,
	lineage: string,
	date: string,
): Promise<DailyBrief | undefined> {
	const head = await sql.unsafe<
		{
			produced_at: string; daily_analysis: string; watch_next: string[];
			emerging_signals: DailyBrief["emergingSignals"];
		}[]
	>(
		`select to_char(produced_at at time zone 'utc', ${ISO}) as produced_at,
			daily_analysis, watch_next, emerging_signals
		 from daily_briefs where lineage = $1 and date = $2`,
		[lineage, date],
	);
	const h = head[0];
	if (!h) return undefined;
	const stories = await sql<
		{
			story_id: string; section: string; must_know: boolean; title: string;
			what_happened: string; why_it_matters: string; what_changed: string;
			impact: string; confidence: string; source_item_ids: string[]; fact_refs: string[];
		}[]
	>`
		select story_id, section, must_know, title, what_happened, why_it_matters,
			what_changed, impact, confidence, source_item_ids, fact_refs
		from daily_brief_stories where lineage = ${lineage} and date = ${date}
		order by ordinal
	`;
	return {
		date,
		producedAt: h.produced_at,
		dailyAnalysis: h.daily_analysis,
		watchNext: h.watch_next,
		emergingSignals: h.emerging_signals,
		stories: stories.map((s) => ({
			storyId: s.story_id,
			section: s.section as DailyBrief["stories"][number]["section"],
			mustKnow: s.must_know,
			title: s.title,
			whatHappened: s.what_happened,
			whyItMatters: s.why_it_matters,
			whatChanged: s.what_changed,
			impact: s.impact,
			confidence: s.confidence as DailyBrief["stories"][number]["confidence"],
			sourceItemIds: s.source_item_ids,
			factRefs: s.fact_refs,
		})) as DailyBrief["stories"],
	};
}
