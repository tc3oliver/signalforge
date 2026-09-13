import { DailyMaterialsInput } from "../schemas/materials.ts";
import type { DailyManifest } from "../schemas/manifest.ts";
import { createSourceValidator } from "./source-validator.ts";

export interface ValidationResult {
	ok: boolean;
	errors: string[];
}

export interface MaterialsValidationContext {
	manifest: DailyManifest;
	knownStoryIds: Set<string>;
	totalItems: number;
	processedItems: number;
}

function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
	return path.length === 0 ? "<root>" : path.map(String).join(".");
}

/**
 * Gate between the curator and the editor. Every failure string is fed back to
 * the model verbatim as a corrective retry, so each one names what is wrong and
 * what to do about it.
 */
export function validateMaterials(
	input: unknown,
	ctx: MaterialsValidationContext,
): ValidationResult {
	const errors: string[] = [];

	const parsed = DailyMaterialsInput.safeParse(input);
	if (!parsed.success) {
		for (const issue of parsed.error.issues) {
			errors.push(
				`Schema error at ${formatIssuePath(issue.path)}: ${issue.message}. Fix this field and resubmit.`,
			);
		}
		return { ok: false, errors };
	}
	const materials = parsed.data;

	// Scan coverage is the hard gate: the curator must have decided on every item.
	const unseen = ctx.totalItems - ctx.processedItems;
	if (ctx.processedItems !== ctx.totalItems || unseen !== 0) {
		errors.push(
			`Scan coverage incomplete: ${ctx.processedItems} of ${ctx.totalItems} items processed, ${unseen} still unseen. Record a decision for every remaining item before submitting materials.`,
		);
	}

	const sources = createSourceValidator(ctx.manifest);
	const seenStoryIds = new Set<string>();

	for (const story of materials.stories) {
		const where = `story "${story.storyId}"`;

		if (seenStoryIds.has(story.storyId)) {
			errors.push(
				`Duplicate storyId "${story.storyId}" in materials. Merge the duplicate entries into a single story.`,
			);
		}
		seenStoryIds.add(story.storyId);

		if (!ctx.knownStoryIds.has(story.storyId)) {
			errors.push(
				`Unknown storyId in ${where}: it is not in the story ledger. Upsert the story before citing it in materials.`,
			);
		}

		const unknownSources = sources.unknownItemIds(story.sourceItemIds);
		if (unknownSources.length > 0) {
			errors.push(
				`Unknown sourceItemIds in ${where}: ${unknownSources.join(", ")}. Cite only item ids that exist in today's manifest.`,
			);
		}

		const unknownPrimary = sources.unknownItemIds(story.primarySourceIds);
		if (unknownPrimary.length > 0) {
			errors.push(
				`Unknown primarySourceIds in ${where}: ${unknownPrimary.join(", ")}. Cite only item ids that exist in today's manifest.`,
			);
		}

		const sourceSet = new Set(story.sourceItemIds);
		const strayPrimary = story.primarySourceIds.filter((id) => !sourceSet.has(id));
		if (strayPrimary.length > 0) {
			errors.push(
				`primarySourceIds not listed in sourceItemIds for ${where}: ${strayPrimary.join(", ")}. Every primary source must also appear in sourceItemIds.`,
			);
		}

		const unknownFacts = sources.unknownFactIds(story.factRefs);
		if (unknownFacts.length > 0) {
			errors.push(
				`Unknown factRefs in ${where}: ${unknownFacts.join(", ")}. Reference only factIds present in today's manifest facts; never invent a number.`,
			);
		}
	}

	for (const signal of materials.emergingSignals) {
		const missing = signal.storyIds.filter((id) => !seenStoryIds.has(id));
		if (missing.length > 0) {
			errors.push(
				`Emerging signal "${signal.label}" references storyIds not present in the materials: ${missing.join(", ")}. Reference only stories you submitted, or drop them from the signal.`,
			);
		}
	}

	return { ok: errors.length === 0, errors };
}
