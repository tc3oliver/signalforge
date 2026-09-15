import Link from "next/link";
import type { DashboardView } from "../../lib/dashboard.ts";
import { formatDateKey } from "../../lib/format.ts";
import { DailyAnalysisPreview } from "./analysis-preview.tsx";
import { DayInReview } from "./day-in-review.tsx";
import { MustKnowGrid } from "./must-know.tsx";
import { NewSinceMorning } from "./new-since-morning.tsx";
import { EmergingSignals } from "./signal-card.tsx";
import { StorySection } from "./story-section.tsx";
import { TodayHero } from "./today-hero.tsx";
import { WatchNext } from "./watch-next.tsx";
import { WhatChanged } from "./what-changed.tsx";

/*
 * The Today page, top to bottom:
 *
 *   Level 1  hero + must know          -- what matters, in seconds
 *   Level 2  what changed, signals,    -- the day scanned, in minutes
 *            compact sections
 *   Level 3  is /story/[id]            -- reading, when it is worth it
 *
 * New-since-morning is an inbox and sits after the brief. The day-in-review
 * paragraph closes the page: how much was read so that this much remained.
 * The full day is /brief/[date].
 */
export function TodayDashboard({ view }: { view: DashboardView }) {
	return (
		<div className="dashboard">
			<TodayHero view={view} />
			<MustKnowGrid cards={view.mustKnow} />
			<div className="today-columns">
				<WhatChanged rows={view.changes} />
				<EmergingSignals signals={view.signals} />
			</div>
			{view.sections.map((section) => (
				<StorySection key={section.key} section={section} date={view.date} />
			))}
			<DailyAnalysisPreview analysis={view.analysis} date={view.date} />
			<WatchNext entries={view.watchNext} />
			<NewSinceMorning feed={view.newSinceMorning} />
			<DayInReview workload={view.workload} />
			<p className="full-brief">
				<Link href={`/brief/${view.date}`}>
					{formatDateKey(view.date)} 完整內容 <span aria-hidden="true">→</span>
				</Link>
			</p>
		</div>
	);
}
