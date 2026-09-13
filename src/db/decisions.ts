import type { Sql } from "./client.ts";

export {
	listDecisionsForDate,
	processedItemIdsForDate,
	upsertDecisions,
} from "./stories.ts";

export interface ItemExplanation {
	itemId: string;
	title: string | undefined;
	/** Undefined means the item was never scanned — a coverage bug, not a verdict. */
	disposition: "IRRELEVANT" | "DUPLICATE" | "CANDIDATE" | undefined;
	reason: string | undefined;
	storyId: string | undefined;
	runId: string | undefined;
	/** True once the story carrying this item reached the published brief. */
	reachedBrief: boolean;
	briefSection: string | undefined;
}

/**
 * The "why is this not in today's brief" query. It walks the whole chain in one
 * statement — item -> decision -> story -> brief — because the answer is only
 * useful if it can distinguish "judged irrelevant" from "never scanned" from
 * "made a story that did not get selected".
 */
export async function explainItem(
	sql: Sql,
	lineage: string,
	date: string,
	itemId: string,
): Promise<ItemExplanation> {
	const rows = await sql<
		{
			title: string | null;
			disposition: string | null;
			reason: string | null;
			story_id: string | null;
			run_id: string | null;
			brief_section: string | null;
		}[]
	>`
		select n.title,
			d.disposition,
			d.reason,
			d.story_id,
			d.run_id,
			bs.section as brief_section
		from (select ${itemId}::text as item_id) q
		left join normalized_items n on n.lineage = ${lineage} and n.item_id = q.item_id
		left join item_decisions d
			on d.lineage = ${lineage} and d.date = ${date} and d.item_id = q.item_id
		left join daily_brief_stories bs
			on bs.lineage = ${lineage} and bs.date = ${date} and bs.story_id = d.story_id
	`;
	const r = rows[0];
	return {
		itemId,
		title: r?.title ?? undefined,
		disposition: (r?.disposition ?? undefined) as ItemExplanation["disposition"],
		reason: r?.reason ?? undefined,
		storyId: r?.story_id ?? undefined,
		runId: r?.run_id ?? undefined,
		reachedBrief: Boolean(r?.brief_section),
		briefSection: r?.brief_section ?? undefined,
	};
}

/** Per-disposition counts for a date; the scan-coverage report is built on this. */
export async function dispositionCounts(
	sql: Sql,
	lineage: string,
	date: string,
): Promise<Record<string, number>> {
	const rows = await sql<{ disposition: string; n: string }[]>`
		select disposition, count(*)::text as n from item_decisions
		where lineage = ${lineage} and date = ${date}
		group by disposition
	`;
	return Object.fromEntries(rows.map((r) => [r.disposition, Number(r.n)]));
}
