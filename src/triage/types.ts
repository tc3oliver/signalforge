import { z } from "zod";

/*
 * Stage 0 triage: a cheap, deterministic opinion about an item, formed from
 * what the broad scan already sees.
 *
 * The expensive part of a run is the Curator forming a judgement on every item,
 * and the obvious saving is to stop sending it things it will call IRRELEVANT.
 * The obvious saving is also how a pipeline starts missing the things it exists
 * to catch: a vLLM release, an ROCm update, an MCP server, an open-weight model
 * drop or a protocol upgrade rarely has a dramatic title, and the headline that
 * reads as important is frequently a funding round. Dropping on a title is
 * exactly the wrong way round.
 *
 * So triage ships in shadow mode and its output changes nothing. Every item
 * still reaches the Curator, the prediction is stored beside the decision the
 * Curator actually made, and the question "what would we have lost?" becomes a
 * measurement instead of an argument. Only recall against real outcomes --
 * especially Must Know -- can justify letting it route anything.
 */

export const TriageCategory = z.enum([
	/** Something the reader is known to want: a watched entity, an advisory, a strong topic hit. */
	"PRIORITY",
	/** Plausibly relevant. The default for anything that matches an interest at all. */
	"NORMAL",
	/** Looks like business/PR noise. The only bucket a future filter would consider dropping. */
	"LOW",
	/** Looks like another item's coverage of the same event. A hint for clustering, not a decision. */
	"DUPLICATE_HINT",
	/** The rules could not tell. Never treated as LOW; see the note in rules.ts. */
	"UNCERTAIN",
]);
export type TriageCategory = z.infer<typeof TriageCategory>;

export const TriageResult = z
	.object({
		itemId: z.string().min(1),
		category: TriageCategory,
		/**
		 * Topics the rules matched. Advisory: the Curator forms its own
		 * `topicIds` and this never overrides it.
		 */
		topicIds: z.array(z.string()).default([]),
		/**
		 * 0..1. Explicitly NOT a relevance score -- it is a cheap prior from
		 * keyword and source structure with no view of history, clustering or
		 * importance. Triage has no standing to decide an editorial outcome and
		 * nothing downstream reads this.
		 */
		relevanceHint: z.number().min(0).max(1),
		/** Which rule fired, in plain words, so a disagreement can be audited. */
		reason: z.string().min(1),
		/** The rule id that produced the category; stable across wording changes. */
		ruleId: z.string().min(1),
	})
	.strict();
export type TriageResult = z.infer<typeof TriageResult>;

/**
 * Everything a triage rule may look at.
 *
 * Deliberately a narrow projection rather than the item: `content` is absent by
 * construction, so "cheap triage" cannot quietly start reading full bodies and
 * become a second expensive stage. The type is the enforcement.
 */
export interface TriageInput {
	itemId: string;
	sourceType: string;
	sourceName: string;
	title: string;
	summary: string;
	publishedAt: string;
	metadata: Record<string, unknown>;
}
