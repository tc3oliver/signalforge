import { DailyBriefInput } from "../schemas/brief.ts";
import type { DailyManifest } from "../schemas/manifest.ts";
import type { DailyMaterials } from "../schemas/materials.ts";
import { createSourceValidator } from "./source-validator.ts";
import type { ValidationResult } from "./materials-validator.ts";

export type { ValidationResult } from "./materials-validator.ts";

export interface BriefValidationContext {
	manifest: DailyManifest;
	materials: DailyMaterials;
}

const MIN_MUST_KNOW = 3;
const MAX_MUST_KNOW = 5;

/** The shape of a full day: enough stories to be a brief, few enough to be read. */
const TARGET_MIN_STORIES = 8;

/**
 * How many stories this brief must contain, given what the curator found.
 *
 * A normal day supplies fifteen-odd stories and the answer is the usual 8-15.
 * A quiet day -- the first real production run found four genuine stories in
 * 771 items, most of them repository noise -- supplies fewer than eight, and
 * then the only correct brief is one that carries all of them. Demanding eight
 * from four would leave the day unpublishable, which is a worse failure than a
 * short brief: the reader gets nothing at all on the morning when there
 * genuinely was not much, and the pipeline reports a failure for doing the
 * right thing.
 */
export function requiredStoryCount(materialCount: number): { min: number; max: number } {
	const max = Math.min(15, Math.max(1, materialCount));
	return { min: Math.min(TARGET_MIN_STORIES, max), max };
}

/**
 * Must Know is the handful at the top, not a fixed quota. Three of fifteen is a
 * selection; three of four is a formality that tells the reader nothing, and
 * demanding it from an editor with four stories is a rejection loop rather than
 * an editorial standard. So the floor tracks roughly the top third of the brief,
 * and 3-5 remains the answer for every normal day.
 */
export function requiredMustKnowCount(storyCount: number): { min: number; max: number } {
	if (storyCount === 0) return { min: 0, max: 0 };
	return {
		min: Math.max(1, Math.min(MIN_MUST_KNOW, Math.ceil(storyCount / 3))),
		max: Math.min(MAX_MUST_KNOW, storyCount),
	};
}

function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
	return path.length === 0 ? "<root>" : path.map(String).join(".");
}

/**
 * Gate between the editor and the renderer. The editor may only narrate stories
 * the curator actually selected, using sources that story actually carried.
 */
