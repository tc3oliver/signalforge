/*
 * Whether the system has any memory.
 *
 * The Curator can mark a story NEW, UPDATE, ESCALATION, RESOLUTION, REVERSAL,
 * CONFIRMATION, RUMOR or NO_MATERIAL_CHANGE, and `find_history` exists to let it
 * decide which. Nothing checks that it ever does. A pipeline that marked every
 * story NEW every day would look healthy on every other metric while being, in
 * substance, a feed reader with extra steps — the failure would be invisible
 * precisely because each day's brief reads fine on its own.
 *
 * So the one number worth watching is the share of stories that are *not* NEW.
 * This does not enforce anything and deliberately does not: the deterministic
 * history invariant is a separate piece of work, and it should be designed
 * against five days of this measurement rather than against an intuition.
 */

/** The share below which continuity is treated as not yet working at all. */
export const CONTINUITY_FLOOR = 0.1;

export interface ChangeTypeCount {
	changeType: string;
	count: number;
}

export interface ContinuityMetrics {
	date: string;
	counts: ChangeTypeCount[];
	total: number;
	newCount: number;
	nonNewCount: number;
	/** 0..1, or null when the day produced no stories at all. */
	nonNewRate: number | null;
}

const NEW = "NEW";

export function continuityForDay(date: string, rows: readonly ChangeTypeCount[]): ContinuityMetrics {
	const counts = [...rows].sort((a, b) => b.count - a.count || (a.changeType < b.changeType ? -1 : 1));
	const total = counts.reduce((sum, r) => sum + r.count, 0);
	const newCount = counts.find((r) => r.changeType === NEW)?.count ?? 0;
	const nonNewCount = total - newCount;
	return {
		date,
		counts,
		total,
		newCount,
		nonNewCount,
		nonNewRate: total === 0 ? null : nonNewCount / total,
	};
}

export interface ContinuityVerdict {
	/** True when every measured day sat at or below the floor. */
	looksLikeNoMemory: boolean;
	daysMeasured: number;
	message: string;
}

/**
 * Reads a run of days and says whether history is doing anything.
 *
 * Only called with days from a single epoch — mixing a pre- and
 * post-personalization stretch here would be the same silent merge that
 * `checkAggregation` refuses, and continuity is one of the things the profile
 * plausibly moves.
 */
export function assessContinuity(days: readonly ContinuityMetrics[]): ContinuityVerdict {
	const measured = days.filter((d) => d.nonNewRate !== null);
	if (measured.length === 0) {
		return { looksLikeNoMemory: false, daysMeasured: 0, message: "No days with stories yet." };
	}
	const flat = measured.every((d) => (d.nonNewRate as number) <= CONTINUITY_FLOOR);
	const rates = measured.map((d) => `${d.date} ${((d.nonNewRate as number) * 100).toFixed(0)}%`).join(", ");
	return {
		looksLikeNoMemory: flat,
		daysMeasured: measured.length,
		message: flat
			? `Non-NEW rate stayed at or below ${(CONTINUITY_FLOOR * 100).toFixed(0)}% on all ` +
				`${measured.length} measured day(s): ${rates}. Stories are not being connected across days; ` +
				`a deterministic history invariant is the next thing worth building.`
			: `Non-NEW rate by day: ${rates}. Continuity is happening.`,
	};
}

/*
 * Emerging signals are tracked here rather than acted on. The lifecycle
 * question -- whether WATCHING needs splitting out of EMERGING -- is explicitly
 * deferred until this has five days behind it, so all that is recorded is how
 * old each signal is, how many days it has spanned, and how much evidence sits
 * under it.
 */
export interface SignalObservation {
	signalId: string;
	label: string;
	state: string;
	confidence: number;
	firstSeenAt: string;
	lastSeenAt: string;
	/** Calendar days from first to last sighting, inclusive. */
	daySpan: number;
	evidenceStories: number;
	evidenceSources: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function daySpan(firstSeenAt: string, lastSeenAt: string): number {
	const first = Date.parse(firstSeenAt);
	const last = Date.parse(lastSeenAt);
	if (Number.isNaN(first) || Number.isNaN(last)) return 0;
	return Math.max(1, Math.floor((last - first) / MS_PER_DAY) + 1);
}
