import { z } from "zod";

export const ChangeType = z.enum([
	"NEW",
	"UPDATE",
	"ESCALATION",
	"RESOLUTION",
	"REVERSAL",
	"CONFIRMATION",
	"RUMOR",
	"NO_MATERIAL_CHANGE",
]);
export type ChangeType = z.infer<typeof ChangeType>;

export const StoryStatus = z.enum(["OPEN", "RESOLVED", "DORMANT"]);
export type StoryStatus = z.infer<typeof StoryStatus>;

const Score = z.number().min(0).max(1);

export const StoryLedgerEntry = z
	.object({
		storyId: z.string().min(1),
		date: z.string(),
		canonicalTitle: z.string().min(1),

		sourceItemIds: z.array(z.string().min(1)),
		primarySourceIds: z.array(z.string().min(1)),

		firstSeenAt: z.string(),
		lastSeenAt: z.string(),

		status: StoryStatus,
		changeType: ChangeType,

		relevance: Score,
		novelty: Score,
		importance: Score,
		confidence: Score,

		reason: z.string().min(1),
		factRefs: z.array(z.string()).default([]),
	})
	.strict();
export type StoryLedgerEntry = z.infer<typeof StoryLedgerEntry>;

/** Tool-facing upsert payload; server owns date/firstSeenAt/lastSeenAt. */
export const StoryUpsertInput = z
	.object({
		storyId: z.string().min(1),
		canonicalTitle: z.string().min(1),
		sourceItemIds: z.array(z.string().min(1)).min(1),
		primarySourceIds: z.array(z.string().min(1)).min(1),
		status: StoryStatus,
		changeType: ChangeType,
		relevance: Score,
		novelty: Score,
		importance: Score,
		confidence: Score,
		reason: z.string().min(1),
		factRefs: z.array(z.string()).default([]),
	})
	.strict();
export type StoryUpsertInput = z.infer<typeof StoryUpsertInput>;
