/**
 * Providers that serve user-authored text often serve it as HTML: Hacker News
 * returns comment and Ask-HN bodies with `<p>`, `<i>` and `<a>` tags and with
 * every slash and apostrophe entity-encoded.
 *
 * Storing that verbatim in the agent-visible fields was wrong in three ways at
 * once. The curator spent context on markup, `GB&#x2F;s` read as noise rather
 * than as "GB/s", and a link-only submission normalized to a wall of anchor tags
 * with the URL buried inside an attribute. The provider's exact bytes are not
 * lost -- `raw.body` keeps them, which is what provenance means here.
 *
 * This is mechanical format normalization, the same kind of thing as mapping
 * `by` to `author`. It makes no judgement about what the text says and drops no
 * content: a link becomes "text (url)" rather than disappearing, so an attempt
 * to hide something in an attribute still reaches the agent as visible text.
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
});

/** Decodes the numeric and the handful of named entities providers actually emit. */
export function decodeHtmlEntities(input: string): string {
	return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body: string) => {
		if (body.startsWith("#x") || body.startsWith("#X")) {
			const code = Number.parseInt(body.slice(2), 16);
			return Number.isFinite(code) && code > 0 ? safeFromCodePoint(code, match) : match;
		}
		if (body.startsWith("#")) {
			const code = Number.parseInt(body.slice(1), 10);
			return Number.isFinite(code) && code > 0 ? safeFromCodePoint(code, match) : match;
		}
		return NAMED_ENTITIES[body.toLowerCase()] ?? match;
	});
}

function safeFromCodePoint(code: number, fallback: string): string {
	// A malformed or out-of-range entity is left exactly as the provider wrote it
	// rather than becoming a replacement character that hides what was there.
	if (code > 0x10ffff) return fallback;
	try {
		return String.fromCodePoint(code);
	} catch {
		return fallback;
	}
}

/**
 * Flattens provider HTML to plain text. Paragraph and line breaks become
 * newlines; a link becomes "label (href)", or just the href when the label is
 * the URL again, which is the common Hacker News shape.
 */
export function htmlToText(input: string): string {
	if (input === "") return "";

	let text = input.replace(/<\s*br\s*\/?\s*>/gi, "\n");
	text = text.replace(/<\s*\/?\s*p\s*>/gi, "\n\n");

	text = text.replace(
		/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi,
		(_match, _raw, dq: string | undefined, sq: string | undefined, bare: string | undefined, label: string) => {
			const href = decodeHtmlEntities((dq ?? sq ?? bare ?? "").trim());
			const inner = decodeHtmlEntities(stripTags(label)).trim();
			if (href === "") return inner;
			if (inner === "" || hrefMatchesLabel(href, inner)) return href;
			return `${inner} (${href})`;
		},
	);

	text = decodeHtmlEntities(stripTags(text));

	return text
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function stripTags(input: string): string {
	return input.replace(/<[^>]*>/g, "");
}

/** Hacker News truncates the visible label of a bare link; "…" makes it a prefix. */
function hrefMatchesLabel(href: string, label: string): boolean {
	const trimmed = label.replace(/\.\.\.$|…$/, "");
	return trimmed !== "" && href.startsWith(trimmed);
}
