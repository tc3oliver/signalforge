import Link from "next/link";
import type { DailyBriefStory } from "../../src/schemas/brief.ts";
import type { StructuredFact } from "../../src/schemas/fact.ts";
import type { NormalizedItem } from "../../src/schemas/item.ts";
import type { LateItem } from "../../src/db/items.ts";
import { buildAnchors, buildBriefSections, type BriefSectionView } from "../lib/sections.ts";
import {
	changeTypeLabel,
	confidenceDisplay,
	formatDateKey,
	formatInstant,
	formatScore,
	formatTimeOfDay,
} from "../lib/format.ts";
import { preview, safeExternalUrl } from "../lib/untrusted.ts";
import type { BriefPageData } from "../lib/queries.ts";
import { FactList } from "./facts.tsx";
import { SourceList } from "./sources.tsx";
import { Field, Tag } from "./bits.tsx";

/*
 * The brief, rendered from the same rules as src/renderer/markdown.ts: fixed
 * section order, empty sections omitted rather than shown empty, numbers pulled
 * from the fact store by reference, and every source a link to its original.
 */

function StoryArticle({
	story,
	anchor,
	facts,
	items,
}: {
	story: DailyBriefStory;
	anchor: string;
	facts: readonly StructuredFact[];
	items: Map<string, NormalizedItem>;
}) {
	const confidence = confidenceDisplay(story.confidence);
	const sources = story.sourceItemIds
		.map((id) => items.get(id))
		.filter((item): item is NormalizedItem => item !== undefined);
	const unresolved = story.sourceItemIds.filter((id) => !items.has(id));
	return (
		<article className="story">
			<h3 id={anchor}>
				<Link href={`/story/${encodeURIComponent(story.storyId)}`}>{story.title}</Link>
			</h3>
			<p className="meta">
				{story.mustKnow ? <Tag tone="accent">Must know</Tag> : null}
				<Tag tone={confidence.tone}>
					信心 {confidence.label} ({confidence.level})
				</Tag>
				<span className="mono">{story.storyId}</span>
			</p>
			<Field label="什麼發生了">{story.whatHappened}</Field>
			<Field label="為何重要">{story.whyItMatters}</Field>
			<Field label="有什麼變化">{story.whatChanged}</Field>
			<Field label="影響">{story.impact}</Field>
			<FactList factRefs={story.factRefs} facts={facts} />
			<p className="field">
				<span className="field-label">來源</span>
			</p>
			<SourceList items={sources} unresolvedIds={unresolved} />
		</article>
	);
}

function SectionBody({
	section,
	anchors,
	facts,
	items,
}: {
	section: BriefSectionView;
	anchors: Map<string, string>;
	facts: readonly StructuredFact[];
	items: Map<string, NormalizedItem>;
}) {
	switch (section.kind) {
		case "must-know":
			return (
				<>
					{section.highlights.length > 0 ? (
						<ul className="plain tight">
							{section.highlights.map((link) => (
								<li key={link.storyId}>
									<a href={`#${link.anchor}`}>{link.title}</a>
								</li>
							))}
						</ul>
					) : null}
					{section.stories.map((story) => (
						<StoryArticle
							key={story.storyId}
							story={story}
							anchor={anchors.get(story.storyId) ?? story.storyId}
							facts={facts}
							items={items}
						/>
					))}
				</>
			);
		case "stories":
			return (
				<>
					{section.stories.map((story) => (
						<StoryArticle
							key={story.storyId}
							story={story}
							anchor={anchors.get(story.storyId) ?? story.storyId}
							facts={facts}
							items={items}
						/>
					))}
				</>
			);
		case "signals":
			return (
				<>
					{section.signals.map((signal) => (
						<div key={signal.label} className="panel">
							<h3 style={{ marginTop: 0 }}>{signal.label}</h3>
							<p>{signal.body}</p>
							{signal.storyIds.length > 0 ? (
								<p className="meta">
									{signal.storyIds.map((id) => (
										<Link key={id} href={`/story/${encodeURIComponent(id)}`} className="mono">
											{id}
										</Link>
									))}
								</p>
							) : null}
						</div>
					))}
				</>
			);
		case "analysis":
			return (
				<>
					{section.body.split(/\n{2,}/).map((paragraph, index) => (
						<p key={index}>{paragraph}</p>
					))}
				</>
			);
		case "watch-next":
			return (
				<ul className="plain tight">
					{section.entries.map((entry) => (
						<li key={entry}>{entry}</li>
					))}
				</ul>
			);
	}
}

/**
 * Items whose bytes arrived after the day's first run was created. They are not
 * part of the published brief — they are what the next run will see — so they
 * are shown as a clearly separated area rather than folded into a section.
 */
function NewSinceMorning({ items }: { items: readonly LateItem[] }) {
	if (items.length === 0) return null;
	return (
		<section className="panel alert" aria-labelledby="new-since-morning">
			<h2 id="new-since-morning" style={{ marginTop: 0, border: "none" }}>
				New Since Morning
			</h2>
			<p className="lede" style={{ marginBottom: 8 }}>
				Collected after this day&apos;s first run was created, so not yet part of the brief
				below.
			</p>
			<ul className="sources">
				{items.map((item) => {
					const href = safeExternalUrl(item.url);
					return (
						<li key={item.itemId}>
							{href ? (
								<a href={href} target="_blank" rel="noreferrer noopener nofollow external">
									{item.title}
								</a>
							) : (
								<span>{item.title}</span>
							)}{" "}
							<span className="host">
								{item.sourceName} · fetched {formatTimeOfDay(item.fetchedAt)}
								{item.importance === undefined
									? ""
									: ` · importance ${formatScore(item.importance)}`}
								{item.changeType === undefined ? "" : ` · ${changeTypeLabel(item.changeType)}`}
							</span>
							{item.storyId ? (
								<>
									{" "}
									<Link href={`/story/${encodeURIComponent(item.storyId)}`}>story</Link>
								</>
							) : null}{" "}
							<Link href={`/admin/item/${encodeURIComponent(item.itemId)}`} className="host">
								trace
							</Link>
							{item.summary ? <div className="host">{preview(item.summary, 160)}</div> : null}
						</li>
					);
				})}
			</ul>
		</section>
	);
}

export function BriefView({ data }: { data: BriefPageData }) {
	const { brief, facts, items, lateItems, neighbours } = data;
	const anchors = buildAnchors(brief.stories);
	const sections = buildBriefSections(brief);
	const itemsById = new Map(items.map((i) => [i.id, i] as const));

	return (
		<>
			<h1>Daily Intelligence</h1>
			<p className="dateline">
				{formatDateKey(brief.date)} · produced {formatInstant(brief.producedAt)} ·{" "}
				{brief.stories.length} stories
			</p>

			<NewSinceMorning items={lateItems} />

			{sections.map((section) => (
				<section key={section.key} aria-labelledby={`section-${section.key}`}>
					<h2 id={`section-${section.key}`}>{section.heading}</h2>
					<SectionBody section={section} anchors={anchors} facts={facts} items={itemsById} />
				</section>
			))}

			<nav className="pager" aria-label="Other briefs">
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
		</>
	);
}
