import type { Sql } from "../db/client.ts";
import type { StructuredFact } from "../schemas/fact.ts";
import type { NormalizedItem } from "../schemas/item.ts";
import { DailyManifest } from "../schemas/manifest.ts";

/*
 * The manifest is the agent-visible projection of one day. In Phase 1 it was a
 * fixture file; in production it is exactly the same shape read out of Postgres,
 * so nothing downstream of the curator changes.
 *
 * These two queries are a day-window projection that `src/db/*` does not expose
 * (that module is owned elsewhere and has no "everything for a date" reader).
 * They read the same tables through the same column contract — no second write
 * path, no second connection, no schema knowledge beyond what src/db already
 * encodes.
 */

const ISO = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

export interface ManifestWindow {
	/** Inclusive lower bound. */
	from: Date;
	/** Exclusive upper bound. */
	to: Date;
}

/** UTC day containing `date`, which is how every collector stamps publishedAt. */
export function dayWindow(date: string): ManifestWindow {
	const from = new Date(`${date}T00:00:00.000Z`);
	if (Number.isNaN(from.getTime())) throw new Error(`Invalid date "${date}"; expected YYYY-MM-DD`);
	return { from, to: new Date(from.getTime() + 24 * 60 * 60 * 1000) };
}

interface ItemRow {
	item_id: string;
	source_type: string;
	source_name: string;
	title: string;
	summary: string;
	content: string | null;
	url: string | null;
	published_at: string;
	metadata: Record<string, unknown>;
}

interface FactRow {
	fact_id: string;
	kind: string;
	label: string;
	value: number;
	unit: string;
	as_of: string;
	source_item_id: string;
	previous_value: number | null;
	change_pct: number | null;
}

export interface BuildManifestOptions {
	sql: Sql;
	lineage: string;
	date: string;
	now?: () => Date;
	/** Overrides the default UTC-day window (a catch-up run may want a wider one). */
	window?: ManifestWindow;
	/** Safety valve so one runaway collector cannot produce an unbounded manifest. */
	maxItems?: number;
}

const DEFAULT_MAX_ITEMS = 2000;

/**
 * Builds the day's manifest from stored items and facts. Reading rather than
 * re-collecting is what makes every later stage retryable: a curator crash costs
 * a curator session, never another pass over eleven providers.
 */
export async function buildManifestFromDb(options: BuildManifestOptions): Promise<DailyManifest> {
	const now = options.now ?? (() => new Date());
	const window = options.window ?? dayWindow(options.date);
	const limit = options.maxItems ?? DEFAULT_MAX_ITEMS;

	const itemRows = await options.sql<ItemRow[]>`
		select item_id, source_type, source_name, title, summary, content, url,
			to_char(published_at at time zone 'utc', ${ISO}) as published_at, metadata
		from normalized_items
		where lineage = ${options.lineage}
			and published_at >= ${window.from.toISOString()}::timestamptz
			and published_at < ${window.to.toISOString()}::timestamptz
		order by published_at, item_id
		limit ${limit}
	`;

	const items: NormalizedItem[] = itemRows.map((r) => ({
		id: r.item_id,
		sourceType: r.source_type as NormalizedItem["sourceType"],
		sourceName: r.source_name,
		title: r.title,
		summary: r.summary,
		...(r.content === null ? {} : { content: r.content }),
		...(r.url === null ? {} : { url: r.url }),
		publishedAt: r.published_at,
		metadata: r.metadata,
	}));

	const factRows = await options.sql<FactRow[]>`
		select fact_id, kind, label, value, unit,
			to_char(as_of at time zone 'utc', ${ISO}) as as_of,
			source_item_id, previous_value, change_pct
		from structured_facts
		where lineage = ${options.lineage}
			and as_of >= ${window.from.toISOString()}::timestamptz
			and as_of < ${window.to.toISOString()}::timestamptz
		order by fact_id
	`;

	const facts: StructuredFact[] = factRows.map((r) => ({
		factId: r.fact_id,
		kind: r.kind as StructuredFact["kind"],
		label: r.label,
		value: r.value,
		unit: r.unit,
		asOf: r.as_of,
		sourceItemId: r.source_item_id,
		...(r.previous_value === null ? {} : { previousValue: r.previous_value }),
		...(r.change_pct === null ? {} : { changePct: r.change_pct }),
	}));

	// Parsed rather than cast: a schema drift in the store must fail here, where
	// it is diagnosable, not inside an agent tool.
	return DailyManifest.parse({
		date: options.date,
		generatedAt: now().toISOString(),
		items,
		facts,
	});
}
