import Link from "next/link";
import type { DashboardView } from "../../lib/dashboard.ts";
import { formatClock } from "../../lib/format.ts";
import { safeExternalUrl } from "../../lib/untrusted.ts";

/**
 * The inbox: items collected after the day's first run, which the next run
 * will see and today's page has not. A short feed at the bottom of the page --
 * timestamp, title, source -- not an intelligence product.
 *
 * No backlog count. The product's job is to digest the feed for the reader, so
 * the page shows the few most recent items and says the rest will be handled
 * at the next run. The exact number is on the admin pages.
 */
export function NewSinceMorning({ feed }: { feed: DashboardView["newSinceMorning"] }) {
	if (feed.total === 0) return null;
	return (
		<section className="block inbox" aria-labelledby="new-since-morning">
			<h2 id="new-since-morning" className="block-label">
				今日新增 <span className="block-note">UTC</span>
			</h2>
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
									相關事件
								</Link>
							) : null}
						</li>
					);
				})}
			</ul>
			{feed.total > feed.items.length ? (
				<p className="empty">其餘項目會在下一次整理時處理。</p>
			) : null}
		</section>
	);
}
