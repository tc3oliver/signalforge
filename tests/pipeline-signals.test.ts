import { describe, expect, it } from "vitest";
import {
	type KnownSignal,
	confidenceFor,
	jaccard,
	matchSignal,
	nextSignalState,
	reconcileSignals,
	signalIdFor,
} from "../src/pipeline/signals.ts";

function known(over: Partial<KnownSignal> = {}): KnownSignal {
	return {
		signalId: "sig-1",
		label: "Inference costs keep falling",
		state: "emerging",
		confidence: 0.3,
		storyIds: ["story-a", "story-b", "story-c"],
		firstSeenAt: "2026-09-10T06:00:00.000Z",
		lastSeenAt: "2026-09-10T06:00:00.000Z",
		...over,
	};
}

describe("signal lifecycle", () => {
	it("walks emerging -> strengthening -> confirmed while evidence keeps arriving", () => {
		expect(nextSignalState(undefined, true)).toBe("emerging");
		expect(nextSignalState("emerging", true)).toBe("strengthening");
		expect(nextSignalState("strengthening", true)).toBe("confirmed");
		expect(nextSignalState("confirmed", true)).toBe("confirmed");
	});

	it("fades on silence and returns to strengthening rather than emerging", () => {
		expect(nextSignalState("confirmed", false)).toBe("fading");
		expect(nextSignalState("fading", true)).toBe("strengthening");
	});

	it("raises confidence with state maturity and evidence count", () => {
		expect(confidenceFor("emerging", 1)).toBeLessThan(confidenceFor("confirmed", 1));
		expect(confidenceFor("confirmed", 1)).toBeLessThan(confidenceFor("confirmed", 4));
		expect(confidenceFor("confirmed", 99)).toBeLessThanOrEqual(1);
	});
});

describe("cross-day matching", () => {
	it("matches on evidence overlap even when the label text drifts", () => {
		const yesterday = known({ label: "Inference costs keep falling" });
		const today = {
			label: "Cheap inference is reshaping tooling",
			rationale: "Different words, same three stories.",
			storyIds: ["story-a", "story-b", "story-d"],
		};

		const match = matchSignal(today, [yesterday]);
		expect(match?.signalId).toBe("sig-1");

		const { observed } = reconcileSignals([today], [yesterday], "2026-09-11T06:00:00.000Z");
		expect(observed[0]!.signalId).toBe("sig-1");
		expect(observed[0]!.matched).toBe(true);
		expect(observed[0]!.state).toBe("strengthening");
		// Evidence accumulates rather than being replaced.
		expect(observed[0]!.storyIds).toEqual(["story-a", "story-b", "story-c", "story-d"]);
	});

	it("does not match on an identical label with unrelated evidence", () => {
		const yesterday = known();
		const today = {
			label: "Inference costs keep falling",
			rationale: "Same words, entirely different stories.",
			storyIds: ["story-x", "story-y", "story-z"],
		};

		expect(matchSignal(today, [yesterday])).toBeUndefined();
		const { observed } = reconcileSignals([today], [yesterday], "2026-09-11T06:00:00.000Z");
		expect(observed[0]!.matched).toBe(false);
		expect(observed[0]!.signalId).toBe(signalIdFor(today.storyIds));
		expect(observed[0]!.state).toBe("emerging");
	});

	it("does not match two large sets that share a single story", () => {
		const yesterday = known({ storyIds: ["a", "b", "c", "d", "e", "f"] });
		expect(
			matchSignal({ label: "x", rationale: "y", storyIds: ["f", "g", "h", "i", "j", "k"] }, [yesterday]),
		).toBeUndefined();
	});

	it("scores overlap with jaccard", () => {
		expect(jaccard(["a", "b"], ["a", "b"])).toBe(1);
		expect(jaccard(["a"], ["b"])).toBe(0);
		expect(jaccard([], ["a"])).toBe(0);
	});
});

describe("reconciliation", () => {
	it("fades a known signal after the silence window, keeping its last sighting", () => {
		const stale = known({ state: "confirmed", lastSeenAt: "2026-09-06T06:00:00.000Z" });
		const { observed, faded } = reconcileSignals([], [stale], "2026-09-13T06:00:00.000Z");

		expect(observed).toHaveLength(0);
		expect(faded).toHaveLength(1);
		expect(faded[0]!.state).toBe("fading");
		expect(faded[0]!.observedAt).toBe(stale.lastSeenAt);
	});

	it("leaves a recently seen signal alone", () => {
		const recent = known({ state: "confirmed", lastSeenAt: "2026-09-12T06:00:00.000Z" });
		const { faded } = reconcileSignals([], [recent], "2026-09-13T06:00:00.000Z");
		expect(faded).toHaveLength(0);
	});

	it("advances a signal once even when two candidates match it on the same day", () => {
		const yesterday = known({ state: "emerging" });
		const { observed } = reconcileSignals(
			[
				{ label: "first framing", rationale: "r", storyIds: ["story-a", "story-b"] },
				{ label: "second framing", rationale: "r", storyIds: ["story-b", "story-c"] },
			],
			[yesterday],
			"2026-09-11T06:00:00.000Z",
		);

		expect(observed.map((o) => o.state)).toEqual(["strengthening", "emerging"]);
	});
});
