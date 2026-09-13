import { z } from "zod";

export const BriefSection = z.enum([
	"MUST_KNOW",
	"AI_LLM",
	"DEVELOPER_OSS",
	"RESEARCH",
	"CRYPTO_MARKET",
	"MACRO",
	"COMPANIES",
]);
export type BriefSection = z.infer<typeof BriefSection>;

export const ConfidenceLevel = z.enum(["HIGH", "MEDIUM", "LOW"]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevel>;

export const DailyBriefStory = z
	.object({
		storyId: z.string().min(1),
		section: BriefSection,
		mustKnow: z.boolean(),
		title: z.string().min(1),
		whatHappened: z.string().min(1),
		whyItMatters: z.string().min(1),
		whatChanged: z.string().min(1),
		impact: z.string().min(1),
		confidence: ConfidenceLevel,
		sourceItemIds: z.array(z.string().min(1)).min(1),
		factRefs: z.array(z.string()).default([]),
	})
	.strict();
export type DailyBriefStory = z.infer<typeof DailyBriefStory>;

export const DailyBrief = z
	.object({
		date: z.string(),
		producedAt: z.string(),
		stories: z.array(DailyBriefStory).min(8).max(15),
		emergingSignals: z
			.array(
				z
					.object({ label: z.string().min(1), body: z.string().min(1), storyIds: z.array(z.string()) })
					.strict(),
			)
			.default([]),
		dailyAnalysis: z.string().min(1),
		watchNext: z.array(z.string().min(1)).min(1),
	})
	.strict();
export type DailyBrief = z.infer<typeof DailyBrief>;

export const DailyBriefInput = DailyBrief.omit({ date: true, producedAt: true }).strict();
export type DailyBriefInput = z.infer<typeof DailyBriefInput>;
