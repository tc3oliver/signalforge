import { describe, expect, it } from "vitest";
import { requiredStoryCount, validateBrief } from "../src/validator/brief-validator.ts";
import type { BriefValidationContext } from "../src/validator/brief-validator.ts";
import type { BriefSection, DailyBriefInput, DailyBriefStory } from "../src/schemas/brief.ts";
import type { DailyManifest } from "../src/schemas/manifest.ts";
import type { DailyMaterials } from "../src/schemas/materials.ts";

const N = 9;
const SECTIONS: BriefSection[] = ["AI_LLM", "DEVELOPER_OSS", "RESEARCH", "CRYPTO_MARKET", "MACRO", "COMPANIES"];
const ids = Array.from({ length: N }, (_, i) => `story-${i + 1}`);

const manifest: DailyManifest = {
	date: "2026-09-13",
	generatedAt: "2026-09-13T00:00:00.000Z",
	items: Array.from({ length: N * 2 }, (_, i) => ({
		id: `item-${i + 1}`,
		sourceType: "rss" as const,
		trust: "UNTRUSTED_EXTERNAL_CONTENT" as const,
		sourceName: "Feed",
		title: `Item ${i + 1}`,
		summary: "s",
		publishedAt: "2026-09-13T00:00:00.000Z",
		metadata: {},
	})),
	facts: [
		{
			factId: "fact-1",
			kind: "crypto" as const,
			label: "BTC",
			value: 100,
			unit: "USD",
			asOf: "2026-09-13T00:00:00.000Z",
			sourceItemId: "item-1",
		},
	],
};

const materials: DailyMaterials = {
	date: "2026-09-13",
	producedAt: "2026-09-13T01:00:00.000Z",
	stories: ids.map((storyId, i) => ({
		storyId,
		tier: "A" as const,
		canonicalTitle: `Story ${i + 1}`,
		whySelected: "why",
		changeType: "NEW" as const,
		importance: 0.5,
		novelty: 0.5,
		confidence: 0.5,
		sourceItemIds: [`item-${i * 2 + 1}`, `item-${i * 2 + 2}`],
		primarySourceIds: [`item-${i * 2 + 1}`],
		factRefs: [],
	})),
	emergingSignals: [],
	curatorNotes: "",
};

const ctx: BriefValidationContext = { manifest, materials };

function briefStory(i: number, over: Partial<DailyBriefStory> = {}): DailyBriefStory {
	return {
		storyId: ids[i]!,
		section: SECTIONS[i % SECTIONS.length]!,
		mustKnow: i < 3,
		title: `Story ${i + 1}`,
		whatHappened: "發生了什麼",
		whyItMatters: "為何重要",
		whatChanged: "有什麼變化",
		impact: "影響",
		confidence: "HIGH",
		sourceItemIds: [`item-${i * 2 + 1}`],
		factRefs: [],
		...over,
	};
}

function brief(over: Partial<DailyBriefInput> = {}): DailyBriefInput {
	return {
		stories: Array.from({ length: N }, (_, i) => briefStory(i)),
		emergingSignals: [],
		dailyAnalysis: "今日總結",
		watchNext: ["觀察 A"],
		...over,
	};
}

