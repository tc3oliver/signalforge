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
		/**
		 * Which of the reader's interest topics this story matched, from
		 * `config/interests.yaml`. Empty is a normal answer, not a gap: an
		 * important story that no listed topic names still belongs in the brief,
		 * and recording that honestly is what keeps the weights priors rather than
		 * a whitelist.
		 */
		topicIds: z.array(z.string().min(1)).default([]),
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
		/** See StoryLedgerEntry.topicIds. Validated against the run's profile. */
		topicIds: z.array(z.string().min(1)).default([]),
	})
	.strict();
/**
 * The OUTPUT type: every defaulted field is present. What a repository stores.
 */
export type StoryUpsertInput = z.infer<typeof StoryUpsertInput>;
/**
 * The INPUT type: defaulted fields may be omitted. What a caller constructs.
 *
 * Repository signatures take this one. Typing a parameter as the output type
 * makes every optional field mandatory at the call site, which is how adding
 * `topicIds` to the schema broke fifteen files that had no opinion about it.
 */
export type StoryUpsertPayload = z.input<typeof StoryUpsertInput>;
