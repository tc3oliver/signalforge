import { z } from "zod";
import { NormalizedItem } from "./item.ts";
import { StructuredFact } from "./fact.ts";

/** One day's complete agent-visible input. Frozen once generated. */
export const DailyManifest = z
	.object({
		date: z.string(),
		generatedAt: z.string(),
		items: z.array(NormalizedItem),
		facts: z.array(StructuredFact),
	})
	.strict();
export type DailyManifest = z.infer<typeof DailyManifest>;
