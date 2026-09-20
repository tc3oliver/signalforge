import type { StoryLedgerEntry } from "../../src/schemas/index.ts";
import type { BriefAppearance } from "../../src/db/briefs.ts";

/*
 * Identity and presentation, kept apart.
 *
 * `storyId` and `canonicalTitle` are the curator's internal handles for an
 * event. The id is a URL and a foreign key and never changes. The canonical
 * title is what the curator called the cluster while working, and it is
 * frequently English -- "AI-hallucinated intelligence nearly triggered a US
 * operation" -- even though every brief that published the story is written in
 * Chinese. Before this module the story page showed that handle as its <h1>,
 * its <title> and its share card, so a reader who followed a Chinese headline
 * from the dashboard arrived at an English page about the same event.
 *
 * The editorial title is the one a reader was actually shown, written for the
 * brief. It is the right thing to display and the wrong thing to key off, so
 * nothing here is used for lookup, routing, canonical URLs or storage.
 */

/**
 * What to call this story to a reader.
 *
 * `appearances` is newest-first, so the newest published wording wins: a story
 * whose framing changed over four days should read as it was last published,
 * not as it was first filed. A story the curator kept but no brief ever
 * published has no editorial title at all, and falls back to the handle.
 */
export function storyDisplayTitle(
	appearances: readonly BriefAppearance[],
	latest: Pick<StoryLedgerEntry, "canonicalTitle">,
): string {
	return appearances[0]?.title ?? latest.canonicalTitle;
}

/**
 * How to describe this story in a meta description or a share card.
 *
 * `whatHappened` is the brief's own account of the event, written for a reader.
 * The ledger's `reason` is the curator's note on why the cluster was worth
 * keeping -- accurate, but addressed to the pipeline rather than to a person.
 */
export function storyDisplayDescription(
	appearances: readonly BriefAppearance[],
	latest: Pick<StoryLedgerEntry, "reason">,
): string {
	return appearances[0]?.whatHappened ?? latest.reason;
}

/**
 * The title for one day on the timeline.
 *
 * Per-day rather than latest: the timeline exists to show how the story was
 * described as it developed, so collapsing every row to the current headline
 * would delete the thing it is there to show. A day the story was tracked but
 * not published keeps the handle, which is genuinely what existed that day.
 */
export function timelineDisplayTitle(
	appearance: Pick<BriefAppearance, "title"> | undefined,
	entry: Pick<StoryLedgerEntry, "canonicalTitle">,
): string {
	return appearance?.title ?? entry.canonicalTitle;
}
