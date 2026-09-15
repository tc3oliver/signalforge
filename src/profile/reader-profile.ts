import { createHash } from "node:crypto";
import type { InterestsConfig, InterestTopic } from "../config/schema.ts";

/*
 * The reader, as something both agents can see.
 *
 * `config/interests.yaml` has been loaded, validated and strictly typed since
 * the pipeline was written, and until now its only production reader was the
 * setup check, which printed a topic count. The Curator scored relevance and the
 * Editor chose what led the brief against a single hardcoded sentence -- "a
 * technically sophisticated engineer who works in AI and software" -- while a
 * carefully weighted topic list sat in a file nothing consumed.
 *
 * The binding constraint on this whole path, stated in docs/INTELLIGENCE_BACKLOG
 * and enforced by the prompt text below: weights are priors, not filters. A
 * weight may move a story up or down. It may never justify skipping an item's
 * decision, marking something IRRELEVANT because it is off-topic, or dropping a
 * high-importance story that no topic happens to name. The scan-coverage
 * guarantee does not bend for taste.
 */

export interface ReaderProfile {
	topics: InterestTopic[];
	persona: string;
	/** Hash of the effective profile, so a brief can record what shaped it. */
	version: string;
}

/**
 * The reader description used when `interests.yaml` declares no `persona`.
 *
 * This is the sentence that used to be compiled into the Editor's prompt. It
 * stays as the default rather than being deleted, because a profile with no
 * persona must not leave the Editor with no reader at all.
 */
export const DEFAULT_PERSONA =
	"a technically sophisticated engineer who works in AI and software and reads this every morning before anything else";

/**
 * Sorted by weight so the rendered block leads with what matters most, and by id
 * within a weight so the same YAML always produces the same bytes -- the version
 * hash below is only meaningful if the ordering is stable.
 */
export function buildReaderProfile(interests: InterestsConfig): ReaderProfile {
	const topics = [...interests.topics].sort(
		(a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
	const persona = interests.persona?.trim() || DEFAULT_PERSONA;
	const version = createHash("sha256")
		.update(JSON.stringify({ topics, persona }))
		.digest("hex")
		.slice(0, 12);
	return { topics, persona, version };
}

/** How many topics are rendered into a prompt before the list is cut short. */
const MAX_RENDERED_TOPICS = 20;

/**
 * The block both system prompts embed.
 *
 * Kept short on purpose: it is paid for on every turn of every run, and a long
 * list of near-equal weights teaches a model less than a short list of clearly
 * unequal ones. The "priors, not filters" paragraph is not decoration -- it is
 * the only thing standing between a weighted profile and a curator that decides
 * it may skip what the reader did not ask for.
 */
export function renderReaderProfile(profile: ReaderProfile): string {
	const shown = profile.topics.slice(0, MAX_RENDERED_TOPICS);
	const lines = shown.map((t) => {
		const also = t.keywords.slice(0, 5).join(", ");
		return `- ${t.label} (${t.weight.toFixed(2)})${also ? ` — ${also}` : ""}`;
	});
	const omitted = profile.topics.length - shown.length;
	if (omitted > 0) lines.push(`- ...and ${omitted} lower-weighted topic(s)`);

	return `## Who this is for

You are working for ${profile.persona}.

Their standing interests, with relative weight from 0 to 1:

${lines.join("\n")}

**These weights are priors, not filters.** A high weight raises a story's
relevance and may move it earlier in the brief. A low weight, or no matching
topic at all, lowers it. That is all they do.

They never justify:
- skipping an item's decision, or leaving an item unrecorded;
- marking an item IRRELEVANT because it is off-topic — off-topic is a low
  relevance score, not a disposition;
- dropping a story whose importance is high because no listed topic names it.

A major outage, a serious vulnerability or a significant market move is worth
reporting to this reader whether or not it matches a topic above. The topics say
what they care about most, not what they are willing to hear.`;
}
