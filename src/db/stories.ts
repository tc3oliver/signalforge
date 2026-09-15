import type { StoryLedgerEntry, StoryUpsertPayload } from "../schemas/story.ts";
import type { ItemDecision } from "../schemas/decision.ts";
import type { Sql } from "./client.ts";

/** Postgres renders timestamptz in its own format; the ledger speaks ISO-8601. */
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

interface LedgerRow {
	story_id: string;
	date: string;
	canonical_title: string;
	source_item_ids: string[];
	primary_source_ids: string[];
	fact_refs: string[];
	topic_ids: string[];
	first_seen_at: string;
	last_seen_at: string;
	status: string;
	change_type: string;
	relevance: number;
	novelty: number;
	importance: number;
	confidence: number;
	reason: string;
}

function toEntry(row: LedgerRow): StoryLedgerEntry {
	return {
		storyId: row.story_id,
		date: row.date,
		canonicalTitle: row.canonical_title,
		sourceItemIds: row.source_item_ids,
		primarySourceIds: row.primary_source_ids,
		factRefs: row.fact_refs,
		topicIds: row.topic_ids,
		firstSeenAt: row.first_seen_at,
		lastSeenAt: row.last_seen_at,
		status: row.status as StoryLedgerEntry["status"],
		changeType: row.change_type as StoryLedgerEntry["changeType"],
		relevance: row.relevance,
		novelty: row.novelty,
		importance: row.importance,
		confidence: row.confidence,
		reason: row.reason,
	};
}

const COLUMNS = (alias: string): string =>
	`${alias}.story_id, ${alias}.date, ${alias}.canonical_title, ${alias}.source_item_ids,
	 ${alias}.primary_source_ids, ${alias}.fact_refs, ${alias}.topic_ids,
	 to_char(${alias}.first_seen_at at time zone 'utc', ${ISO}) as first_seen_at,
	 to_char(${alias}.last_seen_at at time zone 'utc', ${ISO}) as last_seen_at,
	 ${alias}.status, ${alias}.change_type, ${alias}.relevance, ${alias}.novelty,
	 ${alias}.importance, ${alias}.confidence, ${alias}.reason`;

export async function getLatestStory(
	sql: Sql,
	lineage: string,
	storyId: string,
): Promise<StoryLedgerEntry | undefined> {
	const rows = await sql.unsafe<LedgerRow[]>(
		`select ${COLUMNS("s")} from story_ledger s
		 where s.lineage = $1 and s.story_id = $2
		 order by s.date desc limit 1`,
		[lineage, storyId],
	);
	const row = rows[0];
	return row ? toEntry(row) : undefined;
}

export async function listStoriesForDate(
	sql: Sql,
	lineage: string,
	date: string,
): Promise<StoryLedgerEntry[]> {
	const rows = await sql.unsafe<LedgerRow[]>(
		`select ${COLUMNS("s")} from story_ledger s
		 where s.lineage = $1 and s.date = $2
		 order by s.ordinal`,
		[lineage, date],
	);
	return rows.map(toEntry);
}

/**
 * Merge-on-conflict for (lineage, story_id, date). A first write on a later
 * date inherits firstSeenAt from the earliest prior date the story appeared on,
 * which is what gives a story cross-day continuity.
 *
 * The same statement rewrites this story's `story_items` rows. That table is
 * the canonical story-to-item relation -- the web story page reads roles from
 * it -- and until now nothing but the dev seeder ever wrote there, so in
 * production the role display was always empty. Doing it here, in the one
 * statement that writes the ledger, is what makes the two impossible to
 * disagree by half a pass: Postgres applies every data-modifying CTE of a
 * statement atomically, so there is no window where a story exists without its
 * items.
 *
 * The rows mirror this pass's input, not the merged arrays on the ledger. The
 * arrays union across a day's passes and never shrink, which is right for a
 * cache of everything the story has ever cited; the relation answers "which
 * items does this story cite now", so an item the curator dropped on a later
 * pass is deleted rather than left behind, and an item demoted out of
 * `primarySourceIds` comes back as SUPPORTING.
 */
