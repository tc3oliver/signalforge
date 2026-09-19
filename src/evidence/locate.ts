/*
 * Where a quotation really is in a document, or nowhere.
 *
 * A distilling model proposes passages; this decides whether they exist. The
 * rule the rest of the system depends on: a quotation exists only if the server
 * located it, and what is published afterwards is a slice of the source, never
 * the model's own string. That distinction is the whole safety property. A model
 * that reconstructs a plausible sentence produces something that reads exactly
 * like a quotation and is not one.
 *
 * Two findings shaped this, both measured on real 2026-09-19 items.
 *
 * The first is that most apparent fabrication was not fabrication. Five quotes
 * that could not be found in `normalized_items.content` are real source text
 * interrupted by markup: the body holds `My proof has <em>not</em> been
 * independently verified`, and the model quoted the sentence a reader sees. So
 * both sides are flattened to prose before comparison, and all five locate. Of
 * 301 proposed spans, 97% to 99% relocate once that is done, against 69% to 95%
 * against raw bytes.
 *
 * The second is that fuzzy matching cannot be made safe here. Corrupting one
 * meaning-bearing word in a true quotation -- negating it, or shifting a digit
 * -- leaves a span that scores 0.95 and higher on longest-common-substring
 * coverage, while genuine model errors reached 0.87. There is no threshold that
 * separates "quoted accurately" from "quoted with the number changed", because
 * those are the same edit distance. So there is no similarity tier, no
 * edge-trimming tier, and no repair round. Exact match on a normalized copy,
 * and a miss is a miss.
 */

/**
 * A normalized copy of a text plus, for each of its characters, the index in
 * the original it came from. The map is what lets an offset found in the
 * normalized space be reported against the text the reader actually has.
 */
interface Normalized {
	text: string;
	/** `origin[i]` is the index in the source of normalized character `i`. */
	origin: number[];
}

/** Characters that carry no meaning and must not consume an index. */
const INVISIBLE = new Set(["­", "​", "‌", "‍", "﻿"]);

/**
 * Punctuation a publisher and a model spell differently for the same mark.
 * Folded before comparison so a curly apostrophe never costs a true quotation.
 */
const FOLD: Readonly<Record<string, string>> = Object.freeze({
	"‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'", "`": "'", "´": "'",
	"“": '"', "”": '"', "„": '"', "″": '"', "«": '"', "»": '"',
	"‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-",
	" ": " ", " ": " ", " ": " ", " ": " ", "　": " ",
});

/**
 * Lower-cases, folds punctuation, applies NFKC, and collapses each run of
 * whitespace to a single space, recording where every surviving character came
 * from. A run of whitespace takes the index of its first character, so a span
 * that begins after a line break still reports a sensible start.
 */
function normalize(source: string): Normalized {
	let text = "";
	const origin: number[] = [];
	let pendingSpace = -1;
	for (let i = 0; i < source.length; i += 1) {
		const ch = source[i]!;
		if (INVISIBLE.has(ch)) continue;
		if (/\s/.test(ch)) {
			// Remember the run's first index; emit at most one space, and never
			// a leading one.
			if (pendingSpace === -1) pendingSpace = i;
			continue;
		}
		if (pendingSpace !== -1) {
			if (text.length > 0) {
				text += " ";
				origin.push(pendingSpace);
			}
			pendingSpace = -1;
		}
		const folded = FOLD[ch] ?? ch;
		// NFKC per character, so a ligature or a full-width form can expand to
		// several characters that all point back at the one they came from.
		const expanded = folded.normalize("NFKC").toLowerCase();
		for (const out of expanded) {
			text += out;
			origin.push(i);
		}
	}
	return { text, origin };
}

/*
 * Quotation marks a model puts around a passage to show where it begins and
 * ends, which are not in the source.
 *
 * A live check found every proposed passage from one document wrapped in curly
 * quotes, so the longest matching prefix was one character -- the mark itself
 * -- and four correct passages were discarded. The marks are punctuation about
 * the quotation, not part of it. Stripping them cannot let a fabrication
 * through: whatever remains must still match the source exactly, and a passage
 * that genuinely carries quotation marks still matches on its inner text.
 *
 * A trailing ellipsis is the same kind of thing, a sign that the model stopped
 * early rather than a claim about the characters.
 */
const DELIMITERS = new Set(['"', "'", "\u2018", "\u2019", "\u201a", "\u201b", "\u201c", "\u201d", "\u201e", "\u00ab", "\u00bb", "`"]);

function stripDelimiters(candidate: string): string {
	let text = candidate.trim();
	let changed = true;
	while (changed && text.length > 0) {
		changed = false;
		const first = text[0]!;
		if (DELIMITERS.has(first)) {
			text = text.slice(1).trimStart();
			changed = true;
		}
		const last = text[text.length - 1];
		if (last !== undefined && DELIMITERS.has(last)) {
			text = text.slice(0, -1).trimEnd();
			changed = true;
		}
		if (text.endsWith("\u2026")) {
			text = text.slice(0, -1).trimEnd();
			changed = true;
		} else if (text.endsWith("...")) {
			text = text.slice(0, -3).trimEnd();
			changed = true;
		}
	}
	return text;
}

export interface LocatedQuote {
	/** The source's own text, sliced at the located offsets. Never the model's string. */
	quote: string;
	/** Start offset in the body that was searched. */
	at: number;
	end: number;
}

/**
 * Finds `candidate` in `body`, comparing both as normalized prose, and returns
 * the source's own characters at the location. Returns undefined when the
 * candidate does not occur, which is the only other outcome: there is no
 * approximate answer.
 *
 * `body` should already be canonical prose. Locating inside raw markup is what
 * this exists to avoid.
 */
export function locateQuote(body: string, candidate: string): LocatedQuote | undefined {
	const trimmed = stripDelimiters(candidate);
	if (trimmed.length === 0 || body.length === 0) return undefined;
	const haystack = normalize(body);
	const needle = normalize(trimmed);
	if (needle.text.length === 0) return undefined;
	const at = haystack.text.indexOf(needle.text);
	if (at === -1) return undefined;
	const start = haystack.origin[at]!;
	let end = haystack.origin[at + needle.text.length - 1]! + 1;
	// Do not split a surrogate pair when the match ends on one.
	const code = body.charCodeAt(end);
	if (code >= 0xdc00 && code <= 0xdfff) end += 1;
	return { quote: body.slice(start, end), at: start, end };
}

/**
 * Locates several candidates in one body, reusing the normalized copy.
 *
 * Duplicates are dropped: two proposed passages that resolve to the same span
 * are one piece of evidence, and paying for it twice on every later turn is
 * exactly the waste this whole path exists to remove.
 */
export function locateQuotes(
	body: string,
	candidates: readonly string[],
): { located: LocatedQuote[]; dropped: number } {
	const located: LocatedQuote[] = [];
	const seen = new Set<number>();
	let dropped = 0;
	for (const candidate of candidates) {
		const hit = locateQuote(body, candidate);
		if (!hit) {
			dropped += 1;
			continue;
		}
		if (seen.has(hit.at)) continue;
		seen.add(hit.at);
		located.push(hit);
	}
	located.sort((a, b) => a.at - b.at);
	return { located, dropped };
}
