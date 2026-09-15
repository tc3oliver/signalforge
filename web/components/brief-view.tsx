import Link from "next/link";
import type { DailyBriefStory } from "../../src/schemas/brief.ts";
import type { StructuredFact } from "../../src/schemas/fact.ts";
import type { NormalizedItem } from "../../src/schemas/item.ts";
import { buildAnchors, buildBriefSections, type BriefSectionView } from "../lib/sections.ts";
import { buildDashboard, type DashboardView, type StoryCardView } from "../lib/dashboard.ts";
import { formatDateKey } from "../lib/format.ts";
import type { BriefPageData } from "../lib/queries.ts";
import { ChangeBadge, ConfidenceBadge } from "./badges.tsx";
import { MustKnowGrid } from "./dashboard/must-know.tsx";
import { NewSinceMorning } from "./dashboard/new-since-morning.tsx";
import { EmergingSignals } from "./dashboard/signal-card.tsx";
import { TodayHero } from "./dashboard/today-hero.tsx";
import { WatchNext } from "./dashboard/watch-next.tsx";
import { FactList } from "./facts.tsx";
import { SourceList } from "./sources.tsx";
import { Field } from "./bits.tsx";

/*
 * The full brief: the same hero and must-know cards as the dashboard first, so
 * a historical brief opens the way today does, and only then the long-form
 * stories in the renderer's fixed section order, with empty sections omitted,
 * numbers pulled from the fact store by reference, and every source a link.
 */

function StoryArticle({
	story,
	card,
	anchor,
	facts,
	items,
}: {
	story: DailyBriefStory;
	card: StoryCardView | undefined;
	anchor: string;
	facts: readonly StructuredFact[];
	items: Map<string, NormalizedItem>;
}) {
	const sources = story.sourceItemIds
		.map((id) => items.get(id))
		.filter((item): item is NormalizedItem => item !== undefined);
	const unresolved = story.sourceItemIds.filter((id) => !items.has(id));
	return (
		<article className="story">
			<h3 id={anchor}>
				<Link href={`/story/${encodeURIComponent(story.storyId)}`}>{story.title}</Link>
			</h3>
			<p className="badges">
				{story.mustKnow ? <span className="badge importance-high">必看</span> : null}
				<ChangeBadge type={card?.changeType} />
				<ConfidenceBadge level={story.confidence} />
			</p>
			<Field label="發生了什麼">{story.whatHappened}</Field>
			<Field label="為什麼值得注意">{story.whyItMatters}</Field>
			<Field label="最新變化">{story.whatChanged}</Field>
			<Field label="可能影響">{story.impact}</Field>
			<FactList factRefs={story.factRefs} facts={facts} />
			<p className="field">
				<span className="field-label">資料來源</span>
			</p>
			<SourceList items={sources} unresolvedIds={unresolved} />
		</article>
	);
}

function StorySectionBody({
	section,
	cards,
	anchors,
	facts,
	items,
}: {
	section: Extract<BriefSectionView, { kind: "stories" | "must-know" }>;
	cards: Map<string, StoryCardView>;
	anchors: Map<string, string>;
	facts: readonly StructuredFact[];
	items: Map<string, NormalizedItem>;
}) {
	return (
		<>
			{section.stories.map((story) => (
				<StoryArticle
					key={story.storyId}
					story={story}
					card={cards.get(story.storyId)}
					anchor={anchors.get(story.storyId) ?? story.storyId}
					facts={facts}
					items={items}
				/>
			))}
		</>
	);
}

export function FullBriefView({ data }: { data: BriefPageData }) {
	const { brief, facts, items, lateItems, neighbours } = data;
	const view: DashboardView = buildDashboard({
		brief,
		ledger: data.ledger,
		signalRecords: data.signalRecords,
		lateItems,
	});
	const cards = new Map<string, StoryCardView>();
	for (const section of view.sections) {
		for (const row of section.rows) cards.set(row.storyId, row);
	}
	for (const card of view.mustKnow) cards.set(card.storyId, card);
	const anchors = buildAnchors(brief.stories);
	const sections = buildBriefSections(brief);
	const itemsById = new Map(items.map((i) => [i.id, i] as const));

	return (
		<div className="dashboard">
			<TodayHero view={view} />
			<MustKnowGrid cards={view.mustKnow} />

			{sections.map((section) => {
				switch (section.kind) {
					case "must-know":
						// Every must-know story is already a card above; only stories
						// filed directly under MUST_KNOW have no topical section to live in.
						if (section.stories.length === 0) return null;
						return (
							<section key={section.key} aria-labelledby={`section-${section.key}`}>
								<h2 id={`section-${section.key}`} className="block-label">
									{section.heading}
								</h2>
								<StorySectionBody
									section={section}
									cards={cards}
									anchors={anchors}
									facts={facts}
									items={itemsById}
								/>
							</section>
						);
					case "stories":
						return (
							<section key={section.key} aria-labelledby={`section-${section.key}`}>
								<h2 id={`section-${section.key}`} className="block-label">
									{section.heading}
								</h2>
								<StorySectionBody
									section={section}
									cards={cards}
									anchors={anchors}
									facts={facts}
									items={itemsById}
								/>
							</section>
						);
					case "signals":
						return (
							<div key={section.key} id={`section-${section.key}`}>
								<EmergingSignals signals={view.signals} />
							</div>
						);
					case "analysis":
						return (
							<section key={section.key} aria-labelledby={`section-${section.key}`}>
								<h2 id={`section-${section.key}`} className="block-label">
									{section.heading}
								</h2>
								<div className="brief-analysis">
									{section.body.split(/\n{2,}/).map((paragraph, index) => (
										<p key={index}>{paragraph}</p>
									))}
								</div>
							</section>
						);
					case "watch-next":
						return (
							<div key={section.key} id={`section-${section.key}`}>
								<WatchNext entries={section.entries} />
							</div>
						);
				}
			})}

			<NewSinceMorning feed={view.newSinceMorning} />

			<nav className="pager" aria-label="其他日期">
				{neighbours.previous ? (
					<Link href={`/brief/${neighbours.previous}`}>
						← {formatDateKey(neighbours.previous)}
					</Link>
				) : (
					<span />
				)}
				{neighbours.next ? (
					<Link href={`/brief/${neighbours.next}`}>{formatDateKey(neighbours.next)} →</Link>
				) : (
					<span />
				)}
			</nav>
		</div>
	);
}
