/*
 * What routing on the screener's DROP verdicts would cost, and whether it is
 * worth it.
 *
 * Every screening verdict is compared against what the Curator, the material
 * selection and the Editor then actually did with the item. In shadow mode
 * (and in a backfill over a past day) every item reached the Curator, so the
 * comparison is exact: "had we withheld every DROP, these specific stories
 * would have lost these specific items". In route mode the DROPs that were
 * withheld have no Curator decision -- unless the Curator rescued them -- so
 * ground truth on DROP comes from the audit sample and from rescues, and the
 * report says which.
 *
 * Recall is measured where the loss happens. A CANDIDATE is an item, so
 * candidate recall is an item ratio. Material, final and Must Know are
 * stories, and a story survives if any one of its items survives: five outlets
 * cover a release, four are DROPped, nothing is lost.
 */

/** One screening verdict joined to the item's downstream fate. */
export interface ScreeningOutcomeRow {
	itemId: string;
	verdict: "DROP" | "KEEP" | "UNSURE";
	auditSampled: boolean;
	routed: boolean;
	/** IRRELEVANT | DUPLICATE | CANDIDATE, or null when the item has no Curator decision. */
	disposition: string | null;
	storyId: string | null;
	reachedMaterial: boolean;
	reachedFinal: boolean;
	reachedMustKnow: boolean;
}

export interface ScreeningFunnel {
	date: string;
	total: number;
	byVerdict: { DROP: number; KEEP: number; UNSURE: number };
	dropRate: number | null;
	/**
	 * DROP verdicts with a Curator decision to compare against. Every DROP in
	 * shadow; only audit samples and rescues in route.
	 */
	dropEvaluated: number;
	/** Of the evaluated DROPs, how many the Curator also set aside (IRRELEVANT or DUPLICATE). */
	dropAgreed: number;
	/** Of the evaluated DROPs, how many the Curator made a CANDIDATE: the false negatives. */
	dropToCandidate: number;
	dropPrecision: number | null;
	/** Story-level losses a full DROP filter would have caused. */
	lost: { materialStories: number; finalStories: number; mustKnowStories: number };
	recall: { candidate: number | null; material: number | null; final: number | null; mustKnow: number | null };
	/** Routed DROPs the Curator decided anyway (route mode only). */
	rescued: number;
	rescuedToCandidate: number;
	/** Audit-sampled DROPs, and how many of them the Curator kept. */
	auditSampled: number;
	auditLeakage: number;
	/** KEEP/UNSURE items with no decision: an incomplete scan, not a screening result. */
	undecidedOffered: number;
	lostMustKnowStoryIds: string[];
	lostFinalStoryIds: string[];
	/** Curator dispositions on the false negatives, by source, for pattern-spotting. */
	falseNegativeItemIds: string[];
}

function ratio(kept: number, total: number): number | null {
	return total === 0 ? null : kept / total;
}

/** Stories reaching a stage, split by whether any of their items escaped DROP. */
function storySurvival(
	rows: readonly ScreeningOutcomeRow[],
	reached: (r: ScreeningOutcomeRow) => boolean,
): { total: number; survived: number; lost: string[] } {
	const byStory = new Map<string, { anyKept: boolean }>();
	for (const row of rows) {
		if (!reached(row) || row.storyId === null) continue;
		const entry = byStory.get(row.storyId) ?? { anyKept: false };
		if (row.verdict !== "DROP") entry.anyKept = true;
		byStory.set(row.storyId, entry);
	}
	const lost = [...byStory.entries()].filter(([, v]) => !v.anyKept).map(([id]) => id);
	return { total: byStory.size, survived: byStory.size - lost.length, lost };
}

