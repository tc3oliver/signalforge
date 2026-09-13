import { z } from "zod";

export const FactKind = z.enum(["crypto", "macro", "filing"]);
export type FactKind = z.infer<typeof FactKind>;

/**
 * A numeric ground fact the agent may cite but must not invent. The renderer
 * prints `value`/`unit` from the store, so a model that guesses a number cannot
 * get it into the brief — it can only reference a factId that must exist.
 */
export const StructuredFact = z
	.object({
		factId: z.string().min(1),
		kind: FactKind,
		label: z.string().min(1),
		value: z.number(),
		unit: z.string(),
		asOf: z.string(),
		sourceItemId: z.string().min(1),
		previousValue: z.number().optional(),
		changePct: z.number().optional(),
	})
	.strict();
export type StructuredFact = z.infer<typeof StructuredFact>;
