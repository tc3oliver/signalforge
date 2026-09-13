/**
 * One-shot repair for Hacker News rows normalized before `htmlToText` existed.
 *
 * Those rows hold the provider's HTML verbatim in the agent-visible fields:
 * anchors, paragraphs, and every slash entity-encoded. Re-collecting does not
 * fix them, because the collector's cursor skips ids it has already seen, so
 * they would sit in the manifest looking like noise indefinitely.
 *
 * The repair reads `raw_items.body` -- the provider's untouched payload, kept
 * for exactly this -- and re-derives the normalized fields through the same
 * function the collector now uses. Nothing is invented and nothing is lost.
 *
 * Safe to run repeatedly: a row already in plain text re-derives to itself.
 */
import { createSql } from "../db/client.ts";
import { htmlToText, decodeHtmlEntities } from "../collectors/html-text.ts";
import { itemIdFor } from "../pipeline/collection.ts";

export interface RenormalizeResult {
	examined: number;
	updated: number;
}

export async function renormalizeHackerNews(
	sql: ReturnType<typeof createSql>,
	options: { dryRun?: boolean } = {},
): Promise<RenormalizeResult> {
	// The normalized id is a hash of the provider id, so the two tables cannot be
	// joined in SQL -- the mapping only exists in `itemIdFor`. Read the raw rows
	// and compute it here, which is also the only definition of that mapping.
	const raws = await sql<{ external_id: string; body: unknown }[]>`
		select external_id, body from raw_items where source_type = 'hackernews'
	`;
	const byItemId = new Map(
		raws.map((r) => [itemIdFor("hackernews", r.external_id), r.body] as const),
	);

	const rows = await sql<
		{ item_id: string; lineage: string; summary: string; content: string | null; title: string }[]
	>`
		select item_id, lineage, summary, content, title
		from normalized_items
		where source_type = 'hackernews'
			and (summary like '%&#%' or summary like '%<%' or title like '%&#%')
	`;

	let updated = 0;
	for (const row of rows) {
		const payload = byItemId.get(row.item_id) as { text?: unknown; title?: unknown } | null | undefined;
		const rawText = typeof payload?.text === "string" ? payload.text : undefined;
		const rawTitle = typeof payload?.title === "string" ? payload.title : undefined;

		const summary = rawText === undefined ? row.summary : htmlToText(rawText);
		const content = rawText === undefined ? row.content : htmlToText(rawText);
		const title = rawTitle === undefined ? row.title : decodeHtmlEntities(rawTitle).trim() || row.title;

		if (summary === row.summary && content === row.content && title === row.title) continue;
		updated += 1;
		if (options.dryRun) continue;

		await sql`
			update normalized_items
			set summary = ${summary}, content = ${content}, title = ${title}, updated_at = now()
			where lineage = ${row.lineage} and item_id = ${row.item_id}
		`;
	}

	return { examined: rows.length, updated };
}
