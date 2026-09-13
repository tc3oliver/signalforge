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

	const mustKnow = brief.stories.filter((s) => s.mustKnow);
	if (mustKnow.length < MIN_MUST_KNOW || mustKnow.length > MAX_MUST_KNOW) {
		errors.push(
			`Must Know count is ${mustKnow.length}; it must be between ${MIN_MUST_KNOW} and ${MAX_MUST_KNOW}. Adjust the mustKnow flags accordingly.`,
		);
	}

	const sources = createSourceValidator(ctx.manifest);
	const materialById = new Map(ctx.materials.stories.map((s) => [s.storyId, s] as const));
	const seenStoryIds = new Set<string>();

	for (const story of brief.stories) {
		const where = `brief story "${story.storyId}"`;

		if (seenStoryIds.has(story.storyId)) {
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
