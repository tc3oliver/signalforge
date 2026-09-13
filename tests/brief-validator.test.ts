import { describe, expect, it } from "vitest";
import { validateBrief } from "../src/validator/brief-validator.ts";
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

	it("reports Zod issues, including the 8-15 story bound", () => {
		const result = validateBrief(brief({ stories: [briefStory(0)] }), ctx);
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.startsWith("Schema error at stories:"))).toBe(true);
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
