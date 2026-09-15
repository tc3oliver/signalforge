import type { DailyBrief } from "../schemas/brief.ts";
import { ISO, ISO_FMT, jsonParam, type Sql } from "./client.ts";

export interface DraftMeta {
	producedAt: string;
	runId?: string;
	validationStatus?: "PENDING" | "PASSED" | "FAILED";
	validationErrors?: unknown[];
	/**
	 * Update this draft in place instead of appending a new one. The pipeline
	 * saves a draft as PENDING the moment the editor produces it, then records
	 * the verdict against that same draft — without this, every run stored the
	 * identical brief twice and the history said the editor had written two.
	 */
	draftNo?: number;
}

/**
 * Every editor attempt is kept. A validation failure is only diagnosable if the
 * rejected draft is still there next to the one that replaced it.
 */
export async function saveDraft(
	sql: Sql,
	lineage: string,
	date: string,
	draft: unknown,
	meta: DraftMeta,
): Promise<number> {
	const params = [
		lineage, date, meta.runId ?? null, jsonParam(sql, draft), meta.producedAt,
		meta.validationStatus ?? "PENDING", jsonParam(sql, meta.validationErrors ?? []),
	];
	const rows =
		meta.draftNo === undefined
			? await sql.unsafe<{ draft_no: number }[]>(
					`insert into daily_brief_drafts (lineage, date, draft_no, run_id, body, produced_at,
						validation_status, validation_errors)
					 select $1, $2,
						coalesce((select max(draft_no) from daily_brief_drafts where lineage = $1 and date = $2), 0) + 1,
						$3, $4::jsonb, $5::timestamptz, $6, $7::jsonb
					 returning draft_no`,
					params,
				)
			: /*
				 * Only the verdict is written back. `run_id` and `produced_at` belong
				 * to the attempt that authored this body: on a `--stage validate` of
				 * an earlier day, rewriting them would make the table say the
				 * validating run produced a brief it never wrote, which is exactly
				 * the provenance this append-only table exists to keep.
				 */
				await sql.unsafe<{ draft_no: number }[]>(
					`update daily_brief_drafts set validation_status = $3, validation_errors = $4::jsonb
					 where lineage = $1 and date = $2 and draft_no = $5
					 returning draft_no`,
					[
						lineage,
						date,
						meta.validationStatus ?? "PENDING",
						jsonParam(sql, meta.validationErrors ?? []),
						meta.draftNo,
					],
				);
	const row = rows[0];
	if (!row) {
		throw new Error(
			meta.draftNo === undefined
				? "draft insert returned no row"
				: `draft ${meta.draftNo} for ${date} does not exist`,
		);
	}
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
				brief.watchNext, jsonParam(sql, brief.emergingSignals),
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
	const head = await sql<
		{
			produced_at: string; daily_analysis: string; watch_next: string[];
			emerging_signals: DailyBrief["emergingSignals"];
		}[]
	>`
		select to_char(produced_at at time zone 'utc', ${ISO_FMT}) as produced_at,
			daily_analysis, watch_next, emerging_signals
		from daily_briefs where lineage = ${lineage} and date = ${date}
	`;
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

/* -------------------------------------------------------------------------- */
/* Read-only projections for the web reader (additive; no existing behaviour   */
/* is changed). These exist here rather than in the web app so there is one    */
/* data-access layer for daily_briefs, not two.                                */
/* -------------------------------------------------------------------------- */

export interface BriefSummary {
	date: string;
	producedAt: string;
	storyCount: number;
	mustKnowCount: number;
	sections: string[];
	signalCount: number;
	headline: string | undefined;
}

/** Newest first. Drives /history and the "latest brief" redirect on /. */
export async function listBriefSummaries(
	sql: Sql,
	lineage: string,
	limit = 60,
): Promise<BriefSummary[]> {
	const rows = await sql.unsafe<
		{
			date: string; produced_at: string; story_count: string; must_know_count: string;
			sections: string[]; signal_count: string; headline: string | null;
		}[]
	>(
		`select b.date,
			to_char(b.produced_at at time zone 'utc', ${ISO}) as produced_at,
			(select count(*) from daily_brief_stories s
			 where s.lineage = b.lineage and s.date = b.date)::text as story_count,
			(select count(*) from daily_brief_stories s
			 where s.lineage = b.lineage and s.date = b.date and s.must_know)::text as must_know_count,
			coalesce((select array_agg(distinct s.section) from daily_brief_stories s
			 where s.lineage = b.lineage and s.date = b.date), '{}'::text[]) as sections,
			jsonb_array_length(b.emerging_signals)::text as signal_count,
			(select s.title from daily_brief_stories s
			 where s.lineage = b.lineage and s.date = b.date
			 order by s.must_know desc, s.ordinal limit 1) as headline
		 from daily_briefs b
		 where b.lineage = $1
		 order by b.date desc
		 limit $2`,
		[lineage, limit],
	);
	return rows.map((r) => ({
		date: r.date,
		producedAt: r.produced_at,
		storyCount: Number(r.story_count),
		mustKnowCount: Number(r.must_know_count),
		sections: r.sections,
		signalCount: Number(r.signal_count),
		headline: r.headline ?? undefined,
	}));
}

/** The date of the most recent published brief, or undefined if none exists. */
export async function latestBriefDate(sql: Sql, lineage: string): Promise<string | undefined> {
	const rows = await sql<{ date: string }[]>`
		select date from daily_briefs where lineage = ${lineage} order by date desc limit 1
	`;
	return rows[0]?.date;
}

export interface BriefStoryHit {
	date: string;
	storyId: string;
	section: string;
	mustKnow: boolean;
	title: string;
	whatHappened: string;
	whyItMatters: string;
	confidence: string;
	rank: number;
}

/**
 * Full-text search over published brief stories using the stored generated
 * tsvector. Ranking is ts_rank on that vector: explainable, reproducible and
 * free of any model in the request path.
 */
export async function searchBriefStories(
	sql: Sql,
	lineage: string,
	query: string,
	limit = 25,
): Promise<BriefStoryHit[]> {
	if (query.trim() === "") return [];
	const rows = await sql<
		{
			date: string; story_id: string; section: string; must_know: boolean; title: string;
			what_happened: string; why_it_matters: string; confidence: string; rank: number;
		}[]
	>`
		select date, story_id, section, must_know, title, what_happened, why_it_matters, confidence,
			ts_rank(search, websearch_to_tsquery('simple', ${query})) as rank
		from daily_brief_stories
		where lineage = ${lineage} and search @@ websearch_to_tsquery('simple', ${query})
		order by rank desc, date desc, ordinal
		limit ${limit}
	`;
	return rows.map((r) => ({
		date: r.date,
		storyId: r.story_id,
		section: r.section,
		mustKnow: r.must_know,
		title: r.title,
		whatHappened: r.what_happened,
		whyItMatters: r.why_it_matters,
		confidence: r.confidence,
		rank: r.rank,
	}));
}

export interface BriefAppearance {
	date: string;
	section: string;
	mustKnow: boolean;
	title: string;
	whatHappened: string;
	whyItMatters: string;
	whatChanged: string;
	impact: string;
	confidence: string;
	sourceItemIds: string[];
	factRefs: string[];
}

/** Every published brief a story reached, newest first. */
export async function briefAppearancesForStory(
	sql: Sql,
	lineage: string,
	storyId: string,
): Promise<BriefAppearance[]> {
	const rows = await sql<
		{
			date: string; section: string; must_know: boolean; title: string;
			what_happened: string; why_it_matters: string; what_changed: string; impact: string;
			confidence: string; source_item_ids: string[]; fact_refs: string[];
		}[]
	>`
		select date, section, must_know, title, what_happened, why_it_matters, what_changed,
			impact, confidence, source_item_ids, fact_refs
		from daily_brief_stories
		where lineage = ${lineage} and story_id = ${storyId}
		order by date desc
	`;
	return rows.map((r) => ({
		date: r.date,
		section: r.section,
		mustKnow: r.must_know,
		title: r.title,
		whatHappened: r.what_happened,
		whyItMatters: r.why_it_matters,
		whatChanged: r.what_changed,
		impact: r.impact,
		confidence: r.confidence,
		sourceItemIds: r.source_item_ids,
		factRefs: r.fact_refs,
	}));
}

export interface DraftValidationRecord {
	date: string;
	draftNo: number;
	runId: string | undefined;
	producedAt: string;
	validationStatus: "PENDING" | "PASSED" | "FAILED";
	validationErrors: unknown[];
}

/** Rejected editor drafts, newest first — the validation panel on /admin/runs. */
export async function listDraftValidationFailures(
	sql: Sql,
	lineage: string,
	limit = 50,
): Promise<DraftValidationRecord[]> {
	const rows = await sql.unsafe<
		{
			date: string; draft_no: number; run_id: string | null; produced_at: string;
			validation_status: string; validation_errors: unknown[];
		}[]
	>(
		`select date, draft_no, run_id,
			to_char(produced_at at time zone 'utc', ${ISO}) as produced_at,
			validation_status, validation_errors
		 from daily_brief_drafts
		 where lineage = $1 and validation_status = 'FAILED'
		 order by date desc, draft_no desc
		 limit $2`,
		[lineage, limit],
	);
	return rows.map((r) => ({
		date: r.date,
		draftNo: r.draft_no,
		runId: r.run_id ?? undefined,
		producedAt: r.produced_at,
		validationStatus: r.validation_status as DraftValidationRecord["validationStatus"],
		validationErrors: Array.isArray(r.validation_errors) ? r.validation_errors : [],
	}));
}

/**
 * How many days exist, independent of any page limit. /history shows a window
 * and has to say so honestly: without this it reported its own limit as the
 * total, which becomes a false statement the day the archive outgrows it.
 */
export async function countBriefs(sql: Sql, lineage: string): Promise<number> {
	const rows = await sql<{ total: number }[]>`
		select count(*)::int as total from daily_briefs where lineage = ${lineage}
	`;
	return rows[0]?.total ?? 0;
}
