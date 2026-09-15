import Link from "next/link";
import type { SectionView, StoryCardView } from "../../lib/dashboard.ts";
import { ChangeBadge, ConfidenceBadge, SourceCount } from "../badges.tsx";

/**
 * A topical section as a compact feed: the title and the kind of change on one
 * line, one takeaway sentence, then a source count and how well it is stood
 * up. Importance is not shown -- the ordering already ranks the day. The full
 * story text is one click away and is deliberately not here.
 */
export function StorySection({ section, date }: { section: SectionView; date: string }) {
	const id = `section-${section.key}`;
	return (
		<section className="block" aria-labelledby={id}>
			<div className="block-head">
				<h2 id={id} className="block-label">
					{section.heading}
				</h2>
				{section.overflow > 0 ? (
					<Link href={`/brief/${date}#section-${section.key}`} className="view-all">
						全部 {section.total} 則 <span aria-hidden="true">→</span>
					</Link>
				) : null}
			</div>
			<ul className="story-rows">
				{section.rows.map((row) => (
					<CompactStoryRow key={row.storyId} story={row} />
				))}
			</ul>
		</section>
	);
}

export function CompactStoryRow({ story }: { story: StoryCardView }) {
	const href = `/story/${encodeURIComponent(story.storyId)}`;
	return (
		<li className="story-row">
			<div className="story-row-head">
				<h3 className="story-row-title">
					<Link href={href}>{story.title}</Link>
				</h3>
				<ChangeBadge type={story.changeType} />
			</div>
			<p className="takeaway">{story.takeaway}</p>
			<p className="story-row-foot">
				<SourceCount count={story.sourceCount} href={`${href}#story-sources`} />
				<ConfidenceBadge level={story.confidence} />
			</p>
		</li>
	);
}
