import { MAX_PAGE, toScanView } from "./tools.ts";
import type { DailyManifest } from "../schemas/index.ts";
import type { StoryRepository } from "../stories/repository.ts";

/*
 * What a work unit already knows before the model is asked anything.
 *
 * A Curator work unit is a fresh session, and on 2026-09-19 every one of the
 * twelve opened the same way: `get_daily_inventory`, then `list_unseen_items`,
 * then `list_today_stories` -- three model turns per unit, thirty-three of the
 * day's 112, spent fetching values TypeScript had already computed in order to
 * decide whether to hand the model any work at all.
 *
 * None of that is a judgement. The counts come from the manifest and the
 * decisions table, the page is the next N undecided items in publication order,
 * and the story ids are a ledger query. So the session opens with them in hand
 * and the first model turn is editorial.
 *
 * The tools stay. A unit that needs to look again mid-flight -- a second page, a
 * story it wants to read in full, a search for a sibling item -- calls them
 * exactly as before. What is removed is the obligation to call them to start.
 */

export interface WorkUnitBrief {
	date: string;
	/** Items offered to the Curator: the manifest minus what the screener withheld. */
	totalItems: number;
	/** Items in the whole manifest; equal to `totalItems` outside route mode. */
	manifestItems: number;
	/** Items the screener withheld. */
	screenedOut: number;
	/** Offered items that already have a recorded decision, from any session. */
	decided: number;
	/** Offered items with no decision yet. */
	unseen: number;
	/** The page this unit starts on, already in scan-view shape. */
	page: ReturnType<typeof toScanView>[];
	/** Unseen items beyond this page. */
	remainingAfterPage: number;
	/** The cursor `list_unseen_items` would need to continue past this page. */
	nextCursor: string | null;
	/** Every story id today already holds, in ledger order. */
	storyIds: string[];
	/** Decisions this unit may record before it yields, when the unit is bounded. */
	decisionBudget?: number;
}

export interface WorkUnitBriefInput {
	date: string;
	manifest: DailyManifest;
	repo: StoryRepository;
	screenedOutItemIds: ReadonlySet<string>;
	/** How many items to seed. Defaults to a full page. */
	pageSize?: number;
	decisionBudget?: number;
}

/** Reads the durable state a fresh work unit would otherwise ask for. */
export async function buildWorkUnitBrief(input: WorkUnitBriefInput): Promise<WorkUnitBrief> {
	const processed = await input.repo.processedItemIds(input.date);
	const offered = input.manifest.items.filter((i) => !input.screenedOutItemIds.has(i.id));
	const unseen = offered.filter((i) => !processed.has(i.id));
	// Never more than a page, and never more than the unit is allowed to decide:
	// seeding items the unit cannot reach would pay for them on every turn of it.
	const size = Math.min(input.pageSize ?? MAX_PAGE, MAX_PAGE, input.decisionBudget ?? MAX_PAGE);
	const page = unseen.slice(0, size);
	const stories = await input.repo.listStories(input.date);
	return {
		date: input.date,
		totalItems: offered.length,
		manifestItems: input.manifest.items.length,
		screenedOut: input.screenedOutItemIds.size,
		decided: offered.length - unseen.length,
		unseen: unseen.length,
		page: page.map(toScanView),
		remainingAfterPage: Math.max(0, unseen.length - page.length),
		nextCursor: unseen[page.length]?.id ?? null,
		storyIds: stories.map((s) => s.storyId),
		...(input.decisionBudget !== undefined ? { decisionBudget: input.decisionBudget } : {}),
	};
}

/**
 * The brief as the model reads it.
 *
 * JSON for the page and the ids, prose for what to do with them. The page is
 * byte-identical to what `list_unseen_items` would have returned, so a unit that
 * pages further mid-flight sees one consistent shape rather than two.
 */
export function renderWorkUnitBrief(brief: WorkUnitBrief): string {
	const lines: string[] = [];
	lines.push("## Where this day stands");
	lines.push("");
	lines.push(
		`${brief.decided} of ${brief.totalItems} offered items have a recorded decision; ${brief.unseen} do not.` +
			(brief.screenedOut > 0
				? ` A cheap screening pass set aside ${brief.screenedOut} more from the ${brief.manifestItems}-item manifest; \`search_items\` still finds those.`
				: ""),
	);
	lines.push("");

	if (brief.storyIds.length > 0) {
		lines.push(
			`Today already holds ${brief.storyIds.length} stor${brief.storyIds.length === 1 ? "y" : "ies"}. ` +
				`Re-using one of these ids merges into it instead of splitting the event in two; ` +
				`\`get_story\` reads one in full, and \`list_today_stories\` with \`match\` ranks them against a title.`,
		);
		lines.push("");
		lines.push(JSON.stringify(brief.storyIds));
		lines.push("");
	} else {
		lines.push("No stories exist for today yet.");
		lines.push("");
	}

	lines.push(
		brief.page.length === 0
			? "## No items are waiting"
			: `## Your batch: ${brief.page.length} item(s)`,
	);
	lines.push("");
	if (brief.page.length > 0) {
		lines.push(
			`These are the next undecided items in publication order. You have them already — do not call \`list_unseen_items\` to fetch this page.` +
				(brief.remainingAfterPage > 0
					? ` ${brief.remainingAfterPage} more remain beyond it.`
					: ""),
		);
		lines.push("");
		lines.push(JSON.stringify({ items: brief.page, returned: brief.page.length, remainingAfterPage: brief.remainingAfterPage, nextCursor: brief.nextCursor }));
		lines.push("");
	}

	lines.push("## What to do");
	lines.push("");
	if (brief.page.length === 0) {
		lines.push("Every offered item has a decision. Assign tiers and call `submit_materials`.");
	} else {
		lines.push(
			"Triage this batch on title and summary. Where a title and summary cannot settle an item, `get_item_detail` gives the record and `read_item_body` with a `find` term reads the passage that settles it; `search_items` finds the other coverage of the same event.",
		);
		lines.push("");
		lines.push(
			"Then commit the whole batch with ONE `commit_curation_batch` call: the stories its items belong to, and a disposition for every item in it. That call writes both, checks each story's history for you, and tells you whether the work unit is finished.",
		);
		if (brief.decisionBudget !== undefined) {
			lines.push("");
			lines.push(
				`This session may record ${brief.decisionBudget} decision(s) before it yields to a fresh one. ` +
					`When \`commit_curation_batch\` answers with \`turnComplete\`, stop and end your reply — ` +
					`the next session resumes from exactly that state.`,
			);
		}
	}
	return lines.join("\n");
}
