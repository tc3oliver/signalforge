import { z } from "zod";
import { ChangeType } from "./story.ts";

export const MaterialTier = z.enum(["A", "B", "C"]);
export type MaterialTier = z.infer<typeof MaterialTier>;

const Score = z.number().min(0).max(1);

export const DailyMaterialStory = z
	.object({
		storyId: z.string().min(1),
		tier: MaterialTier,
		canonicalTitle: z.string().min(1),
		whySelected: z.string().min(1),
		changeType: ChangeType,
		importance: Score,
		novelty: Score,
		confidence: Score,
		sourceItemIds: z.array(z.string().min(1)).min(1),
		primarySourceIds: z.array(z.string().min(1)).min(1),
		factRefs: z.array(z.string()).default([]),
	})
	.strict();
export type DailyMaterialStory = z.infer<typeof DailyMaterialStory>;

export const DailyMaterials = z
	.object({
		date: z.string(),
		producedAt: z.string(),
		stories: z.array(DailyMaterialStory).min(1),
		emergingSignals: z
			.array(
				z
					.object({
						label: z.string().min(1),
						rationale: z.string().min(1),
						storyIds: z.array(z.string().min(1)),
					})
					.strict(),
			)
			.default([]),
		curatorNotes: z.string().default(""),
	})
	.strict();
export type DailyMaterials = z.infer<typeof DailyMaterials>;

/** Tool-facing submit payload; producedAt/date are stamped server-side. */
export const DailyMaterialsInput = DailyMaterials.omit({ date: true, producedAt: true }).strict();
export type DailyMaterialsInput = z.infer<typeof DailyMaterialsInput>;
