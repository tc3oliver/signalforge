import { createHash } from "node:crypto";
import type { SignalState } from "../db/signals.ts";

/*
 * An emerging signal is a claim about a pattern across stories. The label is
 * model-written prose and drifts every day ("agents everywhere" one morning,
 * "agentic tooling consolidates" the next), so matching on it would split one
 * signal into a new row per day and its age — the only thing that makes a signal
 * interesting — would never accumulate. The evidence story set is the stable
 * identity, so that is what we match on.
 */

export interface SignalCandidate {
	label: string;
	rationale: string;
	storyIds: readonly string[];
}

export interface KnownSignal {
	signalId: string;
	label: string;
	state: SignalState;
	confidence: number;
	storyIds: readonly string[];
	firstSeenAt: string;
	lastSeenAt: string;
}

export interface MatchOptions {
	/** Minimum number of shared stories for a match. */
	minOverlap?: number;
	/** Minimum Jaccard similarity, so two large sets sharing one story do not match. */
	minJaccard?: number;
}

const DEFAULT_MIN_OVERLAP = 2;
const DEFAULT_MIN_JACCARD = 0.25;

export function jaccard(a: readonly string[], b: readonly string[]): number {
	const left = new Set(a);
	const right = new Set(b);
	if (left.size === 0 || right.size === 0) return 0;
	let shared = 0;
	for (const id of left) if (right.has(id)) shared += 1;
	return shared / (left.size + right.size - shared);
}

export function overlapCount(a: readonly string[], b: readonly string[]): number {
	const right = new Set(b);
	let shared = 0;
	for (const id of new Set(a)) if (right.has(id)) shared += 1;
	return shared;
}

/**
 * Best evidence-overlap match for a candidate, or undefined when today's signal
 * is genuinely new. A single-story signal cannot reach `minOverlap`, so it is
 * allowed to match on an exact set instead — otherwise a one-story signal could
 * never mature past `emerging`.
 */
export function matchSignal(
	candidate: SignalCandidate,
	known: readonly KnownSignal[],
	options: MatchOptions = {},
): KnownSignal | undefined {
	const minOverlap = options.minOverlap ?? DEFAULT_MIN_OVERLAP;
	const minJaccard = options.minJaccard ?? DEFAULT_MIN_JACCARD;

	let best: { signal: KnownSignal; score: number } | undefined;
	for (const signal of known) {
		const shared = overlapCount(candidate.storyIds, signal.storyIds);
		if (shared === 0) continue;
		const score = jaccard(candidate.storyIds, signal.storyIds);
		const enough =
			(shared >= minOverlap && score >= minJaccard) ||
			(candidate.storyIds.length === 1 && score === 1);
		if (!enough) continue;
		if (!best || score > best.score) best = { signal, score };
	}
	return best?.signal;
}

/**
 * One step of the lifecycle, as a pure function of the previous state.
 *
 * A signal seen for the first time is `emerging`. Each further day of evidence
 * moves it one step up (emerging -> strengthening -> confirmed) and `confirmed`
 * is terminal while evidence keeps arriving. Silence for longer than
 * `fadeAfterDays` moves it to `fading` — never straight to deletion, because a
 * pattern that goes quiet is itself worth reporting. Evidence returning after a
 * fade restarts at `strengthening` rather than `emerging`: the signal is not
 * new, it is back, and rewinding to `emerging` would misreport its age.
 */
export function nextSignalState(previous: SignalState | undefined, seenToday: boolean): SignalState {
	if (!seenToday) return "fading";
	switch (previous) {
		case undefined:
			return "emerging";
		case "emerging":
			return "strengthening";
		case "strengthening":
			return "confirmed";
		case "confirmed":
			return "confirmed";
		case "fading":
			return "strengthening";
	}
}

/** Confidence is evidence-driven: state maturity plus how many stories support it. */
export function confidenceFor(state: SignalState, evidenceCount: number): number {
	const base: Record<SignalState, number> = {
		emerging: 0.3,
		strengthening: 0.5,
		confirmed: 0.75,
		fading: 0.35,
	};
	const evidence = Math.min(0.2, Math.max(0, evidenceCount - 1) * 0.05);
	return Number(Math.min(1, base[state] + evidence).toFixed(3));
}

/** Stable id for a signal seen for the first time; matching never relies on it. */
export function signalIdFor(storyIds: readonly string[]): string {
	const digest = createHash("sha1").update([...storyIds].sort().join("|")).digest("hex");
	return `sig-${digest.slice(0, 16)}`;
}

export interface SignalUpdate {
	signalId: string;
	label: string;
	rationale: string;
	state: SignalState;
	confidence: number;
	storyIds: string[];
	observedAt: string;
	/** True when this candidate matched an existing signal by evidence overlap. */
	matched: boolean;
}

export interface ReconcileOptions extends MatchOptions {
	/** Days of silence before a signal is marked fading. */
	fadeAfterDays?: number;
}

const DEFAULT_FADE_AFTER_DAYS = 3;

export interface ReconcileResult {
	/** Signals observed today: new ones and matched ones, ready to upsert. */
	observed: SignalUpdate[];
	/** Known signals with no evidence today that have now aged into `fading`. */
	faded: SignalUpdate[];
}

/**
 * Pure reconciliation of today's candidates against what the store already
 * knows. Doing this without touching the database is what makes the lifecycle
 * testable; `daily-run.ts` is the only place that writes the result.
 */
export function reconcileSignals(
	candidates: readonly SignalCandidate[],
	known: readonly KnownSignal[],
	observedAt: string,
	options: ReconcileOptions = {},
): ReconcileResult {
	const fadeAfterDays = options.fadeAfterDays ?? DEFAULT_FADE_AFTER_DAYS;
	const observedNow = new Date(observedAt).getTime();
	const matchedIds = new Set<string>();
	const observed: SignalUpdate[] = [];

	for (const candidate of candidates) {
		const existing = matchSignal(candidate, known, options);
		// A second candidate matching the same signal on one day is still one
		// day of evidence, so the state only advances once.
		const alreadyMatched = existing !== undefined && matchedIds.has(existing.signalId);
		const state = nextSignalState(existing?.state, true);
		const effectiveState = alreadyMatched ? (existing?.state ?? state) : state;
		if (existing) matchedIds.add(existing.signalId);

		const storyIds = existing
			? [...new Set([...existing.storyIds, ...candidate.storyIds])]
			: [...new Set(candidate.storyIds)];

		observed.push({
			signalId: existing?.signalId ?? signalIdFor(candidate.storyIds),
			label: candidate.label,
			rationale: candidate.rationale,
			state: effectiveState,
			confidence: confidenceFor(effectiveState, storyIds.length),
			storyIds,
			observedAt,
			matched: existing !== undefined,
		});
	}

	const faded: SignalUpdate[] = [];
	for (const signal of known) {
		if (matchedIds.has(signal.signalId)) continue;
		if (signal.state === "fading") continue;
		const silentMs = observedNow - new Date(signal.lastSeenAt).getTime();
		if (silentMs < fadeAfterDays * 24 * 60 * 60 * 1000) continue;
		faded.push({
			signalId: signal.signalId,
			label: signal.label,
			rationale: `No supporting evidence for ${fadeAfterDays} days.`,
			state: "fading",
			confidence: confidenceFor("fading", signal.storyIds.length),
			storyIds: [...signal.storyIds],
			observedAt,
			matched: true,
		});
	}

	return { observed, faded };
}
