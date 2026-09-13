import { z } from "zod";
import { ChangeType } from "./story.ts";

/**
 * Gold truth. Lives only under eval/gold and is loaded only by the evaluator —
 * no agent tool exposes it, and the restricted runtime has no filesystem tools,
 * so the agent has no path to it at all.
 */
export const GoldEvent = z
	.object({
		eventId: z.string().min(1),
		canonicalTitle: z.string().min(1),
		/** Every item that belongs to this real-world event on this date. */
		itemIds: z.array(z.string().min(1)).min(1),
		/** Items a competent curator should treat as the authoritative source. */
		primaryItemIds: z.array(z.string().min(1)).min(1),
		expectedChangeType: ChangeType,
		/** True when the event should survive into the final brief. */
		expectedImportant: z.boolean(),
		expectedSection: z.string(),
	})
	.strict();
export type GoldEvent = z.infer<typeof GoldEvent>;

export const GoldTruth = z
	.object({
		date: z.string(),
		events: z.array(GoldEvent),
		/** Items that are pure noise and should never reach the brief. */
		noiseItemIds: z.array(z.string()),
		expectedEmergingSignals: z.array(
			z.object({ label: z.string(), eventIds: z.array(z.string()) }).strict(),
		),
	})
	.strict();
export type GoldTruth = z.infer<typeof GoldTruth>;

export const MetricResult = z
	.object({
		name: z.string(),
		value: z.number().nullable(),
		unit: z.string(),
		threshold: z.number().nullable(),
		comparator: z.enum(["gte", "lte", "eq", "range", "none"]),
		pass: z.boolean().nullable(),
		detail: z.string().default(""),
	})
	.strict();
export type MetricResult = z.infer<typeof MetricResult>;

export const EvalReport = z
	.object({
		date: z.string(),
		runId: z.string(),
		evaluatedAt: z.string(),
		metrics: z.array(MetricResult),
		overallPass: z.boolean(),
		failedGates: z.array(z.string()),
	})
	.strict();
export type EvalReport = z.infer<typeof EvalReport>;
