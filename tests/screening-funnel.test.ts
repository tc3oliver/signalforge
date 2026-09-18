import { describe, expect, it } from "vitest";
import {
	assessScreeningReadiness,
	buildScreeningFunnel,
	SCREENING_GATE,
	type ScreeningFunnel,
	type ScreeningOutcomeRow,
} from "../src/observation/screening-funnel.ts";

function row(over: Partial<ScreeningOutcomeRow> & { itemId: string }): ScreeningOutcomeRow {
	return {
		verdict: "KEEP",
		auditSampled: false,
		routed: false,
		disposition: "IRRELEVANT",
		storyId: null,
		reachedMaterial: false,
		reachedFinal: false,
		reachedMustKnow: false,
		...over,
	};
}

describe("buildScreeningFunnel", () => {
	it("measures DROP precision against the Curator's decision, counting DUPLICATE as agreement", () => {
		const f = buildScreeningFunnel("2026-09-18", [
			row({ itemId: "1", verdict: "DROP", disposition: "IRRELEVANT" }),
			row({ itemId: "2", verdict: "DROP", disposition: "DUPLICATE", storyId: "s" }),
			row({ itemId: "3", verdict: "DROP", disposition: "CANDIDATE", storyId: "s" }),
			row({ itemId: "4", verdict: "KEEP", disposition: "CANDIDATE", storyId: "t" }),
		]);
		expect(f.byVerdict).toEqual({ DROP: 3, KEEP: 1, UNSURE: 0 });
		expect(f.dropRate).toBe(0.75);
		expect(f.dropEvaluated).toBe(3);
		expect(f.dropAgreed).toBe(2);
		expect(f.dropToCandidate).toBe(1);
		expect(f.dropPrecision).toBeCloseTo(2 / 3);
		expect(f.falseNegativeItemIds).toEqual(["3"]);
		expect(f.recall.candidate).toBe(0.5);
	});

	it("measures story recall at story level: a story survives if any item survives", () => {
		const f = buildScreeningFunnel("2026-09-18", [
			row({ itemId: "1", verdict: "DROP", disposition: "CANDIDATE", storyId: "s", reachedMaterial: true, reachedFinal: true, reachedMustKnow: true }),
			row({ itemId: "2", verdict: "KEEP", disposition: "DUPLICATE", storyId: "s", reachedMaterial: true, reachedFinal: true, reachedMustKnow: true }),
			row({ itemId: "3", verdict: "DROP", disposition: "CANDIDATE", storyId: "lost", reachedMaterial: true, reachedFinal: true }),
		]);
		expect(f.recall.mustKnow).toBe(1);
		expect(f.recall.final).toBe(0.5);
		expect(f.lost).toEqual({ materialStories: 1, finalStories: 1, mustKnowStories: 0 });
		expect(f.lostFinalStoryIds).toEqual(["lost"]);
	});

	it("distinguishes a withheld DROP from an evaluated one, and counts rescues and audit leakage", () => {
		const f = buildScreeningFunnel("2026-09-18", [
			// Withheld and never seen: no decision, not evaluated.
			row({ itemId: "1", verdict: "DROP", routed: true, disposition: null }),
			// Withheld, then rescued through search_items.
			row({ itemId: "2", verdict: "DROP", routed: true, disposition: "CANDIDATE", storyId: "s" }),
			// Audit-sampled, offered, and the Curator kept it: leakage.
			row({ itemId: "3", verdict: "DROP", auditSampled: true, disposition: "CANDIDATE", storyId: "t" }),
			// Audit-sampled and agreed.
			row({ itemId: "4", verdict: "DROP", auditSampled: true, disposition: "IRRELEVANT" }),
			// Offered and never decided: an incomplete scan, not a screening result.
			row({ itemId: "5", verdict: "UNSURE", disposition: null }),
		]);
		expect(f.dropEvaluated).toBe(3);
		expect(f.rescued).toBe(1);
		expect(f.rescuedToCandidate).toBe(1);
		expect(f.auditSampled).toBe(2);
		expect(f.auditLeakage).toBe(1);
		expect(f.undecidedOffered).toBe(1);
	});
});

function funnel(over: Partial<ScreeningFunnel> & { date: string }): ScreeningFunnel {
	return {
		total: 1200,
		byVerdict: { DROP: 700, KEEP: 400, UNSURE: 100 },
		dropRate: 700 / 1200,
		dropEvaluated: 700,
		dropAgreed: 695,
		dropToCandidate: 5,
		dropPrecision: 695 / 700,
		lost: { materialStories: 0, finalStories: 0, mustKnowStories: 0 },
		recall: { candidate: 0.97, material: 1, final: 1, mustKnow: 1 },
		rescued: 0,
		rescuedToCandidate: 0,
		auditSampled: 0,
		auditLeakage: 0,
		undecidedOffered: 0,
		lostMustKnowStoryIds: [],
		lostFinalStoryIds: [],
		falseNegativeItemIds: [],
		...over,
	};
}

