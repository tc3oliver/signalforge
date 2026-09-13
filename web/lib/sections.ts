import type { BriefSection, DailyBrief, DailyBriefStory } from "../../src/schemas/brief.ts";

/*
 * The brief's shape, decided in one pure function so the page component only
 * has to draw it — and so section order and empty-section omission are testable
 * without a database or a running server.
 *
 * The rules mirror src/renderer/markdown.ts deliberately: the web reader and
 * the markdown export must never disagree about what today's brief contains.
 */

/** Topical sections in fixed output order. MUST_KNOW is handled separately. */
export const TOPICAL_SECTIONS: ReadonlyArray<readonly [BriefSection, string]> = [
	["AI_LLM", "AI / LLM"],
	["DEVELOPER_OSS", "Developer / Open Source"],
	["RESEARCH", "Research"],
	["CRYPTO_MARKET", "Crypto / Market"],
	["MACRO", "Macro"],
	["COMPANIES", "Companies"],
];

/** The full published order, including the three trailing prose sections. */
export const SECTION_ORDER: readonly string[] = [
	"MUST_KNOW",
	...TOPICAL_SECTIONS.map(([key]) => key),
	"EMERGING_SIGNALS",
	"DAILY_ANALYSIS",
	"WATCH_NEXT",
];

export interface StoryLink {
	storyId: string;
	title: string;
	anchor: string;
}

export interface BriefSignal {
	label: string;
	body: string;
	storyIds: string[];
}

export type BriefSectionView =
	| {
			kind: "must-know";
			key: "MUST_KNOW";
			heading: "Must Know";
			/** Cross-links to every must-know story, wherever it is filed. */
			highlights: StoryLink[];
			/** Stories filed directly under MUST_KNOW have no topical home. */
			stories: DailyBriefStory[];
	  }
	| { kind: "stories"; key: BriefSection; heading: string; stories: DailyBriefStory[] }
	| { kind: "signals"; key: "EMERGING_SIGNALS"; heading: "Emerging Signals"; signals: BriefSignal[] }
	| { kind: "analysis"; key: "DAILY_ANALYSIS"; heading: "Daily Analysis"; body: string }
	| { kind: "watch-next"; key: "WATCH_NEXT"; heading: "Watch Next"; entries: string[] };

/** GitHub-flavoured heading anchor, with a deterministic collision suffix. */
export function slugify(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
			.trim()
			.replace(/\s+/g, "-") || "story"
	);
}

export function buildAnchors(stories: readonly DailyBriefStory[]): Map<string, string> {
	const used = new Map<string, number>();
	const anchors = new Map<string, string>();
	for (const story of stories) {
		const base = slugify(story.title);
		const seen = used.get(base) ?? 0;
		used.set(base, seen + 1);
		anchors.set(story.storyId, seen === 0 ? base : `${base}-${seen}`);
	}
	return anchors;
}

/**
 * Sections in fixed order, with every section that has no material content
 * dropped entirely. An empty heading is worse than a missing one: it reads as
 * "we looked and found nothing", which is a claim the pipeline has not made.
 */
export function buildBriefSections(brief: DailyBrief): BriefSectionView[] {
	const anchors = buildAnchors(brief.stories);
	const views: BriefSectionView[] = [];

	const highlights: StoryLink[] = brief.stories
		.filter((s) => s.mustKnow)
		.map((s) => ({ storyId: s.storyId, title: s.title, anchor: anchors.get(s.storyId) ?? "" }));
	const mustKnowOnly = brief.stories.filter((s) => s.section === "MUST_KNOW");
	if (highlights.length > 0 || mustKnowOnly.length > 0) {
		views.push({
			kind: "must-know",
			key: "MUST_KNOW",
			heading: "Must Know",
			highlights,
			stories: mustKnowOnly,
		});
	}

	for (const [key, heading] of TOPICAL_SECTIONS) {
		const stories = brief.stories.filter((s) => s.section === key);
		if (stories.length === 0) continue;
		views.push({ kind: "stories", key, heading, stories });
	}

	if (brief.emergingSignals.length > 0) {
		views.push({
			kind: "signals",
			key: "EMERGING_SIGNALS",
			heading: "Emerging Signals",
			signals: brief.emergingSignals.map((s) => ({
				label: s.label,
				body: s.body,
				storyIds: s.storyIds,
			})),
		});
	}

	if (brief.dailyAnalysis.trim() !== "") {
		views.push({
			kind: "analysis",
			key: "DAILY_ANALYSIS",
			heading: "Daily Analysis",
			body: brief.dailyAnalysis,
		});
	}

	const watchNext = brief.watchNext.filter((entry) => entry.trim() !== "");
	if (watchNext.length > 0) {
		views.push({ kind: "watch-next", key: "WATCH_NEXT", heading: "Watch Next", entries: watchNext });
	}

	return views;
}

/** Every fact id the brief cites, deduplicated, for a single fact-store read. */
export function collectFactRefs(brief: DailyBrief): string[] {
	const seen = new Set<string>();
	for (const story of brief.stories) {
		for (const ref of story.factRefs) seen.add(ref);
	}
	return [...seen];
}

/** Every source item id the brief cites, deduplicated. */
export function collectSourceItemIds(brief: DailyBrief): string[] {
	const seen = new Set<string>();
	for (const story of brief.stories) {
		for (const id of story.sourceItemIds) seen.add(id);
	}
	return [...seen];
}
