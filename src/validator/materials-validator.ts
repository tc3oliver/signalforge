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
	 * Ids of items that have a recorded Curator decision. Identity, not a count:
	 * decisions are stored per lineage+date, so a re-collected manifest can hold
	 * the same number of items as an earlier run while the membership differs.
	 */
	processedItemIds: Set<string>;
	/**
	 * Ids the screener withheld from the Curator's default scan: routed DROP
	 * verdicts from the trusted screener version, in route mode only. Absent or
	 * empty in off/shadow mode, which makes the accounting below identical to
	 * the old "every item needs a decision" rule.
	 *
	 * These items are accounted for without a decision, but not editorially
	 * usable without one: see `validateMaterials`.
	 */
	screenedOutItemIds?: ReadonlySet<string>;
}

/**
 * How every manifest item is accounted for.
 *
 * The manifest is the frozen evidence universe and nothing here shrinks it. An
 * item is accounted for by exactly one of: a real Curator decision, or a routed
 * screener DROP. An item with neither is unaccounted and blocks submission. A
 * routed DROP that ALSO has a Curator decision was rescued -- the Curator went
 * and got it through search_items -- and the decision supersedes the DROP.
 */
export interface ManifestAccounting {
	/** Items in this run's manifest. */
	total: number;
	/** Items the screener withheld from the default scan (routed DROPs). */
	screenedOut: number;
	/** Items the Curator was asked to judge: total - screenedOut. */
	sentToCurator: number;
	/** Items with a Curator decision, whether offered or rescued. */
	curatorDecided: number;
	/** Screened-out items the Curator decided anyway. */
	rescued: number;
	/** Items with neither a decision nor a routed DROP. Must be empty to submit. */
	unaccountedItemIds: string[];
}

export function accountManifest(ctx: MaterialsValidationContext): ManifestAccounting {
	const screenedOut = ctx.screenedOutItemIds ?? new Set<string>();
	const unaccountedItemIds: string[] = [];
	let screenedOutCount = 0;
	let curatorDecided = 0;
	let rescued = 0;
	for (const item of ctx.manifest.items) {
		const decided = ctx.processedItemIds.has(item.id);
		const withheld = screenedOut.has(item.id);
		if (decided) curatorDecided += 1;
		if (withheld) screenedOutCount += 1;
		if (decided && withheld) rescued += 1;
		if (!decided && !withheld) unaccountedItemIds.push(item.id);
	}
	const total = ctx.manifest.items.length;
	return {
		total,
		screenedOut: screenedOutCount,
		sentToCurator: total - screenedOutCount,
		curatorDecided,
		rescued,
		unaccountedItemIds,
	};
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

	// Accounting is the hard gate: every item in THIS manifest must carry a
	// Curator decision or a routed screener DROP. Compared by id, never by count
	// -- equal counts can still hide an item that was never looked at.
	const accounting = accountManifest(ctx);
	if (accounting.unaccountedItemIds.length > 0) {
		const ids = accounting.unaccountedItemIds;
		const named = ids.slice(0, 10).join(", ");
		const rest = ids.length > 10 ? ` and ${ids.length - 10} more` : "";
		errors.push(
			`Scan coverage incomplete: ${accounting.curatorDecided} of ${accounting.sentToCurator} offered items decided, ${ids.length} still unseen: ${named}${rest}. Record a decision for every one of these item ids before submitting materials.`,
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

		/*
		 * A screener DROP accounts for an item; it does not make the item usable.
		 * Citing an item as a story source is an editorial act, and it needs the
		 * Curator's own decision on that item -- otherwise a routed-out item could
		 * reach the Editor with no record of anyone having read it. This is what
		 * "rescue" means concretely: read it, decide it, then cite it.
		 */
		const undecidedSources = story.sourceItemIds.filter(
			(id) => sources.unknownItemIds([id]).length === 0 && !ctx.processedItemIds.has(id),
		);
		if (undecidedSources.length > 0) {
			errors.push(
				`Undecided sourceItemIds in ${where}: ${undecidedSources.join(", ")}. Every item a story cites needs a recorded decision from you (record_item_decisions with CANDIDATE or DUPLICATE and this storyId). An item the screener set aside can be cited only after you decide it yourself.`,
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
