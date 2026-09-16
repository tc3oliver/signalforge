/*
 * What a LOW-dropping filter would have cost.
 *
 * Triage runs in shadow: every item still reaches the Curator, so for every
 * prediction there is a real outcome to compare it against. That makes the
 * counterfactual exact rather than estimated -- "if we had dropped everything
 * marked LOW, these specific stories would not exist" -- which is the only
 * basis on which routing should ever be switched on.
 *
 * The recall figures are computed at the level the loss actually happens. A
 * CANDIDATE is an item, so candidate recall is an item ratio. A material, final
 * or Must Know entry is a *story*, and a story survives if any one of its items
 * survives -- five outlets cover a release, four are duplicates, dropping four
 * of them loses nothing. Measuring those at item level would overstate the
 * damage and make the filter look worse than it is; measuring candidate at
 * story level would understate it. Neither flattering direction is useful.
 */

/** Per-item prediction joined to the decision the Curator actually made. */
export interface TriageOutcomeRow {
	itemId: string;
	category: string;
	/** IRRELEVANT | DUPLICATE | CANDIDATE, or null when the item was never decided. */
	disposition: string | null;
	/** The story the decision attached the item to, if any. */
	storyId: string | null;
	reachedMaterial: boolean;
	reachedFinal: boolean;
	reachedMustKnow: boolean;
}

export interface TriageFunnel {
	total: number;
	byCategory: Record<string, number>;
	/** What ended up in the LOW bucket despite reaching each stage. */
	lowLeakage: {
		candidate: number;
		materialStories: number;
		finalStories: number;
		mustKnowStories: number;
	};
	/** Fraction a LOW-dropping filter would have retained. 1 = lossless; null = nothing to measure. */
	recall: {
		candidate: number | null;
		material: number | null;
		final: number | null;
		mustKnow: number | null;
	};
	/** Items with a prediction but no decision — an incomplete scan, not a triage result. */
	undecided: number;
	/** Story ids that would have been lost entirely. Named, because counts do not persuade. */
	lostMustKnowStoryIds: string[];
	lostFinalStoryIds: string[];
}

const LOW = "LOW";

/**
 * Recall as a filter would experience it: of everything that mattered, how much
 * survives the drop.
 */
function ratio(kept: number, total: number): number | null {
	return total === 0 ? null : kept / total;
}

/** Stories reaching a stage, split by whether any of their items escaped the LOW bucket. */
function storySurvival(
	rows: readonly TriageOutcomeRow[],
	reached: (r: TriageOutcomeRow) => boolean,
): { total: number; survived: number; lost: string[] } {
	const byStory = new Map<string, { anyKept: boolean }>();
	for (const row of rows) {
		if (!reached(row) || row.storyId === null) continue;
		const entry = byStory.get(row.storyId) ?? { anyKept: false };
		if (row.category !== LOW) entry.anyKept = true;
		byStory.set(row.storyId, entry);
	}
	const lost = [...byStory.entries()].filter(([, v]) => !v.anyKept).map(([id]) => id);
	return { total: byStory.size, survived: byStory.size - lost.length, lost };
}

export function buildTriageFunnel(rows: readonly TriageOutcomeRow[]): TriageFunnel {
	const byCategory: Record<string, number> = {
		PRIORITY: 0,
		NORMAL: 0,
		LOW: 0,
		DUPLICATE_HINT: 0,
		UNCERTAIN: 0,
	};
	let undecided = 0;
	let candidateTotal = 0;
	let candidateLow = 0;

	for (const row of rows) {
		byCategory[row.category] = (byCategory[row.category] ?? 0) + 1;
		if (row.disposition === null) undecided++;
		if (row.disposition === "CANDIDATE") {
			candidateTotal++;
			if (row.category === LOW) candidateLow++;
		}
	}

	const material = storySurvival(rows, (r) => r.reachedMaterial);
	const final = storySurvival(rows, (r) => r.reachedFinal);
	const mustKnow = storySurvival(rows, (r) => r.reachedMustKnow);

	return {
		total: rows.length,
		byCategory,
		lowLeakage: {
			candidate: candidateLow,
			materialStories: material.lost.length,
			finalStories: final.lost.length,
			mustKnowStories: mustKnow.lost.length,
		},
		recall: {
			candidate: ratio(candidateTotal - candidateLow, candidateTotal),
			material: ratio(material.survived, material.total),
			final: ratio(final.survived, final.total),
			mustKnow: ratio(mustKnow.survived, mustKnow.total),
		},
		undecided,
		lostMustKnowStoryIds: mustKnow.lost,
		lostFinalStoryIds: final.lost,
	};
}

/** The bar routing must clear before it may be switched on. */
export const ROUTING_GATE = {
	/** Anything below this on Must Know is disqualifying, full stop. */
	mustKnowRecall: 1,
	finalRecall: 0.98,
	/** Consecutive clean days of shadow evidence required alongside the recall figures. */
	requiredDays: 5,
} as const;

export interface RoutingReadiness {
	ready: boolean;
	reasons: string[];
}

/**
 * Whether the evidence would justify letting triage route.
 *
 * Deliberately conservative and deliberately not automatic: this returns a
 * verdict for a human to read, and nothing in the pipeline consults it. Turning
 * filtering on stays a decision someone makes after looking at the numbers.
 */
export function assessRoutingReadiness(funnels: readonly TriageFunnel[]): RoutingReadiness {
	const reasons: string[] = [];
	if (funnels.length < ROUTING_GATE.requiredDays) {
		reasons.push(
			`${funnels.length} day(s) of shadow evidence; ${ROUTING_GATE.requiredDays} required.`,
		);
	}
	const lostMustKnow = funnels.reduce((n, f) => n + f.lowLeakage.mustKnowStories, 0);
	if (lostMustKnow > 0) {
		reasons.push(
			`${lostMustKnow} Must Know story/ies would have been lost. Must Know recall must be 100%.`,
		);
	}
	for (const f of funnels) {
		if (f.recall.final !== null && f.recall.final < ROUTING_GATE.finalRecall) {
			reasons.push(
				`final-story recall ${(f.recall.final * 100).toFixed(1)}% is below the ` +
					`${(ROUTING_GATE.finalRecall * 100).toFixed(0)}% gate on at least one day.`,
			);
			break;
		}
	}
	return { ready: reasons.length === 0, reasons };
}
