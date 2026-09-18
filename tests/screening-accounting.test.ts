import { describe, expect, it } from "vitest";
import {
	accountManifest,
	validateMaterials,
	type MaterialsValidationContext,
} from "../src/validator/materials-validator.ts";
import type { DailyManifest } from "../src/schemas/manifest.ts";
import type { DailyMaterialsInput } from "../src/schemas/materials.ts";

/*
 * The accounting invariant that replaces "every item needs a Curator
 * decision": every manifest item is accounted for by a real Curator decision
 * OR a routed screener DROP, and a DROP alone never makes an item citable.
 */

function manifest(ids: string[]): DailyManifest {
	return {
		date: "2026-09-18",
		generatedAt: "2026-09-18T00:00:00.000Z",
		items: ids.map((id) => ({
			id,
			sourceType: "rss" as const,
			trust: "UNTRUSTED_EXTERNAL_CONTENT" as const,
			sourceName: "Wire",
			title: `Item ${id}`,
			summary: "s",
			publishedAt: "2026-09-18T00:00:00.000Z",
			metadata: {},
		})),
		facts: [],
	};
}

function ctx(over: Partial<MaterialsValidationContext> = {}): MaterialsValidationContext {
	return {
		manifest: manifest(["a", "b", "c", "d"]),
		knownStoryIds: new Set(["s1"]),
		processedItemIds: new Set(),
		...over,
	};
}

function materials(sourceItemIds: string[]): DailyMaterialsInput {
	return {
		stories: [
			{
				storyId: "s1",
				tier: "A",
				canonicalTitle: "Story",
				whySelected: "why",
				changeType: "NEW",
				importance: 0.5,
				novelty: 0.5,
				confidence: 0.5,
				sourceItemIds,
				primarySourceIds: [sourceItemIds[0]!],
				factRefs: [],
			},
		],
		emergingSignals: [],
		curatorNotes: "",
	};
}

describe("accountManifest", () => {
	it("with no screening, is the old coverage rule exactly", () => {
		const a = accountManifest(ctx({ processedItemIds: new Set(["a", "b"]) }));
		expect(a).toEqual({
			total: 4,
			screenedOut: 0,
			sentToCurator: 4,
			curatorDecided: 2,
			rescued: 0,
			unaccountedItemIds: ["c", "d"],
		});
	});

	it("counts a routed DROP as accounted, and never as decided", () => {
		const a = accountManifest(
			ctx({ processedItemIds: new Set(["a", "b"]), screenedOutItemIds: new Set(["c"]) }),
		);
		expect(a.screenedOut).toBe(1);
		expect(a.sentToCurator).toBe(3);
		expect(a.curatorDecided).toBe(2);
		expect(a.unaccountedItemIds).toEqual(["d"]);
	});

	it("counts a screened-out item the Curator decided anyway as rescued", () => {
		const a = accountManifest(
			ctx({ processedItemIds: new Set(["a", "b", "c", "d"]), screenedOutItemIds: new Set(["c"]) }),
		);
		expect(a.rescued).toBe(1);
		expect(a.curatorDecided).toBe(4);
		expect(a.unaccountedItemIds).toEqual([]);
	});

	it("ignores screened-out ids that are not in this manifest", () => {
		const a = accountManifest(
			ctx({ processedItemIds: new Set(["a", "b", "c", "d"]), screenedOutItemIds: new Set(["zzz"]) }),
		);
		expect(a.screenedOut).toBe(0);
	});
});

describe("validateMaterials with a routed workset", () => {
	it("accepts when every item is decided or screened out", () => {
		const result = validateMaterials(
			materials(["a"]),
			ctx({ processedItemIds: new Set(["a", "b"]), screenedOutItemIds: new Set(["c", "d"]) }),
		);
		expect(result).toEqual({ ok: true, errors: [] });
	});

	it("rejects an item that is neither decided nor screened out, by id", () => {
		const result = validateMaterials(
			materials(["a"]),
			ctx({ processedItemIds: new Set(["a", "b"]), screenedOutItemIds: new Set(["c"]) }),
		);
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("2 of 3 offered items decided, 1 still unseen: d"))).toBe(true);
	});

	it("rejects a story that cites a screened-out item the Curator never decided", () => {
		// The DROP accounts for `c`; it does not make `c` citable. Citing is an
		// editorial act and needs the Curator's own decision -- the rescue path.
		const result = validateMaterials(
			materials(["a", "c"]),
			ctx({ processedItemIds: new Set(["a", "b"]), screenedOutItemIds: new Set(["c", "d"]) }),
		);
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => /Undecided sourceItemIds in story "s1": c/.test(e))).toBe(true);
	});

	it("accepts the same citation once the Curator has decided the rescued item", () => {
		const result = validateMaterials(
			materials(["a", "c"]),
			ctx({ processedItemIds: new Set(["a", "b", "c"]), screenedOutItemIds: new Set(["c", "d"]) }),
		);
		expect(result).toEqual({ ok: true, errors: [] });
	});

	it("still rejects a cited item that is simply undecided, with no screening at all", () => {
		const result = validateMaterials(materials(["a", "b"]), ctx({ processedItemIds: new Set(["a"]) }));
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("Scan coverage incomplete"))).toBe(true);
		expect(result.errors.some((e) => e.includes("Undecided sourceItemIds"))).toBe(true);
	});
});
