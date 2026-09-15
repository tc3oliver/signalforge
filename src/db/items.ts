import type { CollectedItem } from "../collectors/types.ts";
import type { NormalizedItem } from "../schemas/item.ts";
import { ISO, type Sql } from "./client.ts";

export interface RawItemRef {
	rawItemId: number;
	sourceType: string;
	externalId: string;
	inserted: boolean;
}

/**
 * How many rows go into one `unnest` statement. A collection run brings back
 * thousands of records, and one statement per record was thousands of round
 * trips inside a single transaction; a bounded chunk keeps the parameter arrays
 * small enough for the write to stay predictable.
 */
const CHUNK = 500;

function chunked<T>(items: readonly T[], size = CHUNK): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/** `source_type` is a closed enum with no colon in it, so this key is unambiguous. */
const refKey = (sourceType: string, externalId: string): string => `${sourceType}::${externalId}`;

/**
 * Lock order. A multi-row insert takes its speculative-insertion locks in the
 * order the rows appear in the statement, so two writers whose batches overlap
 * in different input orders can deadlock on each other — a risk the previous
 * one-row-per-statement loop did not carry at this width. Sorting every batch by
 * its conflict key before it is chunked makes any two writers acquire the same
 * locks in the same order, so one simply waits.
 *
 * The caller's `RawItemRef[]` contract is unaffected: refs are rebuilt from the
 * original `items` array, not from the sorted copy.
 */
function sortedByKey<T>(items: readonly T[], key: (item: T) => string): T[] {
	return [...items].sort((a, b) => {
		const ka = key(a);
		const kb = key(b);
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});
}

/**
 * Append-only ingest. UNIQUE(source_type, external_id) makes a re-collection of
 * the same window a no-op, so a collector may be re-run without duplicating.
 *
 * Written in chunks through `unnest`. The insert returns the rows it actually
 * created and one follow-up select resolves the ids of the rows that conflicted,
 * which is the distinction the `inserted` flag on each ref carries.
 */
export async function upsertRawItems(
	sql: Sql,
	items: readonly CollectedItem[],
	collectionRunId?: string,
): Promise<RawItemRef[]> {
	if (items.length === 0) return [];
	const resolved = new Map<string, { rawItemId: number; inserted: boolean }>();
	await sql.begin(async (tx) => {
		for (const chunk of chunked(sortedByKey(items, (i) => refKey(i.sourceType, i.raw.externalId)))) {
			const inserted = await tx.unsafe<
				{ raw_item_id: string; source_type: string; external_id: string }[]
			>(
				`insert into raw_items (collection_run_id, source_type, source_name, external_id, body, fetched_at)
				 select $1::text, t.source_type, t.source_name, t.external_id, t.body::jsonb, t.fetched_at
				 from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::timestamptz[])
					as t(source_type, source_name, external_id, body, fetched_at)
				 on conflict (source_type, external_id) do nothing
				 returning raw_item_id::text as raw_item_id, source_type, external_id`,
				[
					collectionRunId ?? null,
					chunk.map((i) => i.sourceType),
					chunk.map((i) => i.sourceName),
					chunk.map((i) => i.raw.externalId),
					chunk.map((i) => JSON.stringify(i.raw.body ?? null)),
					chunk.map((i) => i.raw.fetchedAt),
				],
			);
			for (const row of inserted) {
				resolved.set(refKey(row.source_type, row.external_id), {
					rawItemId: Number(row.raw_item_id),
					inserted: true,
				});
			}
			const missing = chunk.filter((i) => !resolved.has(refKey(i.sourceType, i.raw.externalId)));
			if (missing.length === 0) continue;
			const existing = await tx.unsafe<
				{ raw_item_id: string; source_type: string; external_id: string }[]
			>(
				`select r.raw_item_id::text as raw_item_id, r.source_type, r.external_id
				 from raw_items r
				 join unnest($1::text[], $2::text[]) as t(source_type, external_id)
					on t.source_type = r.source_type and t.external_id = r.external_id`,
				[missing.map((i) => i.sourceType), missing.map((i) => i.raw.externalId)],
			);
			for (const row of existing) {
				resolved.set(refKey(row.source_type, row.external_id), {
					rawItemId: Number(row.raw_item_id),
					inserted: false,
				});
			}
		}
	});

	const out: RawItemRef[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		const key = refKey(item.sourceType, item.raw.externalId);
		const row = resolved.get(key);
		if (!row) continue;
		out.push({
			rawItemId: row.rawItemId,
			sourceType: item.sourceType,
			externalId: item.raw.externalId,
			// The same record twice in one batch is stored once, so only its first
			// occurrence can claim to have created the row.
			inserted: row.inserted && !seen.has(key),
		});
		seen.add(key);
	}
	return out;
}

