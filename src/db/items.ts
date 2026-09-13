import type { CollectedItem } from "../collectors/types.ts";
import type { NormalizedItem } from "../schemas/item.ts";
import type { Sql } from "./client.ts";

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
					JSON.stringify(item.raw.body ?? null),
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
					item.publishedAt, JSON.stringify(item.metadata ?? {}),
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
	const rows = await sql.unsafe<
		{
			item_id: string; source_type: string; source_name: string; title: string;
			summary: string; content: string | null; url: string | null;
			published_at: string; metadata: Record<string, unknown>;
		}[]
	>(
		`select item_id, source_type, source_name, title, summary, content, url,
			to_char(published_at at time zone 'utc', ${ISO}) as published_at, metadata
		 from normalized_items where lineage = $1 and item_id = $2`,
		[lineage, itemId],
	);
	const r = rows[0];
	if (!r) return undefined;
	return {
		id: r.item_id,
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
