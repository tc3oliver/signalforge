import { z } from "zod";

/**
 * Source families simulated in Phase 1. Kept as a closed set so fixtures,
 * tools and evaluation agree on what a "source type" is.
 */
/**
 * Every piece of text that entered this system from outside it carries this tag,
 * from the collector boundary through to the agent-visible projection. It is
 * declared here rather than in the collector layer because the schemas are what
 * both sides agree on, and `src/collectors/types.ts` re-exports it.
 */
export const UNTRUSTED_EXTERNAL_CONTENT = "UNTRUSTED_EXTERNAL_CONTENT" as const;

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
		/**
		 * Carried through from the collector boundary so the marking survives
		 * normalization and storage rather than being a fact about one layer.
		 * Defaulted, so a row read back from a database that predates the field
		 * still says what it has always been true of: this text came from outside.
		 */
		trust: z.literal(UNTRUSTED_EXTERNAL_CONTENT).default(UNTRUSTED_EXTERNAL_CONTENT),
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
		trust: z.literal(UNTRUSTED_EXTERNAL_CONTENT).default(UNTRUSTED_EXTERNAL_CONTENT),
	})
	.strict();
export type ItemSummaryView = z.infer<typeof ItemSummaryView>;
