import type { DashboardView } from "../../lib/dashboard.ts";
import { formatDateBanner, formatInstant } from "../../lib/format.ts";

/**
 * Level 1 of the page: the date, the editor's opening line, and the day's
 * counts. Built to be read in a few seconds, so it holds one paragraph and one
 * row of numbers and nothing else.
 *
 * The late-item backlog is deliberately not a hero number. "200+ new since
 * morning" tells the reader how much is unread, which is the opposite of what
 * this product is for; the inbox at the foot of the page shows the few most
 * recent items and the admin pages carry the count.
 */
export function TodayHero({ view }: { view: DashboardView }) {
	return (
		<section className="hero" aria-labelledby="today-hero">
			<p className="hero-date">{formatDateBanner(view.date)}</p>
			<h1 id="today-hero" className="hero-label">
				60 秒掌握今天
			</h1>
			{view.hero.summary !== "" ? <p className="hero-summary">{view.hero.summary}</p> : null}
			<TodayStats stats={view.hero.stats} producedAt={view.producedAt} />
		</section>
	);
}

export function TodayStats({
	stats,
	producedAt,
}: {
	stats: DashboardView["hero"]["stats"];
	producedAt: string;
}) {
	return (
		<ul className="hero-stats" aria-label="今日數量">
			<li>
				<strong>{stats.stories}</strong> 則事件
			</li>
			<li>
				<strong>{stats.mustKnow}</strong> 則必看
			</li>
			<li>
				<strong>{stats.updates}</strong> 則有新進展
			</li>
			{stats.signals > 0 ? (
				<li>
					<strong>{stats.signals}</strong> 個值得觀察的趨勢
				</li>
			) : null}
			<li className="stat-produced">整理於 {formatInstant(producedAt)}</li>
		</ul>
	);
}