export function validateBrief(input: unknown, ctx: BriefValidationContext): ValidationResult {
	const errors: string[] = [];

	const parsed = DailyBriefInput.safeParse(input);
	if (!parsed.success) {
		for (const issue of parsed.error.issues) {
			errors.push(
				`Schema error at ${formatIssuePath(issue.path)}: ${issue.message}. Fix this field and resubmit.`,
			);
		}
		return { ok: false, errors };
	}
	const brief = parsed.data;

	const storyBounds = requiredStoryCount(ctx.materials.stories.length);
	const distinctIds = new Set(brief.stories.map((s) => s.storyId));
	const repeated = [...distinctIds].filter(
		(id) => brief.stories.filter((s) => s.storyId === id).length > 1,
	);

	// True only when the combined message below was emitted, so the per-story
	// duplicate errors are suppressed exactly when they would repeat it -- and
	// still reported when the count happened to land in range anyway.
	let repeatsAlreadyReported = false;

	if (brief.stories.length < storyBounds.min || brief.stories.length > storyBounds.max) {
		const required =
			storyBounds.min === storyBounds.max
				? `exactly ${storyBounds.min}`
				: `between ${storyBounds.min} and ${storyBounds.max}`;
		// When the count is only wrong because stories were repeated, saying so in
		// one sentence is the difference between a fixable rejection and a loop:
		// "too many stories" and "duplicate storyId" read as two problems, and an
		// editor that pads to reach a number will try to satisfy both at once.
		errors.push(
			repeated.length > 0
				? `Brief has ${brief.stories.length} entries but only ${distinctIds.size} distinct stories, because ${repeated.map((id) => `"${id}"`).join(", ")} ${repeated.length === 1 ? "appears" : "appear"} more than once. Delete the repeats. The brief must have ${required} stories, and ${distinctIds.size} distinct ${distinctIds.size === 1 ? "story is" : "stories are"} what you have — a short brief is the correct brief on a quiet day.`
				: `Brief has ${brief.stories.length} stories; it must have ${required}, because the curator supplied ${ctx.materials.stories.length}. Add or remove stories to land in that range.`,
		);
		repeatsAlreadyReported = repeated.length > 0;
	}

	const mustKnowBounds = requiredMustKnowCount(brief.stories.length);
	const mustKnow = brief.stories.filter((s) => s.mustKnow);
	if (mustKnow.length < mustKnowBounds.min || mustKnow.length > mustKnowBounds.max) {
		errors.push(
			`Must Know count is ${mustKnow.length}; it must be between ${mustKnowBounds.min} and ${mustKnowBounds.max} for a brief of ${brief.stories.length} stories. Adjust the mustKnow flags accordingly.`,
		);
	}

	const sources = createSourceValidator(ctx.manifest);
	const materialById = new Map(ctx.materials.stories.map((s) => [s.storyId, s] as const));
	const seenStoryIds = new Set<string>();

	for (const story of brief.stories) {
		const where = `brief story "${story.storyId}"`;

		if (seenStoryIds.has(story.storyId) && !repeatsAlreadyReported) {
			errors.push(
				`Duplicate storyId "${story.storyId}" in the brief. Each story may appear only once; merge the duplicates.`,
			);
		}
		seenStoryIds.add(story.storyId);

		const material = materialById.get(story.storyId);
		if (!material) {
			errors.push(
				`Unknown storyId in ${where}: it is not in today's curated materials. Write only about stories the curator selected; do not invent one.`,
			);
		}

		const unknownSources = sources.unknownItemIds(story.sourceItemIds);
		if (unknownSources.length > 0) {
			errors.push(
				`Unknown sourceItemIds in ${where}: ${unknownSources.join(", ")}. Cite only item ids that exist in today's manifest.`,
			);
		}

		if (material) {
			const allowed = new Set(material.sourceItemIds);
			const stray = story.sourceItemIds.filter((id) => !allowed.has(id));
			if (stray.length > 0) {
				errors.push(
					`sourceItemIds in ${where} are not among that story's material sources: ${stray.join(", ")}. Cite only the sources the curator attached to this story.`,
				);
			}
		}

		const unknownFacts = sources.unknownFactIds(story.factRefs);
		if (unknownFacts.length > 0) {
			errors.push(
				`Unknown factRefs in ${where}: ${unknownFacts.join(", ")}. Reference only factIds present in today's manifest facts; never invent a number.`,
			);
		}
	}

	// A signal's constituents are evidence, not necessarily published stories. Most of
	// them are individually too weak to earn a brief slot — that weakness is precisely
	// why the aggregate is worth naming. Requiring them to appear in `stories` would
	// force the editor to publish every weak constituent just to cite the trend, which
	// double-counts the same intelligence value. So the constraint is membership in the
	// curated materials, which still makes an invented storyId impossible.
	for (const signal of brief.emergingSignals) {
		const missing = signal.storyIds.filter((id) => !materialById.has(id));
		if (missing.length > 0) {
			errors.push(
				`Emerging signal "${signal.label}" references storyIds that are not in today's curated materials: ${missing.join(", ")}. Cite only storyIds the curator selected; they need not also be published as stories.`,
			);
		}
	}

	if (brief.watchNext.length === 0) {
		errors.push("watchNext is empty. Add at least one concrete thing to watch next.");
	}

	return { ok: errors.length === 0, errors };
}
