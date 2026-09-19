import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { htmlToText } from "../collectors/html-text.ts";
import type { NormalizedItem } from "../schemas/index.ts";
import { ok, ToolRejection } from "./shared.ts";

/*
 * The addressable form of an item body, and the one way to read it.
 *
 * `normalized_items.content` is whatever the source served, which for most RSS
 * items is HTML. Across the 2026-09-19 manifest that is 30% markup by volume,
 * and on individual items far more: one 16,419-character record is 4,765
 * characters of prose, another 37,318 is 12,017. Markup is not merely wasted
 * context. An offset into raw HTML is meaningless as a handle, and a sentence a
 * reader sees whole is split by tags in the bytes -- which is why five quotes
 * that looked fabricated turned out to be real text with an <em> in the middle.
 *
 * So every character offset an agent is given, and every window it reads, is
 * expressed in this projection and never in the raw bytes. `htmlToText` is the
 * collectors' own normalizer, reused rather than reimplemented so the
 * agent-visible text cannot drift from the text collection already produces.
 *
 * This lives here, shared, because both stages had the same bug and only one of
 * them had been fixed. The Curator stopped pouring whole articles into its
 * session on 2026-09-19; the Editor was still doing it in the same run, and at
 * a worse rate -- two `get_source_items` calls for 152,078 characters, one of
 * them 107,353. Two implementations of "read part of a document" would have
 * drifted, and the half that drifted would have been the one nobody was
 * measuring.
 */

/*
 * Canonical prose for an item: what a reader sees, not what the source served.
 *
 * `content` first, and `summary` when there is no content. That fallback is not
 * a convenience -- 6,276 of the 11,038 stored items have `content IS NULL`,
 * because GitHub releases and arXiv entries carry their whole body in `summary`
 * and nothing else. Reading the body of one of those returned the empty string
 * and answered "this item has no body text", so for the majority of the corpus
 * the bounded reader was inert and `find` could not reach a single word. The
 * largest such item is 124,924 characters of release notes.
 *
 * `htmlToText` is safe on both: checked against the stored GitHub bodies, it
 * strips HTML comments and normalises CRLF while leaving Markdown headings,
 * lists and fenced code intact -- which matters, because a fenced block is
 * exactly where the quotable text of a release note lives.
 */
export function canonicalBody(item: NormalizedItem): string {
	const content = htmlToText(item.content ?? "");
	if (content.length > 0) return content;
	return htmlToText(item.summary ?? "");
}

/** True when the body above came from `summary` because there was no content. */
export function bodyIsSummary(item: NormalizedItem): boolean {
	return htmlToText(item.content ?? "").length === 0 && (item.summary ?? "").length > 0;
}

/** Characters of body a single window may carry. */
export const BODY_WINDOW_DEFAULT = 2000;
export const BODY_WINDOW_MAX = 3000;

/** How many match offsets a `find` reports before it stops counting. */
const MAX_MATCHES = 8;

export interface BodyWindowOptions {
	/** Tool name, so the two stages can use wording that fits their job. */
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	/** Resolves an id to an item, or undefined when the agent may not see it. */
	lookup: (itemId: string) => NormalizedItem | undefined;
	/** What to say when the id is not one this agent can read. */
	unknownIdMessage: (itemId: string) => string;
	note?: (name: string, summary: Record<string, unknown>) => void;
}

/**
 * A tool that reads one window of one item's canonical prose.
 *
 * Two things make a window usable rather than a lottery. It is taken over the
 * canonical prose, so offsets mean something and no budget is spent on markup.
 * And it is addressed by content: `find` locates a term and returns the passage
 * around it plus every other place it occurs, so the agent never has to guess a
 * number. Paging by offset remains possible and is the thing you do second,
 * with an offset the tool itself handed you.
 *
 * A miss is an answer, not a rejection. A ToolRejection reads to a model as
 * "call this differently", and the different call it would reach for is the
 * expensive one -- so "that word is not in this document" comes back as a
 * result, having cost one turn instead of two.
 */
export function defineReadBodyTool(opts: BodyWindowOptions): ToolDefinition {
	return defineTool({
		name: opts.name,
		label: opts.label,
		description: opts.description,
		promptSnippet: opts.promptSnippet,
		parameters: Type.Object({
			itemId: Type.String({ minLength: 1 }),
			/*
			 * Two characters, not three. The briefs are written in 正體中文 and the
			 * terms worth jumping to are routinely two characters -- 降息, 升息, 裁員,
			 * 併購 -- each of which a three-character floor refuses before the tool
			 * runs, leaving offset paging as the only way to reach the passage.
			 */
			find: Type.Optional(Type.String({ minLength: 2, maxLength: 120 })),
			start: Type.Optional(Type.Integer({ minimum: 0 })),
			length: Type.Optional(Type.Integer({ minimum: 200, maximum: BODY_WINDOW_MAX })),
		}),
		execute: async (_id, params) => {
			const item = opts.lookup(params.itemId);
			if (!item) throw new ToolRejection(opts.unknownIdMessage(params.itemId));

			const body = canonicalBody(item);
			if (body.length === 0) {
				opts.note?.(opts.name, { itemId: params.itemId, bodyChars: 0 });
				return ok({
					itemId: item.id,
					trust: item.trust,
					bodyChars: 0,
					text: "",
					note: "This item has no body text; the title and summary are all there is.",
				});
			}

			const length = Math.min(params.length ?? BODY_WINDOW_DEFAULT, BODY_WINDOW_MAX);
			const matches: number[] = [];
			let start = Math.min(params.start ?? 0, Math.max(0, body.length - 1));
			if (params.find !== undefined) {
				const haystack = body.toLowerCase();
				const needle = params.find.toLowerCase();
				for (
					let at = haystack.indexOf(needle);
					at !== -1 && matches.length < MAX_MATCHES;
					at = haystack.indexOf(needle, at + 1)
				) {
					matches.push(at);
				}
				if (matches.length === 0) {
					opts.note?.(opts.name, { itemId: params.itemId, find: params.find, matches: 0 });
					return ok({
						itemId: item.id,
						trust: item.trust,
						bodyChars: body.length,
						text: "",
						matches: 0,
						note: `"${params.find}" does not appear in this item's body. Try another term, or read from the start with no find.`,
					});
				}
				// Centre the window on the first match, keeping some lead-in.
				start = Math.max(0, matches[0]! - Math.floor(length / 3));
			}
			const end = Math.min(body.length, start + length);
			opts.note?.(opts.name, {
				itemId: params.itemId,
				...(params.find !== undefined ? { find: params.find, matches: matches.length } : {}),
				start,
				returned: end - start,
				bodyChars: body.length,
			});
			return ok({
				itemId: item.id,
				/*
				 * On every window, not only on the record that led here. This is the
				 * result that carries raw source prose, and it is the one an injection
				 * attempt would arrive in; the system prompt tells both stages the text
				 * is tagged, so the tag has to be on the text.
				 */
				trust: item.trust,
				bodyChars: body.length,
				start,
				returnedChars: end - start,
				text: body.slice(start, end),
				hasMoreBefore: start > 0,
				hasMoreAfter: end < body.length,
				...(matches.length > 0 ? { matchOffsets: matches } : {}),
				...(end < body.length ? { nextStart: end } : {}),
			});
		},
	});
}
