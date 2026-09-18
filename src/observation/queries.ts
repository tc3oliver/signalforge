import type { Sql } from "../db/client.ts";
import type { ChangeTypeCount } from "./continuity.ts";
import { daySpan, type SignalObservation } from "./continuity.ts";
import type { BriefEpochRow } from "./epoch.ts";
import type { FunnelStoryInput } from "./funnel.ts";
import type { StageHits } from "./attribution.ts";
import type { TriageOutcomeRow } from "./triage-funnel.ts";
import type { ScreeningOutcomeRow, StageUsage } from "./screening-funnel.ts";

/*
 * Every read the observation report makes. All of them are selects against rows
 * the pipeline already wrote, and there is no write path in this module by
 * design -- a measurement tool that can alter what it measures is a tool whose
 * output has to be qualified forever.
 */

export async function fetchBriefEpochs(sql: Sql, lineage: string): Promise<BriefEpochRow[]> {
	const rows = await sql<{ date: string; run_id: string; profile_version: string | null }[]>`
		select date, run_id, profile_version
		from daily_briefs
		where lineage = ${lineage}
		order by date
	`;
	return rows.map((r) => ({ date: r.date, runId: r.run_id, profileVersion: r.profile_version }));
}

/**
 * Every candidate story on a day, with the stages it reached.
 *
 * Left joins rather than three queries and a merge in JS: the stage tables are
 * keyed identically (lineage, date, story_id) and a story that appears in the
 * ledger but nowhere else is exactly the row the funnel is looking for, so it
 * must survive the join.
 */
export async function fetchFunnelStories(sql: Sql, lineage: string, date: string): Promise<FunnelStoryInput[]> {
	const rows = await sql<
		{ story_id: string; topic_ids: string[]; is_material: boolean; is_final: boolean; is_must_know: boolean }[]
	>`
		select
			s.story_id,
			s.topic_ids,
			(m.story_id is not null) as is_material,
			(b.story_id is not null) as is_final,
			coalesce(b.must_know, false) as is_must_know
		from story_ledger s
		left join daily_material_stories m
			on m.lineage = s.lineage and m.date = s.date and m.story_id = s.story_id
		left join daily_brief_stories b
			on b.lineage = s.lineage and b.date = s.date and b.story_id = s.story_id
		where s.lineage = ${lineage} and s.date = ${date}
		order by s.story_id
	`;
	return rows.map((r) => ({
		storyId: r.story_id,
		topicIds: r.topic_ids ?? [],
		isMaterial: r.is_material,
		isFinal: r.is_final,
		isMustKnow: r.is_must_know,
	}));
}

export async function fetchChangeTypes(sql: Sql, lineage: string, date: string): Promise<ChangeTypeCount[]> {
	const rows = await sql<{ change_type: string; n: number }[]>`
		select change_type, count(*)::int as n
		from story_ledger
		where lineage = ${lineage} and date = ${date}
		group by change_type
	`;
	return rows.map((r) => ({ changeType: r.change_type, count: r.n }));
}

/**
 * Signals as they stand, with their evidence counted.
 *
 * `story_ids` is the signal's own evidence list; the distinct source count comes
 * from the stories it points at, because "three stories from one feed" and
 * "three stories from three feeds" are different amounts of confidence and the
 * stored `confidence` number does not distinguish them.
 */
export async function fetchSignals(sql: Sql, lineage: string): Promise<SignalObservation[]> {
	const rows = await sql<
		{
			signal_id: string;
			label: string;
			state: string;
			confidence: number;
			// The client registers a `{ date: string }` transform, so every timestamp
			// arrives already serialised rather than as a Date.
			first_seen_at: string;
			last_seen_at: string;
			evidence_stories: number;
			evidence_sources: number;
		}[]
	>`
		select
			g.signal_id,
			g.label,
			g.state::text as state,
			g.confidence,
			g.first_seen_at,
			g.last_seen_at,
			cardinality(g.story_ids) as evidence_stories,
			(
				select count(distinct n.source_name)::int
				from story_ledger s
				join lateral unnest(s.source_item_ids) as t(item_id) on true
				join normalized_items n on n.lineage = s.lineage and n.item_id = t.item_id
				where s.lineage = g.lineage and s.story_id = any(g.story_ids)
			) as evidence_sources
		from emerging_signals g
		where g.lineage = ${lineage}
		order by g.last_seen_at desc
	`;
	return rows.map((r) => {
		const firstSeenAt = new Date(r.first_seen_at).toISOString();
		const lastSeenAt = new Date(r.last_seen_at).toISOString();
		return {
			signalId: r.signal_id,
			label: r.label,
			state: r.state,
			confidence: r.confidence,
			firstSeenAt,
			lastSeenAt,
			daySpan: daySpan(firstSeenAt, lastSeenAt),
			evidenceStories: r.evidence_stories ?? 0,
			evidenceSources: r.evidence_sources ?? 0,
		};
	});
}