export function buildScreeningFunnel(date: string, rows: readonly ScreeningOutcomeRow[]): ScreeningFunnel {
	const byVerdict = { DROP: 0, KEEP: 0, UNSURE: 0 };
	let dropEvaluated = 0;
	let dropAgreed = 0;
	let dropToCandidate = 0;
	let candidateTotal = 0;
	let candidateDropped = 0;
	let rescued = 0;
	let rescuedToCandidate = 0;
	let auditSampled = 0;
	let auditLeakage = 0;
	let undecidedOffered = 0;
	const falseNegativeItemIds: string[] = [];

	for (const row of rows) {
		byVerdict[row.verdict] += 1;
		if (row.disposition === "CANDIDATE") {
			candidateTotal += 1;
			if (row.verdict === "DROP") candidateDropped += 1;
		}
		if (row.verdict === "DROP") {
			if (row.auditSampled) {
				auditSampled += 1;
				if (row.disposition === "CANDIDATE") auditLeakage += 1;
			}
			if (row.routed && row.disposition !== null) {
				rescued += 1;
				if (row.disposition === "CANDIDATE") rescuedToCandidate += 1;
			}
			if (row.disposition !== null) {
				dropEvaluated += 1;
				if (row.disposition === "CANDIDATE") {
					dropToCandidate += 1;
					falseNegativeItemIds.push(row.itemId);
				} else {
					dropAgreed += 1;
				}
			}
		} else if (row.disposition === null) {
			undecidedOffered += 1;
		}
	}

	const material = storySurvival(rows, (r) => r.reachedMaterial);
	const final = storySurvival(rows, (r) => r.reachedFinal);
	const mustKnow = storySurvival(rows, (r) => r.reachedMustKnow);

	return {
		date,
		total: rows.length,
		byVerdict,
		dropRate: ratio(byVerdict.DROP, rows.length),
		dropEvaluated,
		dropAgreed,
		dropToCandidate,
		dropPrecision: ratio(dropAgreed, dropEvaluated),
		lost: {
			materialStories: material.lost.length,
			finalStories: final.lost.length,
			mustKnowStories: mustKnow.lost.length,
		},
		recall: {
			candidate: ratio(candidateTotal - candidateDropped, candidateTotal),
			material: ratio(material.survived, material.total),
			final: ratio(final.survived, final.total),
			mustKnow: ratio(mustKnow.survived, mustKnow.total),
		},
		rescued,
		rescuedToCandidate,
		auditSampled,
		auditLeakage,
		undecidedOffered,
		lostMustKnowStoryIds: mustKnow.lost,
		lostFinalStoryIds: final.lost,
		falseNegativeItemIds,
	};
}

/**
 * The bar routing must clear before a human switches it on.
 *
 * Evidence is counted in items and in distinct days, not in calendar days
 * waited: a backfill over three real production days with known outcomes is
 * evidence of exactly the same kind as three future shadow days, and it is
 * available now. The gate is about false-negative routing, not about ritual.
 *
 * The economic bar is separate from the safety bar and reported separately.
 * A screener that never loses anything and drops 2% of items is safe and
 * pointless, and the verdict has to say so rather than "READY".
 */
/*
 * Where the numbers come from. The 2026-09-16..18 backtest (3971 items, three
 * policy versions, ~2.9M tokens) showed that item-level DROP precision is
 * dominated by items whose STORY survives anyway: opinion pieces the Curator
 * clusters into one debate story, funding items the Curator makes a story of
 * and then does not hand to the Editor. v3 ran at 96.9% precision with 100%
 * final and Must Know recall on every day. The bars that protect the brief are
 * the story-level ones; precision and material recall are the early-warning
 * bars, set where a real regression would trip them rather than where noise
 * does.
 */
export const SCREENING_GATE = {
	minEvaluatedItems: 3000,
	minDays: 3,
	mustKnowRecall: 1,
	finalRecall: 0.98,
	materialRecall: 0.95,
	dropPrecision: 0.95,
	minDropRate: 0.3,
} as const;

export type ScreeningVerdictLabel = "READY_TO_ROUTE" | "KEEP_SHADOWING" | "NOT_WORTH_ROUTING";

export interface ScreeningReadiness {
	verdict: ScreeningVerdictLabel;
	reasons: string[];
	evaluatedItems: number;
	days: number;
}

