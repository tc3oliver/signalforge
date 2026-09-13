import Link from "next/link";
import type { DashboardView } from "../../lib/dashboard.ts";
import { formatClock } from "../../lib/format.ts";
import { safeExternalUrl } from "../../lib/untrusted.ts";

/**
 * The inbox: items collected after the day's first run, which the next run
 * will see and this brief has not. A short feed at the bottom of the page --
 * timestamp, title, source -- not an intelligence product.
 */
export function NewSinceMorning({ feed }: { feed: DashboardView["newSinceMorning"] }) {
	if (feed.total === 0) return null;
	return (
		<section className="block inbox" aria-labelledby="new-since-morning">
			<div className="block-head">
				<h2 id="new-since-morning" className="block-label">
					New since morning <span className="block-note">UTC</span>
				</h2>
				<span className="view-all">
					{feed.total}
					{feed.capped ? "+" : ""} {feed.total === 1 ? "item" : "items"}
				</span>
			</div>
			<ul className="inbox-list">
				{feed.items.map((item) => {
					const href = safeExternalUrl(item.url);
					return (
						<li key={item.itemId}>
							<time dateTime={item.fetchedAt} className="inbox-time">
								{formatClock(item.fetchedAt)}
							</time>
							{href ? (
								<a href={href} target="_blank" rel="noreferrer noopener nofollow external">
									{item.title}
								</a>
							) : (
								<span>{item.title}</span>
							)}
							<span className="inbox-source">{item.sourceName}</span>
							{item.storyId ? (
								<Link href={`/story/${encodeURIComponent(item.storyId)}`} className="inbox-story">
									story
								</Link>
							) : null}
						</li>
					);
				})}
			</ul>
			{feed.total > feed.items.length ? (
				<p className="empty">
					{feed.capped ? "At least " : ""}
					{feed.total - feed.items.length} more collected; they will be considered by the next run.
				</p>
			) : null}
		</section>
	);
}
