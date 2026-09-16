/*
 * Why a story the owner expected never appeared.
 *
 * "Crypto coverage feels thin" is not actionable, because the four things that
 * could cause it need opposite fixes. If nothing was collected, adding weight to
 * the topic does nothing and adding a source is the answer. If the item was
 * collected and the Curator called it irrelevant, adding a source makes it
 * strictly worse — more items, same judgement. Guessing between those and
 * acting on the guess is how a personalization profile gets tuned in the wrong
 * direction and stays there, so this file refuses to guess: it reports the last
 * stage that has a row, and UNKNOWN when it cannot tell.
 *
 * It runs only on a title or URL the owner supplies from their own recall,
 * after they have written down what they expected to see. It performs no web
 * search and contacts nothing: the question is what this pipeline did with what
 * it had, and an answer sourced from the open internet would not be that.
 */

export type MissAttribution =
	| "PUBLISHED"
	| "SOURCE_MISS"
	| "CURATOR_MISS"
	| "MATERIAL_MISS"
	| "EDITOR_MISS"
	| "UNKNOWN";

/** What each verdict means, printed with the result so it needs no lookup. */
export const ATTRIBUTION_MEANING: Record<MissAttribution, string> = {
	PUBLISHED: "It did reach the brief. The expectation and the output agree.",
	SOURCE_MISS: "No raw or normalized item matched. The data plane never saw it; ranking is not the problem.",
	CURATOR_MISS:
		"The item was collected and scanned, but no story was promoted from it. " +
		"A relevance/personalization finding, not a coverage one.",
	MATERIAL_MISS: "A story existed that day but the Curator did not hand it to the Editor. Material selection.",
	EDITOR_MISS: "It was in the materials and the Editor did not publish it. Editor prioritisation.",
	UNKNOWN: "Not enough evidence to attribute. Record the exact title or URL and re-run.",
};

/** Which rows were found, per stage, for one expected story. */
export interface StageHits {
	/** normalized_items rows matching the pattern. */
	items: Array<{ itemId: string; sourceName: string; title: string; publishedAt: string | null }>;
	/** item_decisions rows for those items on the day. */
	decisions: Array<{ itemId: string; disposition: string; storyId: string | null; reason: string }>;
	/** story_ledger rows for the day. */
	candidates: Array<{ storyId: string; canonicalTitle: string; relevance: number; reason: string }>;
	/** daily_material_stories rows for the day. */
	materials: Array<{ storyId: string; tier: string; canonicalTitle: string }>;
	/** daily_brief_stories rows for the day. */
	finals: Array<{ storyId: string; section: string; mustKnow: boolean; title: string }>;
}

/** `IRRELEVANT x8, DUPLICATE x3`, descending. Keeps a wide match legible. */
export function summarise(values: readonly string[]): string {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
		.map(([value, n]) => (n === 1 ? value : `${value} x${n}`))
		.join(", ");
}

export interface AttributionResult {
	verdict: MissAttribution;
	meaning: string;
	/** The reasoning, in the order the stages were checked. */
	evidence: string[];
}

/**
 * Walk the stages forwards and report the first one that has nothing.
 *
 * Forwards rather than backwards on purpose. Checking from the brief down would
 * report EDITOR_MISS for a story that was never collected, because "absent from
 * the brief" is true at every stage of a total miss; the diagnosis has to be the
 * first gap, not the last.
 */
export function attributeMiss(hits: StageHits): AttributionResult {
	const evidence: string[] = [];

	if (hits.items.length === 0) {
		evidence.push("normalized_items: no match");
		return { verdict: "SOURCE_MISS", meaning: ATTRIBUTION_MEANING.SOURCE_MISS, evidence };
	}
	evidence.push(`normalized_items: ${hits.items.length} match(es) — ${summarise(hits.items.map((i) => i.sourceName))}`);

	if (hits.decisions.length === 0) {
		// The scan-coverage guarantee says every manifest item gets a decision, so
		// a collected item with no decision row means it was not in that day's
		// manifest at all -- a catch-up window or cap question, not a judgement.
		evidence.push("item_decisions: none — the item was never put in front of the Curator that day");
		return { verdict: "UNKNOWN", meaning: ATTRIBUTION_MEANING.UNKNOWN, evidence };
	}
	// Dispositions, not item ids: "nine of these were IRRELEVANT" is the finding,
	// and a list of forty opaque ids buries it.
	evidence.push(`item_decisions: ${summarise(hits.decisions.map((d) => d.disposition))}`);

	if (hits.candidates.length === 0) {
		evidence.push("story_ledger: no story on this date");
		return { verdict: "CURATOR_MISS", meaning: ATTRIBUTION_MEANING.CURATOR_MISS, evidence };
	}
	evidence.push(
		`story_ledger: ${hits.candidates
			.map((c) => `${c.storyId} (relevance ${c.relevance.toFixed(2)})`)
			.join(", ")}`,
	);

	if (hits.materials.length === 0) {
		evidence.push("daily_material_stories: not handed to the Editor");
		return { verdict: "MATERIAL_MISS", meaning: ATTRIBUTION_MEANING.MATERIAL_MISS, evidence };
	}
	evidence.push(`daily_material_stories: ${hits.materials.map((m) => `${m.storyId} tier=${m.tier}`).join(", ")}`);

	if (hits.finals.length === 0) {
		evidence.push("daily_brief_stories: not published");
		return { verdict: "EDITOR_MISS", meaning: ATTRIBUTION_MEANING.EDITOR_MISS, evidence };
	}
	evidence.push(
		`daily_brief_stories: ${hits.finals
			.map((f) => `${f.storyId} section=${f.section}${f.mustKnow ? " MUST_KNOW" : ""}`)
			.join(", ")}`,
	);
	return { verdict: "PUBLISHED", meaning: ATTRIBUTION_MEANING.PUBLISHED, evidence };
}
