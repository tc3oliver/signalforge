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
	.strict()
	/*
	 * Item ids are the identity the scan-coverage gate compares against. A
	 * duplicate id would make a decided item indistinguishable from an undecided
	 * one, so a bad manifest has to fail here, at the collector, rather than
	 * inside the curator's retry loop.
	 */
	.superRefine((m, ctx) => {
		const seen = new Set<string>();
		const duplicates: string[] = [];
		for (const item of m.items) {
			if (seen.has(item.id)) {
				if (!duplicates.includes(item.id)) duplicates.push(item.id);
			}
			seen.add(item.id);
		}
		if (duplicates.length > 0) {
			ctx.addIssue({
				code: "custom",
				path: ["items"],
				message: `Duplicate item id(s) in manifest: ${duplicates.join(", ")}. Every manifest item must have a unique id.`,
			});
		}
	});
export type DailyManifest = z.infer<typeof DailyManifest>;
