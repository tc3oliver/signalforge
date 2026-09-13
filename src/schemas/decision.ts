import { z } from "zod";

/**
 * Disposition the curator must record for EVERY item. Recording a decision is
 * what marks an item processed — the scan-coverage guarantee is built on this
 * and not on the model claiming it read everything.
 */
export const Disposition = z.enum(["IRRELEVANT", "DUPLICATE", "CANDIDATE"]);
export type Disposition = z.infer<typeof Disposition>;

export const ItemDecision = z
	.object({
		itemId: z.string().min(1),
		disposition: Disposition,
		storyId: z.string().min(1).optional(),
		reason: z.string().min(1),
		decidedAt: z.string(),
	})
	.strict();
export type ItemDecision = z.infer<typeof ItemDecision>;

/** Tool-facing input shape (decidedAt is stamped server-side). */
export const ItemDecisionInput = z
	.object({
		itemId: z.string().min(1),
		disposition: Disposition,
		storyId: z.string().min(1).optional(),
		reason: z.string().min(1),
	})
	.strict();
export type ItemDecisionInput = z.infer<typeof ItemDecisionInput>;
