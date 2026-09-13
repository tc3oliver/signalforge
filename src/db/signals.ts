import type { Sql } from "./client.ts";

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export type SignalState = "emerging" | "strengthening" | "confirmed" | "fading";

export interface EmergingSignal {
	signalId: string;
	label: string;
	rationale: string;
	state: SignalState;
	confidence: number;
	firstSeenAt: string;
	lastSeenAt: string;
	storyIds: string[];
}

export interface SignalObservation {
	signalId: string;
	label: string;
	rationale: string;
	state: SignalState;
	confidence: number;
	storyIds: readonly string[];
	observedAt: string;
}

const COLUMNS = `signal_id, label, rationale, state, confidence,
	to_char(first_seen_at at time zone 'utc', ${ISO}) as first_seen_at,
	to_char(last_seen_at at time zone 'utc', ${ISO}) as last_seen_at,
	story_ids`;

interface SignalRow {
	signal_id: string; label: string; rationale: string; state: SignalState;
	confidence: number; first_seen_at: string; last_seen_at: string; story_ids: string[];
}

function toSignal(r: SignalRow): EmergingSignal {
	return {
		signalId: r.signal_id,
		label: r.label,
		rationale: r.rationale,
		state: r.state,
		confidence: r.confidence,
		firstSeenAt: r.first_seen_at,
		lastSeenAt: r.last_seen_at,
		storyIds: r.story_ids,
	};
}

/**
 * Observing a signal again keeps its original firstSeenAt and accumulates
 * evidence links; a signal's age is the whole point of the lifecycle, so it is
 * never reset by a later sighting.
 */
export async function observeSignal(
	sql: Sql,
	lineage: string,
	observation: SignalObservation,
): Promise<EmergingSignal> {
	const rows = await sql.unsafe<SignalRow[]>(
		`with upserted as (
			insert into emerging_signals (lineage, signal_id, label, rationale, state, confidence,
				first_seen_at, last_seen_at, story_ids)
			values ($1,$2,$3,$4,$5::emerging_signal_state,$6,$7::timestamptz,$7::timestamptz,$8::text[])
			on conflict (lineage, signal_id) do update set
				label = excluded.label,
				rationale = excluded.rationale,
				state = excluded.state,
				confidence = excluded.confidence,
				last_seen_at = excluded.last_seen_at,
				story_ids = array_union_ordered(emerging_signals.story_ids, excluded.story_ids),
				updated_at = now()
			returning *
		)
		select ${COLUMNS} from upserted`,
		[
			lineage, observation.signalId, observation.label, observation.rationale,
			observation.state, observation.confidence, observation.observedAt,
			observation.storyIds as string[],
		],
	);
	const row = rows[0];
	if (!row) throw new Error("signal upsert returned no row");
	return toSignal(row);
}

export async function listSignals(
	sql: Sql,
	lineage: string,
	states?: readonly SignalState[],
): Promise<EmergingSignal[]> {
	const rows = states === undefined
		? await sql.unsafe<SignalRow[]>(
			`select ${COLUMNS} from emerging_signals where lineage = $1 order by last_seen_at desc`,
			[lineage],
		)
		: await sql.unsafe<SignalRow[]>(
			`select ${COLUMNS} from emerging_signals
			 where lineage = $1 and state = any($2::emerging_signal_state[])
			 order by last_seen_at desc`,
			[lineage, states as string[]],
		);
	return rows.map(toSignal);
}

export async function signalsForStory(
	sql: Sql,
	lineage: string,
	storyId: string,
): Promise<EmergingSignal[]> {
	const rows = await sql.unsafe<SignalRow[]>(
		`select ${COLUMNS} from emerging_signals
		 where lineage = $1 and story_ids @> array[$2]::text[] order by last_seen_at desc`,
		[lineage, storyId],
	);
	return rows.map(toSignal);
}
