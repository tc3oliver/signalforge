import type { StoryLedgerEntry, StoryUpsertInput } from "../schemas/story.ts";
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
	 ${alias}.primary_source_ids, ${alias}.fact_refs,
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
 */
export async function upsertStoryRow(
	sql: Sql,
	lineage: string,
	date: string,
	input: StoryUpsertInput,
	nowIso: string,
): Promise<StoryLedgerEntry> {
	const rows = await sql.unsafe<LedgerRow[]>(
		`with upserted as (
			insert into story_ledger (
				lineage, story_id, date, canonical_title, source_item_ids, primary_source_ids,
				fact_refs, first_seen_at, last_seen_at, status, change_type,
				relevance, novelty, importance, confidence, reason
			) values (
				$1, $2, $3, $4, $5::text[], $6::text[], $7::text[],
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
