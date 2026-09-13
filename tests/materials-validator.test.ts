import { describe, expect, it } from "vitest";
import { validateMaterials } from "../src/validator/materials-validator.ts";
import type { MaterialsValidationContext } from "../src/validator/materials-validator.ts";
import type { DailyManifest } from "../src/schemas/manifest.ts";
import type { DailyMaterialsInput } from "../src/schemas/materials.ts";

const manifest: DailyManifest = {
	date: "2026-09-13",
	generatedAt: "2026-09-13T00:00:00.000Z",
	items: [
		{
			id: "item-1",
			sourceType: "rss",
			sourceName: "The Verge",
			title: "Model launch",
			summary: "s",
			publishedAt: "2026-09-13T00:00:00.000Z",
			metadata: {},
		},
		{
			id: "item-2",
			sourceType: "github",
			sourceName: "GitHub",
			title: "Repo release",
			summary: "s",
			publishedAt: "2026-09-13T00:00:00.000Z",
			metadata: {},
		},
	],
	facts: [
		{
			factId: "fact-1",
			kind: "crypto",
			label: "BTC",
			value: 100,
			unit: "USD",
			asOf: "2026-09-13T00:00:00.000Z",
			sourceItemId: "item-1",
		},
	],
};

function ctx(over: Partial<MaterialsValidationContext> = {}): MaterialsValidationContext {
	return {
		manifest,
		knownStoryIds: new Set(["story-a", "story-b"]),
		totalItems: 2,
		processedItems: 2,
		...over,
	};
}

function materials(over: Partial<DailyMaterialsInput> = {}): DailyMaterialsInput {
	return {
		stories: [
			{
				storyId: "story-a",
				tier: "A",
				canonicalTitle: "Model launch",
				whySelected: "big",
				changeType: "NEW",
				importance: 0.9,
				novelty: 0.8,
				confidence: 0.7,
				sourceItemIds: ["item-1", "item-2"],
				primarySourceIds: ["item-1"],
				factRefs: ["fact-1"],
			},
		],
		emergingSignals: [],
		curatorNotes: "",
		...over,
	};
}

describe("validateMaterials", () => {
	it("accepts a fully valid submission", () => {
		const result = validateMaterials(materials(), ctx());
		expect(result).toEqual({ ok: true, errors: [] });
	});

	it("reports Zod issues with a readable path", () => {
		const result = validateMaterials({ stories: [], emergingSignals: [] }, ctx());
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.startsWith("Schema error at stories:"))).toBe(true);
	});

	it("fails when scan coverage is incomplete and names the count difference", () => {
		const result = validateMaterials(materials(), ctx({ totalItems: 5, processedItems: 2 }));
		expect(result.ok).toBe(false);
		expect(
			result.errors.some((e) => e.includes("2 of 5 items processed, 3 still unseen")),
		).toBe(true);
	});

	it("rejects unknown sourceItemIds", () => {
		const result = validateMaterials(
			materials({
				stories: [
					{ ...materials().stories[0]!, sourceItemIds: ["item-1", "item-9"] },
				],
			}),
			ctx(),
		);
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("Unknown sourceItemIds") && e.includes("item-9"))).toBe(true);
	});

	it("rejects unknown primarySourceIds", () => {
		const result = validateMaterials(
			materials({
				stories: [
					{
						...materials().stories[0]!,
						sourceItemIds: ["item-1", "item-2"],
						primarySourceIds: ["item-9"],
					},
				],
			}),
			ctx(),
		);
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("Unknown primarySourceIds") && e.includes("item-9"))).toBe(true);
	});

	it("rejects a primary source not listed in sourceItemIds", () => {
		const result = validateMaterials(
			materials({
				stories: [
					{ ...materials().stories[0]!, sourceItemIds: ["item-1"], primarySourceIds: ["item-2"] },
				],
			}),
			ctx(),
		);
		expect(result.ok).toBe(false);
		expect(
			result.errors.some((e) => e.includes("primarySourceIds not listed in sourceItemIds") && e.includes("item-2")),
		).toBe(true);
	});

	it("rejects a storyId missing from the ledger", () => {
		const result = validateMaterials(materials(), ctx({ knownStoryIds: new Set(["story-z"]) }));
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("Unknown storyId"))).toBe(true);
	});

	it("rejects unknown factRefs", () => {
		const result = validateMaterials(
			materials({ stories: [{ ...materials().stories[0]!, factRefs: ["fact-9"] }] }),
			ctx(),
		);
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("Unknown factRefs") && e.includes("fact-9"))).toBe(true);
	});

	it("rejects an emerging signal referencing an absent story", () => {
		const result = validateMaterials(
			materials({
				emergingSignals: [{ label: "trend", rationale: "why", storyIds: ["story-b"] }],
			}),
			ctx(),
		);
		expect(result.ok).toBe(false);
		expect(
			result.errors.some((e) => e.includes('Emerging signal "trend"') && e.includes("story-b")),
		).toBe(true);
	});

	it("rejects a duplicate storyId", () => {
		const base = materials().stories[0]!;
		const result = validateMaterials(materials({ stories: [base, { ...base }] }), ctx());
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes('Duplicate storyId "story-a"'))).toBe(true);
	});
});
