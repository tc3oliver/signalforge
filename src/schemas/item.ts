import { z } from "zod";

/**
 * Source families simulated in Phase 1. Kept as a closed set so fixtures,
 * tools and evaluation agree on what a "source type" is.
 */
export const SourceType = z.enum([
	"rss",
	"github",
	"hackernews",
	"web",
	"arxiv",
	"semantic-scholar",
	"reddit",
	"youtube",
	"coingecko",
	"fred",
	"sec",
]);
export type SourceType = z.infer<typeof SourceType>;

/**
 * The ONLY item shape an agent ever sees. Gold-truth fields (goldEventId,
 * expectedImportance, isNoise, ...) must never appear here; `.strict()` makes
 * a leak a parse failure rather than a silent contamination.
 */
export const NormalizedItem = z
	.object({
		id: z.string().min(1),
		sourceType: SourceType,
		sourceName: z.string().min(1),
		title: z.string().min(1),
		summary: z.string(),
		content: z.string().optional(),
		url: z.string().optional(),
		publishedAt: z.string(),
		metadata: z.record(z.string(), z.unknown()).default({}),
	})
	.strict();
export type NormalizedItem = z.infer<typeof NormalizedItem>;

/** Reduced projection returned by list_unseen_items — broad scan, no full content. */
export const ItemSummaryView = z
	.object({
		id: z.string(),
		sourceType: SourceType,
		sourceName: z.string(),
		title: z.string(),
		summary: z.string(),
		publishedAt: z.string(),
		metadata: z.record(z.string(), z.unknown()),
	})
	.strict();
export type ItemSummaryView = z.infer<typeof ItemSummaryView>;
