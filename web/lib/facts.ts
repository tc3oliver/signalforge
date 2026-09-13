import type { StructuredFact } from "../../src/schemas/fact.ts";

/*
 * Numbers in this product come from `structured_facts` and nowhere else. The
 * editor agent may only cite a factId; the value, unit and as-of stamp are read
 * back out of the store at render time, exactly as src/renderer/markdown.ts
 * does. A number that appears in model prose has no path into this module.
 */

export interface ResolvedFact {
	factId: string;
	status: "resolved";
	fact: StructuredFact;
}

export interface MissingFact {
	factId: string;
	status: "missing";
}

export type FactResolution = ResolvedFact | MissingFact;

/**
 * The markdown renderer throws on an unknown factRef because a brief is written
 * once and a broken reference must fail the pipeline. The reader is downstream
 * of that and serves whatever is already published, so an unknown ref is
 * surfaced as an explicit gap instead of a 500 — and never as a number.
 */
export function resolveFactRefs(
	factRefs: readonly string[],
	facts: readonly StructuredFact[],
): FactResolution[] {
	const byId = new Map(facts.map((f) => [f.factId, f] as const));
	return factRefs.map((factId) => {
		const fact = byId.get(factId);
		return fact ? { factId, status: "resolved", fact } : { factId, status: "missing" };
	});
}

/** Number formatting that never rounds a stored value away. */
function formatNumber(value: number): string {
	if (!Number.isFinite(value)) return String(value);
	if (Number.isInteger(value)) return value.toLocaleString("en-US");
	return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

/** "BTC spot: 64,120.5 USD" — the canonical value, straight from the store. */
export function formatFactValue(fact: StructuredFact): string {
	return `${formatNumber(fact.value)}${fact.unit}`;
}

export interface FactLine {
	label: string;
	value: string;
	asOf: string;
	previous: string | undefined;
	change: string | undefined;
	sourceItemId: string;
}

export function factLine(fact: StructuredFact): FactLine {
	return {
		label: fact.label,
		value: formatFactValue(fact),
		asOf: fact.asOf,
		previous:
			fact.previousValue === undefined
				? undefined
				: `${formatNumber(fact.previousValue)}${fact.unit}`,
		change:
			fact.changePct === undefined
				? undefined
				: `${fact.changePct > 0 ? "+" : ""}${formatNumber(fact.changePct)}%`,
		sourceItemId: fact.sourceItemId,
	};
}