export async function upsertStoryRow(
	sql: Sql,
	lineage: string,
	date: string,
	input: StoryUpsertPayload,
	nowIso: string,
): Promise<StoryLedgerEntry> {
	const rows = await sql.unsafe<LedgerRow[]>(
		`with upserted as (
			insert into story_ledger (
				lineage, story_id, date, canonical_title, source_item_ids, primary_source_ids,
				fact_refs, topic_ids, first_seen_at, last_seen_at, status, change_type,
				relevance, novelty, importance, confidence, reason
			) values (
				$1, $2, $3, $4, $5::text[], $6::text[], $7::text[], $16::text[],
				coalesce(
					(select p.first_seen_at from story_ledger p
					 where p.lineage = $1 and p.story_id = $2 and p.date < $3
					 order by p.date asc limit 1),
					$8::timestamptz
				),
				$8::timestamptz, $9, $10, $11, $12, $13, $14, $15
			)
			on conflict (lineage, story_id, date) do update set
				canonical_title    = excluded.canonical_title,
				source_item_ids    = array_union_ordered(story_ledger.source_item_ids, excluded.source_item_ids),
				primary_source_ids = array_union_ordered(story_ledger.primary_source_ids, excluded.primary_source_ids),
				fact_refs          = array_union_ordered(story_ledger.fact_refs, excluded.fact_refs),
				/*
				 * Replaced, not unioned, unlike the id arrays above. Those are a
				 * cache of everything a story ever cited; this is what the curator
				 * says the story is about now. A story that stops matching a topic
				 * -- because the reader reweighted, or because the story moved on --
				 * must be able to lose it, or the field only ever grows and stops
				 * meaning anything.
				 */
				topic_ids          = excluded.topic_ids,
				status             = excluded.status,
				change_type        = excluded.change_type,
				relevance          = excluded.relevance,
				novelty            = excluded.novelty,
				importance         = excluded.importance,
				confidence         = excluded.confidence,
				reason             = excluded.reason,
				last_seen_at       = excluded.last_seen_at,
				updated_at         = now()
			returning *
		),
		/*
		 * A primary id that the curator left out of sourceItemIds would otherwise
		 * have no row at all, so the item set is the union of both arrays rather
		 * than sourceItemIds alone. The distinct collapses the duplicate an id
		 * present in both produces; both copies carry the same PRIMARY role.
		 */
		desired as (
			select distinct t.item_id,
				case when t.item_id = any($6::text[]) then 'PRIMARY' else 'SUPPORTING' end as role
			from unnest($5::text[] || $6::text[]) as t(item_id)
		),
		pruned as (
			delete from story_items si
			using upserted u
			where si.lineage = u.lineage and si.story_id = u.story_id and si.date = u.date
			  and si.item_id not in (select d.item_id from desired d)
		),
		written as (
			insert into story_items (lineage, story_id, date, item_id, role)
			select u.lineage, u.story_id, u.date, d.item_id, d.role
			from upserted u cross join desired d
			on conflict (lineage, story_id, date, item_id) do update set role = excluded.role
		)
		select ${COLUMNS("s")} from upserted s`,
		[
			lineage,
			input.storyId,
			date,
			input.canonicalTitle,
			input.sourceItemIds,
			input.primarySourceIds,
			input.factRefs ?? [],
			nowIso,
			input.status,
			input.changeType,
			input.relevance,
			input.novelty,
			input.importance,
			input.confidence,
			input.reason,
			input.topicIds ?? [],
		],
	);
	const row = rows[0];
	if (!row) throw new Error("story upsert returned no row");
	return toEntry(row);
}

export async function findStoryById(
	sql: Sql,
	lineage: string,
	storyId: string,
	beforeDate: string,
	limit: number,
): Promise<StoryLedgerEntry[]> {
	const rows = await sql.unsafe<LedgerRow[]>(
		`select ${COLUMNS("s")} from story_ledger s
		 where s.lineage = $1 and s.story_id = $2 and s.date < $3
		 order by s.date desc, s.ordinal
		 limit $4`,
		[lineage, storyId, beforeDate, limit],
	);
	return rows.map(toEntry);
}

/**
 * Token-overlap search, scored in SQL with the same tokenisation the
 * file-backed ledger uses so ranking and tie-breaks match exactly: score
 * descending, then newest date, then write order within a date.
 */
