import type { ItemExplanation } from "../../src/db/decisions.ts";
import type { StoryLedgerEntry } from "../../src/schemas/story.ts";
import { changeTypeLabel, dispositionLabel, formatDateKey, sectionLabel } from "./format.ts";

/*
 * "Why did this item not reach the brief?" as four ordered steps, each with a
 * plain-language reason. The chain is built from what the pipeline recorded —
 * item_decisions, the story ledger and the published brief — so every step is
 * an audit of a stored decision, not a reconstruction after the fact.
 */

export interface TraceStep {
	stage: "scanned" | "decided" | "story" | "brief";
	label: string;
	detail: string;
	/** ok: the item advanced. stopped: this is where it ended. unknown: no record. */
	outcome: "ok" | "stopped" | "unknown";
	storyId?: string;
}

export interface TraceInput {
	date: string;
	explanation: ItemExplanation;
	story: StoryLedgerEntry | undefined;
	collectedAt: string | undefined;
	collectorId: string | undefined;
	knownToItemStore: boolean;
}

export function buildTraceSteps(input: TraceInput): TraceStep[] {
	const { date, explanation, story } = input;
	const steps: TraceStep[] = [];

	steps.push(
		input.knownToItemStore
			? {
					stage: "scanned",
					label: "Collected and normalized",
					detail: input.collectorId
						? `Fetched by ${input.collectorId} and stored as a normalized item.`
						: "Stored as a normalized item; the originating collection run is no longer linked.",
					outcome: "ok",
				}
			: {
					stage: "scanned",
					label: "Not in the item store",
					detail:
						"No normalized item exists for this id in this lineage. Nothing downstream could have seen it.",
					outcome: "stopped",
				},
	);

	if (explanation.disposition === undefined) {
		steps.push({
			stage: "decided",
			label: `No decision recorded for ${formatDateKey(date)}`,
			detail:
				"The curator records a disposition for every item it scans. A missing row means this item was never presented to it on this date — a scan-coverage gap, not a judgement about the item.",
			outcome: "unknown",
		});
		return steps;
	}

	steps.push({
		stage: "decided",
		label: `Curator decision: ${explanation.disposition}`,
		detail: `${dispositionLabel(explanation.disposition)}. Recorded reason: ${explanation.reason ?? "(none recorded)"}`,
		outcome: explanation.disposition === "CANDIDATE" ? "ok" : "stopped",
	});

	if (!explanation.storyId) {
		steps.push({
			stage: "story",
			label: "No story",
			detail:
				explanation.disposition === "IRRELEVANT"
					? "The item was judged out of scope, so no story was opened or updated from it."
					: "No story id was attached to this decision, so the item never entered the ledger.",
			outcome: "stopped",
		});
		return steps;
	}

	steps.push({
		stage: "story",
		label: `Attached to story ${explanation.storyId}`,
		detail: story
			? `${story.canonicalTitle} — change type ${changeTypeLabel(story.changeType)}, importance ${Math.round(story.importance * 100)}%. ${story.reason}`
			: "The decision names a story id that has no ledger entry in this lineage.",
		outcome: story ? "ok" : "unknown",
		storyId: explanation.storyId,
	});

	steps.push(
		explanation.reachedBrief
			? {
					stage: "brief",
					label: `Published in the ${formatDateKey(date)} brief`,
					detail: `Selected into the ${sectionLabel(explanation.briefSection ?? "")} section.`,
					outcome: "ok",
					storyId: explanation.storyId,
				}
			: {
					stage: "brief",
					label: "Not selected into the brief",
					detail:
						"The story exists in the ledger for this date but the editor did not select it. A brief carries 8–15 stories; a story can be real, correct and still lose the slot to a more important one.",
					outcome: "stopped",
					storyId: explanation.storyId,
				},
	);

	return steps;
}
