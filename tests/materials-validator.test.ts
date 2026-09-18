import { describe, expect, it } from "vitest";
import { validateMaterials } from "../src/validator/materials-validator.ts";
import type { MaterialsValidationContext } from "../src/validator/materials-validator.ts";
import { DailyManifest } from "../src/schemas/manifest.ts";
import type { DailyMaterialsInput } from "../src/schemas/materials.ts";

const manifest: DailyManifest = {
	date: "2026-09-13",
	generatedAt: "2026-09-13T00:00:00.000Z",
	items: [
		{
			id: "item-1",
			sourceType: "rss",
			trust: "UNTRUSTED_EXTERNAL_CONTENT" as const,
			sourceName: "The Verge",
			title: "Model launch",
			summary: "s",
			publishedAt: "2026-09-13T00:00:00.000Z",
			metadata: {},
		},
		{
			id: "item-2",
			sourceType: "github",
			trust: "UNTRUSTED_EXTERNAL_CONTENT" as const,
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
		processedItemIds: new Set(["item-1", "item-2"]),
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

	it("fails when scan coverage is incomplete and names the undecided item ids", () => {
		const result = validateMaterials(
			materials(),
			ctx({ processedItemIds: new Set(["item-1"]) }),
		);
		expect(result.ok).toBe(false);
		expect(
			result.errors.some(
				(e) => e.includes("1 of 2 items processed, 1 still unseen") && e.includes("item-2"),
			),
		).toBe(true);
	});

	/*
	 * 2026-09-18: three rejected submissions in a row at the end of a 64-minute
	 * curation, each one a full model turn, all of them storyId mismatches. The
	 * rejections said which id was wrong and never which ids were right, so the
	 * model could only guess -- while this validator held the valid set the whole
	 * time. A correction that is fed back verbatim to a model has to carry the
	 * answer with it.
	 */
	describe("rejections name the valid ids, not just the invalid one", () => {
		it("lists the story ledger when a storyId is not in it", () => {
			const result = validateMaterials(
				materials({
					stories: [{ ...materials().stories[0]!, storyId: "story-invented" }],
				}),
				ctx({ knownStoryIds: new Set(["story-a", "story-b"]) }),
			);
			expect(result.ok).toBe(false);
			const error = result.errors.find((e) => e.includes("Unknown storyId"));
			expect(error).toBeDefined();
			expect(error).toContain("story-a");
			expect(error).toContain("story-b");
		});

		it("lists the submitted stories when a signal cites one that is not among them", () => {
			const result = validateMaterials(
				materials({
					emergingSignals: [
						{
							label: "A signal",
							rationale: "r",
							storyIds: ["story-not-submitted"],
						},
					],
				}),
				ctx(),
			);
			expect(result.ok).toBe(false);
			const error = result.errors.find((e) => e.includes("Emerging signal"));
			expect(error).toBeDefined();
			expect(error).toContain("story-not-submitted");
			expect(error).toContain("The stories in this submission are: story-a");
		});

		it("bounds the ledger listing so a correction cannot crowd out its instruction", () => {
			const many = new Set(Array.from({ length: 120 }, (_, i) => `ledger-${String(i).padStart(3, "0")}`));
			const result = validateMaterials(
				materials({
					stories: [{ ...materials().stories[0]!, storyId: "story-invented" }],
				}),
				ctx({ knownStoryIds: many }),
			);
			const error = result.errors.find((e) => e.includes("Unknown storyId"));
			expect(error).toBeDefined();
			expect(error).toContain("and 80 more");
			expect(error).toContain("ledger-000");
			// The 41st id onward is summarised, not listed.
			expect(error).not.toContain("ledger-119");
		});
	});

	it("rejects a submission whose decision count matches but whose membership differs", () => {
		// Run A decided item-1 and a since-aged-out item-0; re-collection swapped
		// item-0 for item-2. Two decisions, two manifest items, one never scanned.
		const result = validateMaterials(
			materials(),
			ctx({ processedItemIds: new Set(["item-0", "item-1"]) }),
		);
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("Scan coverage incomplete"))).toBe(true);
		expect(result.errors.some((e) => e.includes("item-2"))).toBe(true);
	});

	it("does not let decisions from an unrelated run satisfy coverage", () => {
		const result = validateMaterials(
			materials(),
			ctx({ processedItemIds: new Set(["item-1", "other-run-a", "other-run-b"]) }),
		);
		expect(result.ok).toBe(false);
		expect(
			result.errors.some(
				(e) => e.includes("1 of 2 items processed") && e.includes("item-2"),
			),
		).toBe(true);
	});

	it("accepts when every manifest id is decided, even alongside extra decisions", () => {
		const result = validateMaterials(
			materials(),
			ctx({ processedItemIds: new Set(["item-1", "item-2", "stale-item"]) }),
		);
		expect(result).toEqual({ ok: true, errors: [] });
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

describe("DailyManifest item id uniqueness", () => {
	it("accepts a manifest whose item ids are unique", () => {
		expect(DailyManifest.safeParse(manifest).success).toBe(true);
	});

	it("rejects a manifest with a duplicate item id and names the duplicate", () => {
		const dup = { ...manifest, items: [manifest.items[0]!, manifest.items[1]!, manifest.items[0]!] };
		const parsed = DailyManifest.safeParse(dup);
		expect(parsed.success).toBe(false);
		if (parsed.success) return;
		expect(parsed.error.issues.some((i) => i.message.includes("item-1"))).toBe(true);
		expect(parsed.error.issues.some((i) => i.message.includes("Duplicate item id"))).toBe(true);
	});
});