/**
 * Count raw items, optionally only those whose external id starts with `prefix`.
 *
 * The prefix is not optional in practice. This is used by the integration
 * suites, which run in parallel against one database, and an unscoped count is
 * a reading of shared state: a suite that inserts 1200 rows and asserts
 * `before + 1200` is asserting that no other suite wrote or deleted a raw item
 * in between. That held only for as long as nothing deleted raw items, and it
 * stopped holding the moment the lineage purge started cleaning them up.
 */
export async function countRawItems(sql: Sql, prefix?: string): Promise<number> {
	const rows =
		prefix === undefined
			? await sql<{ n: string }[]>`select count(*)::text as n from raw_items`
			: await sql<{ n: string }[]>`select count(*)::text as n from raw_items where external_id like ${`${prefix}%`}`;
	return Number(rows[0]?.n ?? 0);
}

export interface NormalizedItemWrite extends NormalizedItem {
	rawItemId?: number;
	/** Candidate-retrieval vector only; see the column comment in 001_init.sql. */
	embedding?: readonly number[];
}

/**
 * Chunked `unnest` upsert. `on conflict do update` may not touch the same row
 * twice in one statement, so an id repeated within the batch is collapsed to its
 * last occurrence first — which is exactly what the per-row loop did by
 * overwriting.
 */
export async function upsertNormalizedItems(
	sql: Sql,
	lineage: string,
	items: readonly NormalizedItemWrite[],
): Promise<void> {
	if (items.length === 0) return;
	const byId = new Map<string, NormalizedItemWrite>();
	for (const item of items) byId.set(item.id, item);
	const unique = sortedByKey([...byId.values()], (i) => i.id);
	await sql.begin(async (tx) => {
		for (const chunk of chunked(unique)) {
			await tx.unsafe(
				`insert into normalized_items (lineage, item_id, raw_item_id, source_type, source_name,
					title, summary, content, url, published_at, metadata, embedding)
				 select $1, t.item_id, t.raw_item_id, t.source_type, t.source_name, t.title, t.summary,
					t.content, t.url, t.published_at, t.metadata::jsonb, t.embedding::vector
				 from unnest($2::text[], $3::bigint[], $4::text[], $5::text[], $6::text[], $7::text[],
					$8::text[], $9::text[], $10::timestamptz[], $11::text[], $12::text[])
					as t(item_id, raw_item_id, source_type, source_name, title, summary, content, url,
						published_at, metadata, embedding)
				 on conflict (lineage, item_id) do update set
					raw_item_id = coalesce(excluded.raw_item_id, normalized_items.raw_item_id),
					source_type = excluded.source_type,
					source_name = excluded.source_name,
					title = excluded.title,
					summary = excluded.summary,
					content = excluded.content,
					url = excluded.url,
					published_at = excluded.published_at,
					metadata = excluded.metadata,
					embedding = coalesce(excluded.embedding, normalized_items.embedding),
					updated_at = now()`,
				[
					lineage,
					chunk.map((i) => i.id),
					chunk.map((i) => i.rawItemId ?? null),
					chunk.map((i) => i.sourceType),
					chunk.map((i) => i.sourceName),
					chunk.map((i) => i.title),
					chunk.map((i) => i.summary),
					chunk.map((i) => i.content ?? null),
					chunk.map((i) => i.url ?? null),
					chunk.map((i) => i.publishedAt),
					chunk.map((i) => JSON.stringify(i.metadata ?? {})),
					chunk.map((i) => (i.embedding ? `[${i.embedding.join(",")}]` : null)),
				],
			);
		}
	});
}