describe("validateBrief", () => {
	it("accepts a fully valid brief", () => {
		expect(validateBrief(brief(), ctx)).toEqual({ ok: true, errors: [] });
	});

	it("reports the story-count bound against what the curator supplied", () => {
		const result = validateBrief(brief({ stories: [briefStory(0)] }), ctx);
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => /must have between 8 and 9/.test(e))).toBe(true);
	});

	it("rejects too few Must Know stories", () => {
		const stories = Array.from({ length: N }, (_, i) => briefStory(i, { mustKnow: i < 2 }));
		const result = validateBrief(brief({ stories }), ctx);
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("Must Know count is 2"))).toBe(true);
	});

	it("rejects too many Must Know stories", () => {
		const stories = Array.from({ length: N }, (_, i) => briefStory(i, { mustKnow: i < 6 }));
		const result = validateBrief(brief({ stories }), ctx);
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("Must Know count is 6"))).toBe(true);
	});

	it("rejects a storyId the curator never selected", () => {
		const stories = Array.from({ length: N }, (_, i) => briefStory(i));
		stories[5] = briefStory(5, { storyId: "story-invented" });
		const result = validateBrief(brief({ stories }), ctx);
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes('Unknown storyId in brief story "story-invented"'))).toBe(true);
	});

	it("rejects a duplicate storyId in the brief", () => {
		const stories = Array.from({ length: N }, (_, i) => briefStory(i));
		stories[5] = briefStory(5, { storyId: ids[4]!, sourceItemIds: ["item-9"] });
		const result = validateBrief(brief({ stories }), ctx);
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes(`Duplicate storyId "${ids[4]}"`))).toBe(true);
	});

	it("rejects a sourceItemId absent from the manifest", () => {
		const stories = Array.from({ length: N }, (_, i) => briefStory(i));
		stories[0] = briefStory(0, { sourceItemIds: ["item-999"] });
		const result = validateBrief(brief({ stories }), ctx);
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("Unknown sourceItemIds") && e.includes("item-999"))).toBe(true);
	});

	it("rejects a manifest item that is not among that story's material sources", () => {
		const stories = Array.from({ length: N }, (_, i) => briefStory(i));
		// item-5 exists but belongs to story-3, not story-1.
		stories[0] = briefStory(0, { sourceItemIds: ["item-5"] });
		const result = validateBrief(brief({ stories }), ctx);
		expect(result.ok).toBe(false);
		expect(
			result.errors.some((e) => e.includes("not among that story's material sources") && e.includes("item-5")),
		).toBe(true);
	});

	it("rejects unknown factRefs", () => {
		const stories = Array.from({ length: N }, (_, i) => briefStory(i));
		stories[0] = briefStory(0, { factRefs: ["fact-9"] });
		const result = validateBrief(brief({ stories }), ctx);
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("Unknown factRefs") && e.includes("fact-9"))).toBe(true);
	});

	it("rejects an emerging signal referencing a story not in today's materials", () => {
		const result = validateBrief(
			brief({ emergingSignals: [{ label: "trend", body: "body", storyIds: ["story-absent"] }] }),
			ctx,
		);
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes('Emerging signal "trend"') && e.includes("story-absent"))).toBe(true);
	});

	/**
	 * The constituents of a trend are usually too weak to earn a brief slot on their
	 * own — that weakness is why the aggregate is worth naming. Requiring them to be
	 * published before they can be cited would force the editor to double-count the
	 * same intelligence value, which is exactly what the precision gate punishes.
	 */
	it("accepts an emerging signal citing a curated story the brief did not publish", () => {
		const evidenceId = "story-evidence-only";
		const ctxWithEvidence: BriefValidationContext = {
			manifest,
			materials: {
				...materials,
				stories: [
					...materials.stories,
					{ ...materials.stories[0]!, storyId: evidenceId, tier: "C" as const },
				],
			},
		};
		const result = validateBrief(
			brief({ emergingSignals: [{ label: "trend", body: "body", storyIds: [evidenceId] }] }),
			ctxWithEvidence,
		);
		expect(result).toEqual({ ok: true, errors: [] });
	});

	it("rejects an empty watchNext", () => {
		const result = validateBrief(brief({ watchNext: [] }), ctx);
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("watchNext"))).toBe(true);
	});
});

describe("brief size follows what the curator actually found", () => {
	/** The same fixtures, trimmed to a day on which the curator found only `n` stories. */
	function contextWithMaterials(n: number): BriefValidationContext {
		return { manifest, materials: { ...materials, stories: materials.stories.slice(0, n) } };
	}

	function briefWith(n: number, opts: { mustKnow: number }): DailyBriefInput {
		return brief({
			stories: Array.from({ length: n }, (_, i) => briefStory(i, { mustKnow: i < opts.mustKnow })),
		});
	}

	it("requires the usual 8-15 on a normal day", () => {
		expect(requiredStoryCount(15)).toEqual({ min: 8, max: 15 });
		expect(requiredStoryCount(40)).toEqual({ min: 8, max: 15 });
		expect(requiredStoryCount(8)).toEqual({ min: 8, max: 8 });
	});

	it("asks for every story there is on a quiet day, rather than eight there are not", () => {
		// The first real production run found four genuine stories in 771 items.
		// A brief of four real stories is the right output for that morning;
		// failing the day because the world was quiet is not.
		expect(requiredStoryCount(4)).toEqual({ min: 4, max: 4 });
		expect(requiredStoryCount(1)).toEqual({ min: 1, max: 1 });
	});

	it("accepts a four-story brief when the materials held four stories", () => {
		expect(validateBrief(briefWith(4, { mustKnow: 3 }), contextWithMaterials(4))).toEqual({
			ok: true,
			errors: [],
		});
	});

	it("still rejects a short brief when the curator had plenty", () => {
		const result = validateBrief(briefWith(4, { mustKnow: 3 }), ctx);
		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toMatch(/must have between 8 and 9/);
	});

	it("scales Must Know down with the brief instead of demanding three of two", () => {
		expect(validateBrief(briefWith(2, { mustKnow: 2 }), contextWithMaterials(2))).toEqual({
			ok: true,
			errors: [],
		});
	});
});