export async function findStoriesByTokens(
	sql: Sql,
	lineage: string,
	tokens: readonly string[],
	beforeDate: string,
	limit: number,
): Promise<StoryLedgerEntry[]> {
	const rows = await sql.unsafe<LedgerRow[]>(
		`with scored as (
			select s.*, (
				select count(*) from unnest($2::text[]) q
				where q = any(ledger_tokens(s.canonical_title || ' ' || s.reason))
			)::float8 / array_length($2::text[], 1) as score
			from story_ledger s
			where s.lineage = $1 and s.date < $3
		)
		select ${COLUMNS("s")} from scored s
		where s.score > 0
		order by s.score desc, s.date desc, s.ordinal
		limit $4`,
		[lineage, tokens as string[], beforeDate, limit],
	);
	return rows.map(toEntry);
}

/* -------------------------------------------------------------------------- */
/* Decisions                                                                  */
/* -------------------------------------------------------------------------- */

interface DecisionRow {
	item_id: string;
	disposition: string;
	story_id: string | null;
	reason: string;
	decided_at: string;
}

function toDecision(row: DecisionRow): ItemDecision {
	return {
		itemId: row.item_id,
		disposition: row.disposition as ItemDecision["disposition"],
		...(row.story_id === null ? {} : { storyId: row.story_id }),
		reason: row.reason,
		decidedAt: row.decided_at,
	};
}

const DECISION_COLUMNS = `item_id, disposition, story_id, reason,
	to_char(decided_at at time zone 'utc', ${ISO}) as decided_at`;

/** Idempotent per (lineage, date, itemId): a re-record replaces in place. */
export async function upsertDecisions(
	sql: Sql,
	lineage: string,
	date: string,
	decisions: readonly ItemDecision[],
	runId?: string,
): Promise<void> {
	if (decisions.length === 0) return;
	await sql.begin(async (tx) => {
		for (const d of decisions) {
			await tx.unsafe(
				`insert into item_decisions (lineage, date, item_id, run_id, disposition, story_id, reason, decided_at)
				 values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
				 on conflict (lineage, date, item_id) do update set
					run_id      = excluded.run_id,
					disposition = excluded.disposition,
					story_id    = excluded.story_id,
					reason      = excluded.reason,
					decided_at  = excluded.decided_at,
					updated_at  = now()`,
				[lineage, date, d.itemId, runId ?? null, d.disposition, d.storyId ?? null, d.reason, d.decidedAt],
			);
		}
	});
}

export async function listDecisionsForDate(
	sql: Sql,
	lineage: string,
	date: string,
): Promise<ItemDecision[]> {
	const rows = await sql.unsafe<DecisionRow[]>(
		`select ${DECISION_COLUMNS} from item_decisions
		 where lineage = $1 and date = $2 order by ordinal`,
		[lineage, date],
	);
	return rows.map(toDecision);
}

export async function processedItemIdsForDate(
	sql: Sql,
	lineage: string,
	date: string,
): Promise<Set<string>> {
	const rows = await sql<{ item_id: string }[]>`
		select item_id from item_decisions where lineage = ${lineage} and date = ${date}
	`;
	return new Set(rows.map((r) => r.item_id));
}

/* -------------------------------------------------------------------------- */
/* Read-only projections for the web reader (additive).                        */
/* -------------------------------------------------------------------------- */

/**
 * Every ledger row for a story, oldest first. This is the story's evolution:
 * one row per day it was touched, carrying that day's change type and scores.
 */
export async function listStoryTimeline(
	sql: Sql,
	lineage: string,
	storyId: string,
): Promise<StoryLedgerEntry[]> {
	const rows = await sql.unsafe<LedgerRow[]>(
		`select ${COLUMNS("s")} from story_ledger s
		 where s.lineage = $1 and s.story_id = $2
		 order by s.date asc, s.ordinal`,
		[lineage, storyId],
	);
	return rows.map(toEntry);
}

export interface RelatedStory {
	entry: StoryLedgerEntry;
	/** Number of source items this story shares with the subject story. */
	sharedItemCount: number;
	/** Fraction of the subject's title/reason tokens this story also uses. */
	tokenOverlap: number;
}

