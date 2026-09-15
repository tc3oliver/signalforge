import Link from "next/link";
import type { MustKnowCardView } from "../../lib/dashboard.ts";
import { ChangeBadge, SourceCount } from "../badges.tsx";

/**
 * Priority cards: rank, title, change type, one sentence of why it matters,
 * and a source count. Importance is not shown -- every card here is already
 * among the day's most important, so the chip said nothing. Everything else
 * about the story lives on its own page; the card's job is to be scanned, not
 * read.
 */
export function MustKnowGrid({ cards }: { cards: readonly MustKnowCardView[] }) {
	if (cards.length === 0) return null;
	return (
		<section className="block" aria-labelledby="must-know">
			<h2 id="must-know" className="block-label">
				今日必看
			</h2>
			<ol className="must-know">
				{cards.map((card) => (
					<MustKnowCard key={card.storyId} card={card} />
				))}
			</ol>
		</section>
	);
}

export function MustKnowCard({ card }: { card: MustKnowCardView }) {
	const href = `/story/${encodeURIComponent(card.storyId)}`;
	return (
		<li className="priority-card">
			<span className="rank" aria-hidden="true">
				{String(card.rank).padStart(2, "0")}
			</span>
			<div className="priority-body">
				<h3 className="priority-title">
					<Link href={href}>{card.title}</Link>
				</h3>
				<p className="badges">
					<ChangeBadge type={card.changeType} />
				</p>
				<p className="takeaway">{card.takeaway}</p>
				<SourceCount count={card.sourceCount} href={`${href}#story-sources`} />
			</div>
		</li>
	);
}