/** Lexical candidate search. The same-event call stays with the curator agent. */
export async function searchNormalizedItems(
	sql: Sql,
	lineage: string,
	text: string,
	limit = 20,
): Promise<Array<{ itemId: string; title: string; rank: number }>> {
	const rows = await sql<{ item_id: string; title: string; rank: number }[]>`
		select item_id, title, ts_rank(search, websearch_to_tsquery('simple', ${text})) as rank
		from normalized_items
		where lineage = ${lineage} and search @@ websearch_to_tsquery('simple', ${text})
		order by rank desc, published_at desc
		limit ${limit}
	`;
	return rows.map((r) => ({ itemId: r.item_id, title: r.title, rank: r.rank }));
}

/* -------------------------------------------------------------------------- */
/* Read-only projections for the web reader (additive).                        */
/* -------------------------------------------------------------------------- */

const ITEM_COLUMNS = `item_id, source_type, source_name, title, summary, content, url,
	to_char(published_at at time zone 'utc', ${ISO}) as published_at, metadata`;

export interface ItemRow {
	item_id: string; source_type: string; source_name: string; title: string;
	summary: string; content: string | null; url: string | null;
	published_at: string; metadata: Record<string, unknown>;
}

export function toItem(r: ItemRow): NormalizedItem {
	return {
		id: r.item_id,
		// Set here rather than stored: it has been true of every row in this table
		// since the column list was written, so a read cannot get it wrong and an
		// older row cannot lose it.
		trust: "UNTRUSTED_EXTERNAL_CONTENT",
		sourceType: r.source_type as NormalizedItem["sourceType"],
		sourceName: r.source_name,
		title: r.title,
		summary: r.summary,
		...(r.content === null ? {} : { content: r.content }),
		...(r.url === null ? {} : { url: r.url }),
		publishedAt: r.published_at,
		metadata: r.metadata,
	};
}

/**
 * Bulk sibling of getNormalizedItem. A story page resolves every source id it
 * lists, so the per-id round trip would be one query per link.
 */
export async function getNormalizedItems(
	sql: Sql,
	lineage: string,
	itemIds: readonly string[],
): Promise<NormalizedItem[]> {
	if (itemIds.length === 0) return [];
	const rows = await sql.unsafe<ItemRow[]>(
		`select ${ITEM_COLUMNS} from normalized_items
		 where lineage = $1 and item_id = any($2::text[])`,
		[lineage, itemIds as string[]],
	);
	return rows.map(toItem);
}

/**
 * Single-id read. It delegates rather than carrying a second copy of the column
 * list and the row mapping: the copy it used to carry had drifted, passing the
 * quoted `to_char` pattern as a bind parameter so the quotes landed in the
 * returned timestamp.
 */
export async function getNormalizedItem(
	sql: Sql,
	lineage: string,
	itemId: string,
): Promise<NormalizedItem | undefined> {
	const items = await getNormalizedItems(sql, lineage, [itemId]);
	return items[0];
}

export interface ItemProvenance {
	item: NormalizedItem;
	rawItemId: number | undefined;
	externalId: string | undefined;
	fetchedAt: string | undefined;
	collectionRunId: string | undefined;
	collectorId: string | undefined;
}

