import type { TriageRules } from "./rules.ts";
import type { TriageInput, TriageResult } from "./types.ts";

/*
 * Whole-manifest triage: per-item rules, then one pass that can only be done
 * with the siblings in view.
 */

/** Words too common in headlines to distinguish one story from another. */
const STOPWORDS = new Set([
	"the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "at", "by",
	"from", "as", "is", "are", "was", "were", "be", "been", "it", "its", "this", "that", "new",
	"says", "said", "after", "over", "into", "amid", "how", "why", "what",
]);

/**
 * The comparable core of a title: lowercased, stripped of punctuation and
 * stopwords, deduplicated and sorted.
 *
 * Sorted because five outlets covering one release write the same nouns in five
 * different orders, and word order is the part that varies. Deliberately crude:
 * this is a hint for the Curator's clustering, not a merge decision, and the
 * Curator has `search_items` and the full text to settle it properly.
 */
export function titleKey(title: string): string {
	const words = title
		.toLowerCase()
		.split(/[^a-z0-9一-鿿.+#-]+/)
		.filter((w) => w.length > 2 && !STOPWORDS.has(w));
	return [...new Set(words)].sort().join(" ");
}

/** How many shared significant words make two titles look like one event. */
const MIN_SHARED_WORDS = 4;

function sharedWords(a: readonly string[], b: readonly string[]): number {
	const set = new Set(a);
	return b.filter((w) => set.has(w)).length;
}

/**
 * Classify every item, then mark later coverage of an event already seen.
 *
 * Only ever *downgrades to* DUPLICATE_HINT, and never from PRIORITY: if a
 * watched repo cut a release and three outlets wrote it up, the release itself
 * must stay PRIORITY and the write-ups are the duplicates. The first occurrence
 * in manifest order (publication order) keeps its category.
 */
export function triageManifest(inputs: readonly TriageInput[], rules: TriageRules): TriageResult[] {
	const results = inputs.map((input) => rules.classify(input));

	const keys = inputs.map((i) => titleKey(i.title).split(" ").filter((w) => w.length > 0));
	const seen: Array<{ index: number; words: string[] }> = [];

	for (let i = 0; i < inputs.length; i++) {
		const words = keys[i] as string[];
		const current = results[i] as TriageResult;
		if (words.length < MIN_SHARED_WORDS) {
			seen.push({ index: i, words });
			continue;
		}
		const match = seen.find((prior) => sharedWords(prior.words, words) >= MIN_SHARED_WORDS);
		if (match && current.category !== "PRIORITY") {
			results[i] = {
				...current,
				category: "DUPLICATE_HINT",
				ruleId: "duplicate-title-shingle",
				reason: `shares ${MIN_SHARED_WORDS}+ significant title words with ${inputs[match.index]?.itemId ?? "an earlier item"}`,
			};
		}
		seen.push({ index: i, words });
	}

	return results;
}

/** Counts per category, for the shadow-mode report. */
export function triageTally(results: readonly TriageResult[]): Record<string, number> {
	const counts: Record<string, number> = {
		PRIORITY: 0,
		NORMAL: 0,
		LOW: 0,
		DUPLICATE_HINT: 0,
		UNCERTAIN: 0,
	};
	for (const r of results) counts[r.category] = (counts[r.category] ?? 0) + 1;
	return counts;
}
