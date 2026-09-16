/*
 * Which days belong to the same experiment.
 *
 * An observation window is only a baseline if the thing being observed did not
 * change during it. The window opened on 2026-09-13 was treated as one baseline
 * through 2026-09-18, and then on 2026-09-15 the reader's interest profile
 * started reaching the Curator and the Editor as priors (commit e27bf39). That
 * changes relevance scoring, ordering and what reaches Must Know, which is
 * exactly what the window was measuring. Averaging across it would produce a
 * number describing no system that ever ran.
 *
 * `daily_briefs.profile_version` is the hash of the profile that shaped a brief,
 * so the boundary is recorded in the data rather than in a constant here. Days
 * before personalization carry null; each distinct hash after it is its own
 * epoch. Nothing in this file hardcodes a date, and nothing should: the next
 * profile edit moves the boundary again, and a constant would silently go stale
 * while still reporting confidently.
 */

/** The profile provenance of one published day. */
export interface BriefEpochRow {
	date: string;
	runId: string;
	/** Null for every brief published before the profile reached the agents. */
	profileVersion: string | null;
}

/** The id used for the days that predate personalization entirely. */
export const PRE_PERSONALIZATION_EPOCH = "pre-personalization";

export interface Epoch {
	/** `pre-personalization`, or `profile-<hash>`. Stable across runs. */
	id: string;
	profileVersion: string | null;
	/** Ascending, contiguous only in the sense that no other epoch interleaves. */
	dates: string[];
	startedAt: string;
	endedAt: string;
	days: number;
}

/**
 * Group published days by the profile that shaped them, ascending by date.
 *
 * Days sharing a `profileVersion` form one epoch even if a different epoch's
 * days fall between them — which should not happen forwards in time, but can
 * after a backfill re-publishes an old date, and silently splitting an epoch in
 * two because of a re-run would understate how much clean evidence exists.
 */
export function deriveEpochs(rows: readonly BriefEpochRow[]): Epoch[] {
	const byVersion = new Map<string, BriefEpochRow[]>();
	for (const row of [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
		const id = epochId(row.profileVersion);
		const bucket = byVersion.get(id);
		if (bucket) bucket.push(row);
		else byVersion.set(id, [row]);
	}

	const epochs: Epoch[] = [];
	for (const [id, group] of byVersion) {
		const dates = group.map((r) => r.date);
		epochs.push({
			id,
			profileVersion: group[0]?.profileVersion ?? null,
			dates,
			startedAt: dates[0] as string,
			endedAt: dates[dates.length - 1] as string,
			days: dates.length,
		});
	}
	return epochs.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
}

export function epochId(profileVersion: string | null): string {
	return profileVersion === null ? PRE_PERSONALIZATION_EPOCH : `profile-${profileVersion}`;
}

/** How many consecutive clean days an epoch needs before it is worth drawing conclusions from. */
export const REQUIRED_CLEAN_DAYS = 5;

export interface EpochAggregationCheck {
	ok: boolean;
	epochs: Epoch[];
	/** Set when more than one epoch is present; the reason aggregation was refused. */
	refusal?: string;
}

/**
 * Decide whether a set of days may be aggregated into one figure.
 *
 * The important half is the refusal. A reviewer reading a five-day summary has
 * no way to tell that two of the days came from a different system, so a report
 * that quietly averaged them would be worse than one that produced nothing —
 * it would look like evidence. When the days span epochs, the caller must
 * either report per epoch or report this refusal, never a merged number.
 */
export function checkAggregation(rows: readonly BriefEpochRow[]): EpochAggregationCheck {
	const epochs = deriveEpochs(rows);
	if (epochs.length <= 1) return { ok: true, epochs };
	const described = epochs.map((e) => `${e.id} (${e.startedAt}..${e.endedAt}, ${e.days}d)`).join(", ");
	return {
		ok: false,
		epochs,
		refusal:
			`These days span ${epochs.length} intelligence epochs: ${described}. ` +
			`They are not one baseline and will not be aggregated into one. ` +
			`Report per epoch, or restrict the range to a single epoch.`,
	};
}

/** The epoch that is currently accumulating evidence, and how far along it is. */
export function currentEpoch(epochs: readonly Epoch[]): Epoch | undefined {
	return epochs[epochs.length - 1];
}
