import type { BriefSection, ConfidenceLevel, DailyBrief, DailyBriefStory } from "../schemas/brief.ts";
import type { StructuredFact } from "../schemas/fact.ts";
import type { NormalizedItem } from "../schemas/item.ts";

export interface RenderOptions {
	facts: StructuredFact[];
	items: NormalizedItem[];
}

/** Topical sections, in the fixed output order. MUST_KNOW is handled separately. */
const TOPICAL_SECTIONS: ReadonlyArray<readonly [BriefSection, string]> = [
	["AI_LLM", "AI / LLM"],
	["DEVELOPER_OSS", "Developer / Open Source"],
	["RESEARCH", "Research"],
	["CRYPTO_MARKET", "Crypto / Market"],
	["MACRO", "Macro"],
	["COMPANIES", "Companies"],
];

const CONFIDENCE_LABEL: Record<ConfidenceLevel, string> = {
	HIGH: "高",
	MEDIUM: "中",
	LOW: "低",
};

/** GitHub-flavoured heading anchor, with a deterministic suffix on collision. */
function slugify(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
			.trim()
			.replace(/\s+/g, "-") || "story"
	);
}

function buildAnchors(stories: readonly DailyBriefStory[]): Map<string, string> {
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

function formatFact(fact: StructuredFact): string {
	let line = `- ${fact.label}: ${fact.value}${fact.unit} (as of ${fact.asOf})`;
	if (fact.previousValue !== undefined) line += `，前值 ${fact.previousValue}${fact.unit}`;
	if (fact.changePct !== undefined) line += `，變化 ${fact.changePct}%`;
	return line;
}

function formatSource(id: string, items: Map<string, NormalizedItem>): string {
	const item = items.get(id);
	// Unknown item ids are not fatal (unlike facts, no number is fabricated by
	// showing the raw id), but the validator should have rejected them already.
	if (!item) return `- ${id}`;
	const label = `${item.sourceName}：${item.title}`;
	return item.url ? `- ${label} (${item.url})` : `- ${label}`;
}

function renderStory(
	story: DailyBriefStory,
	facts: Map<string, StructuredFact>,
	items: Map<string, NormalizedItem>,
): string[] {
	const lines: string[] = [`### ${story.title}`, ""];
	lines.push(`**什麼發生了**：${story.whatHappened}`, "");
	lines.push(`**為何重要**：${story.whyItMatters}`, "");
	lines.push(`**有什麼變化**：${story.whatChanged}`, "");
	lines.push(`**影響**：${story.impact}`, "");

	if (story.factRefs.length > 0) {
		lines.push("**數據**：", "");
		for (const factId of story.factRefs) {
			const fact = facts.get(factId);
			if (!fact) {
				throw new Error(
					`renderBriefMarkdown: unknown factRef "${factId}" in story "${story.storyId}" — the brief validator should have rejected this.`,
				);
			}
			lines.push(formatFact(fact));
		}
		lines.push("");
	}

	lines.push(`**信心**：${CONFIDENCE_LABEL[story.confidence]}`, "");
	lines.push("**來源**：", "");
	for (const id of story.sourceItemIds) lines.push(formatSource(id, items));
	lines.push("");
	return lines;
}

/**
 * Deterministic markdown for one brief. Numeric facts come from the fact store,
 * never from model prose, so a hallucinated number cannot reach the output.
 */
export function renderBriefMarkdown(brief: DailyBrief, opts: RenderOptions): string {
	const facts = new Map(opts.facts.map((f) => [f.factId, f] as const));
	const items = new Map(opts.items.map((i) => [i.id, i] as const));
	const anchors = buildAnchors(brief.stories);

	const lines: string[] = [`# Daily Intelligence — ${brief.date}`, ""];

	const mustKnow = brief.stories.filter((s) => s.mustKnow);
	// Stories filed directly under MUST_KNOW have no topical home, so they are
	// rendered in full here rather than dropped.
	const mustKnowOnly = brief.stories.filter((s) => s.section === "MUST_KNOW");
	if (mustKnow.length > 0 || mustKnowOnly.length > 0) {
		lines.push("## Must Know", "");
		for (const story of mustKnow) {
			lines.push(`- [${story.title}](#${anchors.get(story.storyId) ?? ""})`);
		}
		if (mustKnow.length > 0) lines.push("");
		for (const story of mustKnowOnly) {
			lines.push(...renderStory(story, facts, items));
		}
	}

	for (const [section, heading] of TOPICAL_SECTIONS) {
		const stories = brief.stories.filter((s) => s.section === section);
		if (stories.length === 0) continue; // never pad an empty section
		lines.push(`## ${heading}`, "");
		for (const story of stories) lines.push(...renderStory(story, facts, items));
	}

	if (brief.emergingSignals.length > 0) {
		lines.push("## Emerging Signals", "");
		for (const signal of brief.emergingSignals) {
			lines.push(`### ${signal.label}`, "", signal.body, "");
		}
	}

	lines.push("## Daily Analysis", "", brief.dailyAnalysis, "");

	lines.push("## Watch Next", "");
	for (const entry of brief.watchNext) lines.push(`- ${entry}`);
	lines.push("");

	return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
