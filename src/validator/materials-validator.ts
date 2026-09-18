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
	/**
	 * Ids of items that have a recorded decision. Identity, not a count:
	 * decisions are stored per lineage+date, so a re-collected manifest can hold
	 * the same number of items as an earlier run while the membership differs.
	 */
	processedItemIds: Set<string>;
}

export interface ScanCoverage {
	total: number;
	decided: number;
	unseenItemIds: string[];
}

/**
 * Coverage of this run's manifest, by item id. `decided` counts only manifest
 * items, so decisions left behind by another run of the same date cannot
 * inflate it.
 */
export function scanCoverage(ctx: MaterialsValidationContext): ScanCoverage {
	const unseenItemIds: string[] = [];
	let decided = 0;
	for (const item of ctx.manifest.items) {
		if (ctx.processedItemIds.has(item.id)) decided += 1;
		else unseenItemIds.push(item.id);
	}
	return { total: ctx.manifest.items.length, decided, unseenItemIds };
}

function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
	return path.length === 0 ? "<root>" : path.map(String).join(".");
}

/**
 * The ids a rejected reference could legally have named, as a bounded list.
 *
 * An error that says an id is wrong without saying what is right leaves the
 * model guessing, and it guesses by resubmitting a near-miss. On 2026-09-18 that
 * cost three rejected submissions and about four minutes at the end of a
 * 64-minute curation -- each one a whole model turn spent rediscovering a set
 * this validator already had in hand.
 *
 * Bounded because the correction is fed back verbatim into a model turn: a
 * ledger of several hundred ids would crowd out the instruction it is attached
 * to. Sorted so the same rejection reads the same way twice.
 */
function listValidIds(ids: Iterable<string>, limit = 40): string {
	const all = [...ids].sort();
	if (all.length === 0) return "none (the ledger is empty)";
	const shown = all.slice(0, limit).join(", ");
	return all.length > limit ? `${shown} (and ${all.length - limit} more)` : shown;
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

	// Scan coverage is the hard gate: the curator must have decided on every item
	// in THIS manifest. Compared by id, never by count — equal counts can still
	// hide an item that was never looked at.
	const coverage = scanCoverage(ctx);
	if (coverage.unseenItemIds.length > 0) {
		const named = coverage.unseenItemIds.slice(0, 10).join(", ");
		const rest =
			coverage.unseenItemIds.length > 10
				? ` and ${coverage.unseenItemIds.length - 10} more`
				: "";
		errors.push(
			`Scan coverage incomplete: ${coverage.decided} of ${coverage.total} items processed, ${coverage.unseenItemIds.length} still unseen: ${named}${rest}. Record a decision for every one of these item ids before submitting materials.`,
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
				`Unknown storyId in ${where}: it is not in the story ledger. ` +
					`Upsert the story before citing it in materials, or cite one of the ` +
					`ids already in the ledger: ${listValidIds(ctx.knownStoryIds)}.`,
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
				`Emerging signal "${signal.label}" references storyIds not present in the materials: ${missing.join(", ")}. ` +
					`Reference only stories you submitted, or drop them from the signal. ` +
					`The stories in this submission are: ${listValidIds(seenStoryIds)}.`,
			);
		}
	}

	return { ok: errors.length === 0, errors };
}
