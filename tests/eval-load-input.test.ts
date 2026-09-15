import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEvalInput } from "../src/eval/evaluator.ts";

const DATE = "2026-09-12";

let root: string;
let runDir: string;
let goldDir: string;
let fixturesDir: string;

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** The smallest run directory `loadEvalInput` will accept. */
function seedRun(): void {
	writeJson(join(runDir, "manifest.json"), {
		date: DATE,
		generatedAt: `${DATE}T00:00:00.000Z`,
		items: [
			{
				id: "i1",
				sourceType: "rss",
				trust: "UNTRUSTED_EXTERNAL_CONTENT",
				sourceName: "feed",
				title: "title i1",
				summary: "",
				publishedAt: `${DATE}T00:00:00.000Z`,
				metadata: {},
			},
		],
		facts: [],
	});
	writeJson(join(runDir, "item-decisions.json"), [
		{ itemId: "i1", disposition: "CANDIDATE", reason: "fixture", decidedAt: `${DATE}T01:00:00.000Z` },
	]);
	writeJson(join(runDir, "story-ledger.json"), [
		{
			storyId: "s1",
			date: DATE,
			canonicalTitle: "Story 1",
			sourceItemIds: ["i1"],
			primarySourceIds: ["i1"],
			firstSeenAt: `${DATE}T01:00:00.000Z`,
			lastSeenAt: `${DATE}T01:00:00.000Z`,
			status: "OPEN",
			changeType: "NEW",
			relevance: 0.9,
			novelty: 0.9,
			importance: 0.9,
			confidence: 0.9,
			reason: "fixture",
			factRefs: [],
		},
	]);
	writeJson(join(runDir, "materials.json"), {
		date: DATE,
		producedAt: `${DATE}T02:00:00.000Z`,
		stories: [
			{
				storyId: "s1",
				tier: "A",
				canonicalTitle: "Story 1",
				whySelected: "fixture",
				changeType: "NEW",
				importance: 0.9,
				novelty: 0.9,
				confidence: 0.9,
				sourceItemIds: ["i1"],
				primarySourceIds: ["i1"],
				factRefs: [],
			},
		],
		emergingSignals: [],
		curatorNotes: "",
	});
	writeJson(join(runDir, "brief.json"), {
		date: DATE,
		producedAt: `${DATE}T03:00:00.000Z`,
		stories: [
			{
				storyId: "s1",
				section: "AI_LLM",
				mustKnow: true,
				title: "Story 1",
				whatHappened: "x",
				whyItMatters: "x",
				whatChanged: "x",
				impact: "x",
				confidence: "HIGH",
				sourceItemIds: ["i1"],
				factRefs: [],
			},
		],
		emergingSignals: [],
		dailyAnalysis: "analysis",
		watchNext: ["next"],
	});
	writeJson(join(goldDir, `${DATE}.json`), {
		date: DATE,
		events: [
			{
				eventId: "ev1",
				canonicalTitle: "Event 1",
				itemIds: ["i1"],
				primaryItemIds: ["i1"],
				expectedChangeType: "NEW",
				expectedImportant: true,
				expectedSection: "AI_LLM",
			},
		],
		noiseItemIds: [],
		expectedEmergingSignals: [],
	});
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "di-eval-load-"));
	runDir = join(root, "run");
	goldDir = join(root, "gold");
	fixturesDir = join(root, "fixtures");
	for (const dir of [runDir, goldDir, fixturesDir]) mkdirSync(dir, { recursive: true });
	seedRun();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function load() {
	return loadEvalInput(runDir, DATE, { goldDir, fixturesDir });
}

describe("loadEvalInput — structured output retries", () => {
	it("counts failed EDITOR attempts from attempts.json", () => {
		writeJson(join(runDir, "attempts.json"), [
			{ attemptId: "a1", stage: "CURATOR", status: "FAILED", failureClass: "TIMEOUT" },
			{ attemptId: "a2", stage: "EDITOR", status: "FAILED", failureClass: "INVALID_AGENT_OUTPUT" },
			{ attemptId: "a3", stage: "EDITOR", status: "FAILED", failureClass: "INVALID_AGENT_OUTPUT" },
			{ attemptId: "a4", stage: "EDITOR", status: "SUCCESS" },
		]);
		expect(load().structuredOutputRetriesNeeded).toBe(2);
	});

	it("ignores run-state.json, which never carries attempts", () => {
		// The metric used to read this file and therefore always reported 0. A
		// run-state with a plausible-looking `attempts` key must not revive that.
		writeJson(join(runDir, "run-state.json"), {
			runId: "r1",
			date: DATE,
			status: "COMPLETED",
			attempts: [
				{ stage: "EDITOR", status: "FAILED" },
				{ stage: "EDITOR", status: "FAILED" },
			],
		});
		expect(load().structuredOutputRetriesNeeded).toBe(0);
	});

	it("reports no retries when the run never recorded an attempt", () => {
		expect(load().structuredOutputRetriesNeeded).toBe(0);
	});
});
