import type { CollectedItem } from "../collectors/types.ts";
import type { NormalizedItem } from "../schemas/item.ts";
import { jsonParam, type Sql } from "./client.ts";

/*
 * Passed as a bind parameter rather than inlined: `sql.unsafe(query, params)`
 * hands jsonb back as raw text, so every read that returns a jsonb column has
 * to go through a tagged template.
 */
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export interface RawItemRef {
	rawItemId: number;
	sourceType: string;
	externalId: string;
	inserted: boolean;
}

/**
 * Append-only ingest. UNIQUE(source_type, external_id) makes a re-collection of
 * the same window a no-op, so a collector may be re-run without duplicating.
 */
export async function upsertRawItems(
	sql: Sql,
	items: readonly CollectedItem[],
	collectionRunId?: string,
): Promise<RawItemRef[]> {
	const out: RawItemRef[] = [];
	if (items.length === 0) return out;
	await sql.begin(async (tx) => {
		for (const item of items) {
			const rows = await tx.unsafe<{ raw_item_id: string; inserted: boolean }[]>(
				`with ins as (
					insert into raw_items (collection_run_id, source_type, source_name, external_id, body, fetched_at)
					values ($1,$2,$3,$4,$5::jsonb,$6::timestamptz)
					on conflict (source_type, external_id) do nothing
					returning raw_item_id
				)
				select raw_item_id::text as raw_item_id, true as inserted from ins
				union all
				select raw_item_id::text, false from raw_items
				where source_type = $2 and external_id = $4 and not exists (select 1 from ins)`,
				[
					collectionRunId ?? null,
					item.sourceType,
					item.sourceName,
					item.raw.externalId,
					jsonParam(sql, item.raw.body ?? null),
					item.raw.fetchedAt,
				],
			);
			const row = rows[0];
			if (!row) continue;
			out.push({
				rawItemId: Number(row.raw_item_id),
				sourceType: item.sourceType,
				externalId: item.raw.externalId,
				inserted: row.inserted,
			});
		}
	});
	return out;
}

export async function countRawItems(sql: Sql): Promise<number> {
	const rows = await sql<{ n: string }[]>`select count(*)::text as n from raw_items`;
	return Number(rows[0]?.n ?? 0);
}

export interface NormalizedItemWrite extends NormalizedItem {
	rawItemId?: number;
	/** Candidate-retrieval vector only; see the column comment in 001_init.sql. */
	embedding?: readonly number[];
}

export async function upsertNormalizedItems(
	sql: Sql,
	lineage: string,
	items: readonly NormalizedItemWrite[],
): Promise<void> {
	if (items.length === 0) return;
	await sql.begin(async (tx) => {
		for (const item of items) {
			await tx.unsafe(
				`insert into normalized_items (lineage, item_id, raw_item_id, source_type, source_name,
					title, summary, content, url, published_at, metadata, embedding)
				 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::jsonb,$12::vector)
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
					lineage, item.id, item.rawItemId ?? null, item.sourceType, item.sourceName,
					item.title, item.summary, item.content ?? null, item.url ?? null,
					item.publishedAt, jsonParam(sql, item.metadata ?? {}),
					item.embedding ? `[${item.embedding.join(",")}]` : null,
				],
			);
		}
	});
}

export async function getNormalizedItem(
	sql: Sql,
	lineage: string,
	itemId: string,
): Promise<NormalizedItem | undefined> {
	const rows = await sql<
		{
			item_id: string; source_type: string; source_name: string; title: string;
			summary: string; content: string | null; url: string | null;
			published_at: string; metadata: Record<string, unknown>;
		}[]
	>`
		select item_id, source_type, source_name, title, summary, content, url,
			to_char(published_at at time zone 'utc', ${ISO}) as published_at, metadata
		from normalized_items where lineage = ${lineage} and item_id = ${itemId}
	`;
	const r = rows[0];
	if (!r) return undefined;
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

interface ItemRow {
	item_id: string; source_type: string; source_name: string; title: string;
	summary: string; content: string | null; url: string | null;
	published_at: string; metadata: Record<string, unknown>;
}

function toItem(r: ItemRow): NormalizedItem {
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