function sum(funnels: readonly ScreeningFunnel[], pick: (f: ScreeningFunnel) => number): number {
	return funnels.reduce((n, f) => n + pick(f), 0);
}

export function assessScreeningReadiness(funnels: readonly ScreeningFunnel[]): ScreeningReadiness {
	const safety: string[] = [];
	const evidence: string[] = [];
	const economics: string[] = [];

	const evaluatedItems = sum(funnels, (f) => f.dropEvaluated + f.byVerdict.KEEP + f.byVerdict.UNSURE);
	const days = new Set(funnels.map((f) => f.date)).size;
	if (evaluatedItems < SCREENING_GATE.minEvaluatedItems) {
		evidence.push(`${evaluatedItems} evaluated items; ${SCREENING_GATE.minEvaluatedItems} required.`);
	}
	if (days < SCREENING_GATE.minDays) {
		evidence.push(`${days} distinct day(s) of evidence; ${SCREENING_GATE.minDays} required.`);
	}

	const lostMustKnow = sum(funnels, (f) => f.lost.mustKnowStories);
	if (lostMustKnow > 0) {
		safety.push(`${lostMustKnow} Must Know story/ies would have been lost. Must Know recall must be 100%.`);
	}
	for (const f of funnels) {
		if (f.recall.final !== null && f.recall.final < SCREENING_GATE.finalRecall) {
			safety.push(
				`final-story recall ${(f.recall.final * 100).toFixed(1)}% on ${f.date} is below the ${(SCREENING_GATE.finalRecall * 100).toFixed(0)}% gate.`,
			);
		}
	}
	for (const f of funnels) {
		if (f.recall.material !== null && f.recall.material < SCREENING_GATE.materialRecall) {
			safety.push(
				`material recall ${(f.recall.material * 100).toFixed(1)}% on ${f.date} is below the ${(SCREENING_GATE.materialRecall * 100).toFixed(0)}% gate.`,
			);
		}
	}
	const dropEvaluated = sum(funnels, (f) => f.dropEvaluated);
	const dropAgreed = sum(funnels, (f) => f.dropAgreed);
	const precision = ratio(dropAgreed, dropEvaluated);
	if (precision !== null && precision < SCREENING_GATE.dropPrecision) {
		safety.push(
			`DROP precision ${(precision * 100).toFixed(1)}% (${dropEvaluated - dropAgreed} of ${dropEvaluated} evaluated DROPs became CANDIDATE) is below the ${(SCREENING_GATE.dropPrecision * 100).toFixed(0)}% gate.`,
		);
	}
	const undecided = sum(funnels, (f) => f.undecidedOffered);
	if (undecided > 0) {
		safety.push(`${undecided} offered item(s) have no Curator decision; the evidence days are not complete scans.`);
	}

	const total = sum(funnels, (f) => f.total);
	const drops = sum(funnels, (f) => f.byVerdict.DROP);
	const dropRate = ratio(drops, total);
	if (dropRate !== null && dropRate < SCREENING_GATE.minDropRate) {
		economics.push(
			`DROP rate ${(dropRate * 100).toFixed(1)}% is below the ${(SCREENING_GATE.minDropRate * 100).toFixed(0)}% worth-routing bar: routing would be safe and would save little.`,
		);
	}

	if (evidence.length > 0 || safety.length > 0) {
		return { verdict: "KEEP_SHADOWING", reasons: [...evidence, ...safety, ...economics], evaluatedItems, days };
	}
	if (economics.length > 0) {
		return { verdict: "NOT_WORTH_ROUTING", reasons: economics, evaluatedItems, days };
	}
	return { verdict: "READY_TO_ROUTE", reasons: [], evaluatedItems, days };
}

/** Provider-reported usage for one stage across a set of runs, or the fact that it was not reported. */
export interface StageUsage {
	stage: string;
	attempts: number;
	/** Attempts that carried a usage block. */
	reported: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	wallClockMs: number;
}
