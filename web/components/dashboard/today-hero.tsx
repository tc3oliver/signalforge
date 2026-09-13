import type { DashboardView } from "../../lib/dashboard.ts";
import { formatDateBanner, formatInstant } from "../../lib/format.ts";

/**
 * Level 1 of the page: the date, the editor's opening line, and the day's
 * counts. Built to be read in a few seconds, so it holds one paragraph and one
 * row of numbers and nothing else.
 */
export function TodayHero({ view }: { view: DashboardView }) {
	const { stats } = view.hero;
	const capped = view.newSinceMorning.capped;
	return (
		<section className="hero" aria-labelledby="today-hero">
			<p className="hero-date">{formatDateBanner(view.date)}</p>
			<h1 id="today-hero" className="hero-label">
				Today in 60 seconds
			</h1>
			{view.hero.summary !== "" ? <p className="hero-summary">{view.hero.summary}</p> : null}
			<TodayStats stats={stats} producedAt={view.producedAt} capped={capped} />
		</section>
	);
}

export function TodayStats({
	stats,
	producedAt,
	capped = false,
}: {
	stats: DashboardView["hero"]["stats"];
	producedAt: string;
	/** The late-item read hit its limit, so the number is "at least". */
	capped?: boolean;
}) {
	return (
		<ul className="hero-stats" aria-label="Today's counts">
			<li>
				<strong>{stats.stories}</strong> {plural(stats.stories, "story", "stories")}
			</li>
			<li>
				<strong>{stats.mustKnow}</strong> must know
			</li>
			<li>
				<strong>{stats.updates}</strong> {plural(stats.updates, "update", "updates")}
			</li>
			<li>
				<strong>{stats.signals}</strong> {plural(stats.signals, "signal", "signals")}
			</li>
			{stats.newSinceMorning > 0 ? (
				<li className="stat-new">
					<a href="#new-since-morning">
						<span className="dot" aria-hidden="true" />
						<strong>
							{stats.newSinceMorning}
							{capped ? "+" : ""}
						</strong>{" "}
						new since morning
					</a>
				</li>
			) : null}
			<li className="stat-produced">produced {formatInstant(producedAt)}</li>
		</ul>
	);
}

function plural(n: number, one: string, many: string): string {
	return n === 1 ? one : many;
}
