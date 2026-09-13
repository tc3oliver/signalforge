import { z } from "zod";

/** One experiment's contribution to a date: which run was compared. */
export const StabilityRunRef = z
	.object({ experiment: z.string().min(1), runId: z.string().min(1) })
	.strict();
export type StabilityRunRef = z.infer<typeof StabilityRunRef>;

/** Agreement between exactly two lineages on one date, for one metric. */
export const StabilityPair = z
	.object({
		experimentA: z.string().min(1),
		experimentB: z.string().min(1),
		value: z.number().nullable(),
		detail: z.string(),
	})
	.strict();
export type StabilityPair = z.infer<typeof StabilityPair>;

/** One metric on one date: mean pairwise agreement plus every pair's detail. */
export const StabilityMetric = z
	.object({
		name: z.string().min(1),
		mean: z.number().nullable(),
		unit: z.string(),
		pairs: z.array(StabilityPair),
	})
	.strict();
export type StabilityMetric = z.infer<typeof StabilityMetric>;

export const DateStability = z
	.object({
		date: z.string().min(1),
		runs: z.array(StabilityRunRef),
		metrics: z.array(StabilityMetric),
	})
	.strict();
export type DateStability = z.infer<typeof DateStability>;

/** Mean of a metric's means across every date it was computed for. */
export const StabilitySummaryMetric = z
	.object({ name: z.string().min(1), mean: z.number().nullable(), unit: z.string() })
	.strict();
export type StabilitySummaryMetric = z.infer<typeof StabilitySummaryMetric>;

/**
 * Descriptive only: nothing here is an acceptance gate, so there is no `pass`
 * field and no threshold. This measures whether independent lineages agree with
 * each other, not whether any one of them is "right".
 */
export const StabilityReport = z
	.object({
		generatedAt: z.string(),
		experiments: z.array(z.string().min(1)),
		/** Every model observed across the compared runs' attempt logs. */
		models: z.array(z.string()),
		dates: z.array(DateStability),
		overall: z.array(StabilitySummaryMetric),
	})
	.strict();
export type StabilityReport = z.infer<typeof StabilityReport>;