describe("assessScreeningReadiness", () => {
	const threeGoodDays = [funnel({ date: "d1" }), funnel({ date: "d2" }), funnel({ date: "d3" })];

	it("is READY when three real days of evidence clear every bar", () => {
		const r = assessScreeningReadiness(threeGoodDays);
		expect(r.verdict).toBe("READY_TO_ROUTE");
		expect(r.reasons).toEqual([]);
		expect(r.evaluatedItems).toBe(3600);
		expect(r.days).toBe(3);
	});

	it("refuses too little evidence, in items and in days", () => {
		const r = assessScreeningReadiness([funnel({ date: "d1" })]);
		expect(r.verdict).toBe("KEEP_SHADOWING");
		expect(r.reasons.join(" ")).toMatch(/1200 evaluated items; 3000 required/);
		expect(r.reasons.join(" ")).toMatch(/1 distinct day\(s\) of evidence; 3 required/);
	});

	it("refuses a lost Must Know story outright", () => {
		const r = assessScreeningReadiness([
			...threeGoodDays.slice(0, 2),
			funnel({ date: "d3", lost: { materialStories: 1, finalStories: 1, mustKnowStories: 1 }, recall: { candidate: 0.9, material: 0.9, final: 0.9, mustKnow: 0.5 } }),
		]);
		expect(r.verdict).toBe("KEEP_SHADOWING");
		expect(r.reasons.join(" ")).toMatch(/Must Know recall must be 100%/);
		expect(r.reasons.join(" ")).toMatch(/final-story recall 90.0% on d3/);
		expect(r.reasons.join(" ")).toMatch(/material recall 90.0% on d3/);
	});

	it("refuses low DROP precision even when no story was lost", () => {
		const r = assessScreeningReadiness(
			threeGoodDays.map((f) => ({ ...f, dropAgreed: 600, dropToCandidate: 100, dropPrecision: 600 / 700 })),
		);
		expect(r.verdict).toBe("KEEP_SHADOWING");
		expect(r.reasons.join(" ")).toMatch(/DROP precision 85.7%/);
	});

	it("says NOT WORTH ROUTING when recall is perfect and the DROP rate is too low to matter", () => {
		const r = assessScreeningReadiness(
			threeGoodDays.map((f) => ({
				...f,
				byVerdict: { DROP: 24, KEEP: 1000, UNSURE: 176 },
				dropRate: 0.02,
				dropEvaluated: 24,
				dropAgreed: 24,
				dropToCandidate: 0,
				dropPrecision: 1,
			})),
		);
		expect(r.verdict).toBe("NOT_WORTH_ROUTING");
		expect(r.reasons.join(" ")).toMatch(/DROP rate 2.0% is below the 30% worth-routing bar/);
	});

	it("refuses evidence days whose scans were incomplete", () => {
		const r = assessScreeningReadiness(threeGoodDays.map((f) => ({ ...f, undecidedOffered: 3 })));
		expect(r.verdict).toBe("KEEP_SHADOWING");
		expect(r.reasons.join(" ")).toMatch(/9 offered item\(s\) have no Curator decision/);
	});

	it("pins the gate values the docs quote", () => {
		expect(SCREENING_GATE).toEqual({
			minEvaluatedItems: 3000,
			minDays: 3,
			mustKnowRecall: 1,
			finalRecall: 0.98,
			materialRecall: 0.95,
			dropPrecision: 0.95,
			minDropRate: 0.3,
		});
	});
});

describe("renderScreening", () => {
	it("prints material recall and the story losses per day, beside final and Must Know", async () => {
		const { renderScreening } = await import("../src/observation/render.ts");
		const day = funnel({
			date: "2026-09-18",
			lost: { materialStories: 2, finalStories: 0, mustKnowStories: 0 },
			recall: { candidate: 0.94, material: 0.97, final: 1, mustKnow: 1 },
		});
		const out = renderScreening([day], assessScreeningReadiness([day]), { provider: "openai", model: "m", policyVersion: "v" }, "shadow");
		const header = out.split("\n").find((l) => l.includes("date") && l.includes("matl"));
		expect(header).toMatch(/cand\s+matl\s+final\s+mustKnow\s+lost\(matl\/final\/mk\)/);
		const row = out.split("\n").find((l) => l.startsWith("  2026-09-18"));
		expect(row).toMatch(/94%\s+97%\s+100%\s+100%\s+2\/0\/0$/);
	});
});