/** Item plus the collection that produced it; the first step of the item trace. */
export async function getItemProvenance(
	sql: Sql,
	lineage: string,
	itemId: string,
): Promise<ItemProvenance | undefined> {
	const rows = await sql.unsafe<
		(ItemRow & {
			raw_item_id: string | null; external_id: string | null; fetched_at: string | null;
			collection_run_id: string | null; collector_id: string | null;
		})[]
	>(
		`select n.item_id, n.source_type, n.source_name, n.title, n.summary, n.content, n.url,
			to_char(n.published_at at time zone 'utc', ${ISO}) as published_at, n.metadata,
			n.raw_item_id::text as raw_item_id, r.external_id,
			to_char(r.fetched_at at time zone 'utc', ${ISO}) as fetched_at,
			r.collection_run_id, c.collector_id
		 from normalized_items n
		 left join raw_items r on r.raw_item_id = n.raw_item_id
		 left join collection_runs c on c.collection_run_id = r.collection_run_id
		 where n.lineage = $1 and n.item_id = $2`,
		[lineage, itemId],
	);
	const r = rows[0];
	if (!r) return undefined;
	return {
		item: toItem(r),
		rawItemId: r.raw_item_id === null ? undefined : Number(r.raw_item_id),
		externalId: r.external_id ?? undefined,
		fetchedAt: r.fetched_at ?? undefined,
		collectionRunId: r.collection_run_id ?? undefined,
		collectorId: r.collector_id ?? undefined,
	};
}

export interface LateItem {
	itemId: string;
	title: string;
	summary: string;
	sourceName: string;
	sourceType: string;
	url: string | undefined;
	publishedAt: string;
	fetchedAt: string;
	disposition: string | undefined;
	storyId: string | undefined;
	importance: number | undefined;
	changeType: string | undefined;
}

/**
 * "New since morning": items whose provider bytes were fetched after the first
 * run of `date` was created. The run's creation time is the cut-off rather than
 * a wall-clock hour, so a late or re-run morning pass still classifies
 * correctly.
 *
 * What surfaces is what has not been ruled out: items with no decision yet
 * (they arrived after the curator scanned, which is the normal case here),
 * items it promoted, and items on a story above the importance floor. An item
 * already judged IRRELEVANT or DUPLICATE is excluded — the pipeline has looked
 * at it and said no, and repeating that on the front page would be noise.
 */
export async function listItemsFetchedAfterMorningRun(
	sql: Sql,
	lineage: string,
	date: string,
	minImportance = 0.6,
	limit = 20,
): Promise<LateItem[]> {
	const rows = await sql.unsafe<
		{
			item_id: string; title: string; summary: string; source_name: string;
			source_type: string; url: string | null; published_at: string; fetched_at: string;
			disposition: string | null; story_id: string | null; importance: number | null;
			change_type: string | null;
		}[]
	>(
		`with morning as (
			select min(created_at) as at from daily_runs where lineage = $1 and date = $2
		)
		select n.item_id, n.title, n.summary, n.source_name, n.source_type, n.url,
			to_char(n.published_at at time zone 'utc', ${ISO}) as published_at,
			to_char(r.fetched_at at time zone 'utc', ${ISO}) as fetched_at,
			d.disposition, d.story_id, sl.importance, sl.change_type
		 from normalized_items n
		 join raw_items r on r.raw_item_id = n.raw_item_id
		 cross join morning m
		 left join item_decisions d on d.lineage = n.lineage and d.date = $2 and d.item_id = n.item_id
		 left join story_ledger sl on sl.lineage = n.lineage and sl.date = $2 and sl.story_id = d.story_id
		 where n.lineage = $1 and m.at is not null and r.fetched_at > m.at
			and (d.disposition is null or d.disposition = 'CANDIDATE'
				or coalesce(sl.importance, 0) >= $3)
		 order by coalesce(sl.importance, 0) desc, r.fetched_at desc
		 limit $4`,
		[lineage, date, minImportance, limit],
	);
	return rows.map((r) => ({
		itemId: r.item_id,
		title: r.title,
		summary: r.summary,
		sourceName: r.source_name,
		sourceType: r.source_type,
		url: r.url ?? undefined,
		publishedAt: r.published_at,
		fetchedAt: r.fetched_at,
		disposition: r.disposition ?? undefined,
		storyId: r.story_id ?? undefined,
		importance: r.importance ?? undefined,
		changeType: r.change_type ?? undefined,
	}));
}