/**
 * Relatedness with a stated rule rather than an opaque score: shared source
 * items first (two stories citing the same item are provably connected), then
 * token overlap on the canonical title and reason, using the same tokeniser
 * the ledger's own history search uses.
 */
export async function findRelatedStories(
	sql: Sql,
	lineage: string,
	storyId: string,
	limit = 8,
): Promise<RelatedStory[]> {
	const rows = await sql.unsafe<(LedgerRow & { shared_item_count: string; token_overlap: number })[]>(
		`with subject as (
			select s.* from story_ledger s
			where s.lineage = $1 and s.story_id = $2
			order by s.date desc limit 1
		),
		latest as (
			select distinct on (s.story_id) s.*
			from story_ledger s
			where s.lineage = $1 and s.story_id <> $2
			order by s.story_id, s.date desc, s.ordinal desc
		),
		subject_shape as (
			select s.source_item_ids as item_ids,
				ledger_tokens(s.canonical_title || ' ' || s.reason) as tokens
			from subject s
		),
		scored as (
			select l.*,
				(select count(*) from unnest(l.source_item_ids) v
				 where v = any(sub.item_ids)) as shared_item_count,
				(
					select count(*)::float8 from unnest(sub.tokens) q
					where q <> '' and q = any(ledger_tokens(l.canonical_title || ' ' || l.reason))
				) / greatest(array_length(sub.tokens, 1), 1) as token_overlap
			from latest l cross join subject_shape sub
		)
		select ${COLUMNS("s")}, s.shared_item_count::text as shared_item_count, s.token_overlap
		from scored s
		where s.shared_item_count > 0 or s.token_overlap > 0.15
		order by s.shared_item_count desc, s.token_overlap desc, s.date desc
		limit $3`,
		[lineage, storyId, limit],
	);
	return rows.map((r) => ({
		entry: toEntry(r),
		sharedItemCount: Number(r.shared_item_count),
		tokenOverlap: r.token_overlap,
	}));
}

export interface DatedItemDecision extends ItemDecision {
	date: string;
	runId: string | undefined;
}

/** Every decision ever recorded about an item, newest date first. */
export async function listDecisionsForItem(
	sql: Sql,
	lineage: string,
	itemId: string,
): Promise<DatedItemDecision[]> {
	const rows = await sql.unsafe<(DecisionRow & { date: string; run_id: string | null })[]>(
		`select ${DECISION_COLUMNS}, date, run_id from item_decisions
		 where lineage = $1 and item_id = $2 order by date desc`,
		[lineage, itemId],
	);
	return rows.map((r) => ({
		...toDecision(r),
		date: r.date,
		runId: r.run_id ?? undefined,
	}));
}

/** Item ids a story cites on a given date, with their PRIMARY/SUPPORTING role. */
export async function listStoryItemRoles(
	sql: Sql,
	lineage: string,
	storyId: string,
	date: string,
): Promise<Array<{ itemId: string; role: "PRIMARY" | "SUPPORTING" }>> {
	const rows = await sql<{ item_id: string; role: string }[]>`
		select item_id, role from story_items
		where lineage = ${lineage} and story_id = ${storyId} and date = ${date}
		order by role, item_id
	`;
	return rows.map((r) => ({ itemId: r.item_id, role: r.role as "PRIMARY" | "SUPPORTING" }));
}

/**
 * The current title of each of several stories, in one query. The reader lists
 * signals and needs a title per referenced story; one `getLatestStory` per id
 * is the same answer at N round trips.
 */
export async function latestStoryTitles(
	sql: Sql,
	lineage: string,
	storyIds: readonly string[],
): Promise<Map<string, string>> {
	if (storyIds.length === 0) return new Map();
	const rows = await sql.unsafe<{ story_id: string; canonical_title: string }[]>(
		`select distinct on (s.story_id) s.story_id, s.canonical_title
		 from story_ledger s
		 where s.lineage = $1 and s.story_id = any($2::text[])
		 order by s.story_id, s.date desc`,
		[lineage, storyIds as string[]],
	);
	return new Map(rows.map((r) => [r.story_id, r.canonical_title] as const));
}