/**
 * The five stage lookups for one expected-but-missing story.
 *
 * `pattern` is a single distinctive word or phrase from the title the owner
 * wrote down, matched case-insensitively. It is passed as a bound parameter and
 * wrapped here rather than by the caller, so a pattern containing `%` narrows
 * the search instead of being interpolated into the SQL.
 */
export async function fetchStageHits(
	sql: Sql,
	lineage: string,
	date: string,
	pattern: string,
): Promise<StageHits> {
	const like = `%${pattern.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

	const items = await sql<
		{ item_id: string; source_name: string; title: string; published_at: string | null }[]
	>`
		select item_id, source_name, title, published_at
		from normalized_items
		where lineage = ${lineage} and (title ilike ${like} or url ilike ${like})
		order by published_at desc nulls last
		limit 25
	`;
	const itemIds = items.map((i) => i.item_id);

	const decisions = itemIds.length
		? await sql<{ item_id: string; disposition: string; story_id: string | null; reason: string }[]>`
			select item_id, disposition, story_id, reason
			from item_decisions
			where lineage = ${lineage} and date = ${date} and item_id in ${sql(itemIds)}
		`
		: [];

	const candidates = await sql<
		{ story_id: string; canonical_title: string; relevance: number; reason: string }[]
	>`
		select story_id, canonical_title, relevance, reason
		from story_ledger
		where lineage = ${lineage} and date = ${date} and canonical_title ilike ${like}
	`;

	const materials = await sql<{ story_id: string; tier: string; canonical_title: string }[]>`
		select story_id, tier, canonical_title
		from daily_material_stories
		where lineage = ${lineage} and date = ${date} and canonical_title ilike ${like}
	`;

	const finals = await sql<{ story_id: string; section: string; must_know: boolean; title: string }[]>`
		select story_id, section, must_know, title
		from daily_brief_stories
		where lineage = ${lineage} and date = ${date} and title ilike ${like}
	`;

	return {
		items: items.map((i) => ({
			itemId: i.item_id,
			sourceName: i.source_name,
			title: i.title,
			publishedAt: i.published_at ?? null,
		})),
		decisions: decisions.map((d) => ({
			itemId: d.item_id,
			disposition: d.disposition,
			storyId: d.story_id,
			reason: d.reason,
		})),
		candidates: candidates.map((c) => ({
			storyId: c.story_id,
			canonicalTitle: c.canonical_title,
			relevance: c.relevance,
			reason: c.reason,
		})),
		materials: materials.map((m) => ({
			storyId: m.story_id,
			tier: m.tier,
			canonicalTitle: m.canonical_title,
		})),
		finals: finals.map((f) => ({
			storyId: f.story_id,
			section: f.section,
			mustKnow: f.must_know,
			title: f.title,
		})),
	};
}

/**
 * Triage predictions joined to what actually happened to each item.
 *
 * The join is deliberately left-outer from `item_triage`: an item that was
 * predicted and never decided (an incomplete scan) has to show up as undecided
 * rather than silently vanish, because a filter evaluated only against items
 * the Curator got to would flatter itself on exactly the days it mattered most.
 */
/**
 * The triage passes that hold predictions for these dates, newest-written first.
 *
 * Since migration 011 an item can carry one row per pass -- the deterministic
 * rules and a model pass, side by side -- so every triage query has to name the
 * pass it means. One that does not counts each item once per pass, which is not
 * a recall figure for anything.
 */
export async function fetchTriageVersions(
	sql: Sql,
	lineage: string,
	dates: readonly string[],
): Promise<string[]> {
	if (dates.length === 0) return [];
	const rows = await sql<{ rules_version: string }[]>`
		select rules_version, max(created_at) as latest
		from item_triage
		where lineage = ${lineage} and date = any(${sql.array([...dates])})
		group by rules_version
		order by latest desc
	`;
	return rows.map((r) => r.rules_version);
}

export async function fetchTriageOutcomes(
	sql: Sql,
	lineage: string,
	date: string,
	rulesVersion: string,
): Promise<TriageOutcomeRow[]> {
	const rows = await sql<
		{
			item_id: string;
			category: string;
			disposition: string | null;
			story_id: string | null;
			reached_material: boolean;
			reached_final: boolean;
			reached_must_know: boolean;
		}[]
	>`
		select
			t.item_id,
			t.category,
			d.disposition,
			d.story_id,
			(m.story_id is not null) as reached_material,
			(b.story_id is not null) as reached_final,
			coalesce(b.must_know, false) as reached_must_know
		from item_triage t
		left join item_decisions d
			on d.lineage = t.lineage and d.date = t.date and d.item_id = t.item_id
		left join daily_material_stories m
			on m.lineage = t.lineage and m.date = t.date and m.story_id = d.story_id
		left join daily_brief_stories b
			on b.lineage = t.lineage and b.date = t.date and b.story_id = d.story_id
		where t.lineage = ${lineage} and t.date = ${date}
		  and t.rules_version = ${rulesVersion}
	`;
	return rows.map((r) => ({
		itemId: r.item_id,
		category: r.category,
		disposition: r.disposition,
		storyId: r.story_id,
		reachedMaterial: r.reached_material,
		reachedFinal: r.reached_final,
		reachedMustKnow: r.reached_must_know,
	}));
}

/* -------------------------------------------------------------------------- */
/* Screening (item_screening)                                                  */
/* -------------------------------------------------------------------------- */

/** The screener versions holding verdicts on these dates, newest-written first. */
export async function fetchScreeningVersions(
	sql: Sql,
	lineage: string,
	dates: readonly string[],
): Promise<Array<{ provider: string; model: string; policyVersion: string }>> {
	if (dates.length === 0) return [];
	const rows = await sql<{ provider: string; model: string; policy_version: string }[]>`
		select provider, model, policy_version, max(created_at) as latest
		from item_screening
		where lineage = ${lineage} and date = any(${sql.array([...dates])})
		group by provider, model, policy_version
		order by latest desc
	`;
	return rows.map((r) => ({ provider: r.provider, model: r.model, policyVersion: r.policy_version }));
}

/**
 * Screening verdicts joined to each item's downstream fate, for one screener
 * version on one day. Left-outer from item_screening: a withheld DROP has no
 * decision by design, and an offered item with no decision is an incomplete
 * scan; both must survive the join to be counted for what they are.
 */
export async function fetchScreeningOutcomes(
	sql: Sql,
	lineage: string,
	date: string,
	version: { model: string; policyVersion: string },
): Promise<ScreeningOutcomeRow[]> {
	const rows = await sql<
		{
			item_id: string;
			verdict: "DROP" | "KEEP" | "UNSURE";
			audit_sampled: boolean;
			routed: boolean;
			disposition: string | null;
			story_id: string | null;
			reached_material: boolean;
			reached_final: boolean;
			reached_must_know: boolean;
		}[]
	>`
		select
			s.item_id,
			s.verdict,
			s.audit_sampled,
			s.routed,
			d.disposition,
			d.story_id,
			(m.story_id is not null) as reached_material,
			(b.story_id is not null) as reached_final,
			coalesce(b.must_know, false) as reached_must_know
		from item_screening s
		left join item_decisions d
			on d.lineage = s.lineage and d.date = s.date and d.item_id = s.item_id
		left join daily_material_stories m
			on m.lineage = s.lineage and m.date = s.date and m.story_id = d.story_id
		left join daily_brief_stories b
			on b.lineage = s.lineage and b.date = s.date and b.story_id = d.story_id
		where s.lineage = ${lineage} and s.date = ${date}
		  and s.model = ${version.model} and s.policy_version = ${version.policyVersion}
	`;
	return rows.map((r) => ({
		itemId: r.item_id,
		verdict: r.verdict,
		auditSampled: r.audit_sampled,
		routed: r.routed,
		disposition: r.disposition,
		storyId: r.story_id,
		reachedMaterial: r.reached_material,
		reachedFinal: r.reached_final,
		reachedMustKnow: r.reached_must_know,
	}));
}

/**
 * Per-stage wall clock and provider-reported usage over the runs of these
 * days. `reported` counts the attempts that carried a usage block, so a stage
 * whose provider reports nothing shows tokens 0 with reported 0 -- which the
 * renderer prints as unavailable, never as a measured zero.
 */
export async function fetchStageUsage(
	sql: Sql,
	lineage: string,
	dates: readonly string[],
): Promise<StageUsage[]> {
	if (dates.length === 0) return [];
	const rows = await sql<
		{
			stage: string;
			attempts: number;
			reported: number;
			input: string;
			output: string;
			cache_read: string;
			cache_write: string;
			total_tokens: string;
			wall_clock_ms: string;
		}[]
	>`
		select
			a.stage,
			count(*)::int as attempts,
			count(a.token_usage)::int as reported,
			coalesce(sum((a.token_usage->>'input')::bigint), 0)::text as input,
			coalesce(sum((a.token_usage->>'output')::bigint), 0)::text as output,
			coalesce(sum((a.token_usage->>'cacheRead')::bigint), 0)::text as cache_read,
			coalesce(sum((a.token_usage->>'cacheWrite')::bigint), 0)::text as cache_write,
			coalesce(sum((a.token_usage->>'totalTokens')::bigint), 0)::text as total_tokens,
			coalesce(sum(a.duration_ms), 0)::text as wall_clock_ms
		from agent_attempts a
		join daily_runs r on r.run_id = a.run_id
		where r.lineage = ${lineage} and r.date = any(${sql.array([...dates])})
		group by a.stage
		order by a.stage
	`;
	return rows.map((r) => ({
		stage: r.stage,
		attempts: r.attempts,
		reported: r.reported,
		input: Number(r.input),
		output: Number(r.output),
		cacheRead: Number(r.cache_read),
		cacheWrite: Number(r.cache_write),
		totalTokens: Number(r.total_tokens),
		wallClockMs: Number(r.wall_clock_ms),
	}));
}
