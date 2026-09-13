import { describe, expect, it } from "vitest";
import {
	IllegalTransitionError,
	LEGAL_TRANSITIONS,
	PIPELINE_STATES,
	type PipelineState,
	assertTransition,
	isLegalTransition,
	toPersistedStatus,
} from "../src/pipeline/daily-run.ts";
import { RunStatus } from "../src/schemas/run.ts";

const HAPPY_PATH: PipelineState[] = [
	"CREATED",
	"COLLECTING",
	"COLLECTED",
	"CURATING",
	"MATERIALS_READY",
	"WRITING",
	"DRAFT_READY",
	"VALIDATING",
	"PUBLISHED",
];

describe("run state machine", () => {
	it("accepts the whole happy path", () => {
		for (let i = 0; i < HAPPY_PATH.length - 1; i++) {
			expect(isLegalTransition(HAPPY_PATH[i]!, HAPPY_PATH[i + 1]!)).toBe(true);
		}
	});

	it("rejects skipping validation", () => {
		expect(isLegalTransition("DRAFT_READY", "PUBLISHED")).toBe(false);
		expect(isLegalTransition("WRITING", "PUBLISHED")).toBe(false);
		expect(isLegalTransition("CURATING", "PUBLISHED")).toBe(false);
		expect(() => assertTransition("DRAFT_READY", "PUBLISHED")).toThrow(IllegalTransitionError);
	});

	it("rejects going backwards or sideways outside a retry edge", () => {
		expect(isLegalTransition("MATERIALS_READY", "COLLECTING")).toBe(false);
		expect(isLegalTransition("VALIDATING", "CURATING")).toBe(false);
		expect(isLegalTransition("COLLECTED", "WRITING")).toBe(false);
	});

	it("treats PUBLISHED as terminal", () => {
		expect(LEGAL_TRANSITIONS.PUBLISHED).toHaveLength(0);
		for (const state of PIPELINE_STATES) {
			expect(isLegalTransition("PUBLISHED", state)).toBe(false);
		}
	});

	it("lets each failure retry exactly its own stage", () => {
		expect(LEGAL_TRANSITIONS.COLLECTION_FAILED).toEqual(["COLLECTING"]);
		expect(LEGAL_TRANSITIONS.CURATION_FAILED).toEqual(["CURATING"]);
		expect(LEGAL_TRANSITIONS.EDITOR_FAILED).toEqual(["WRITING"]);
		expect(LEGAL_TRANSITIONS.VALIDATION_FAILED).toEqual(["WRITING", "VALIDATING"]);
		// A curation retry must not be able to jump past the editor.
		expect(isLegalTransition("CURATION_FAILED", "DRAFT_READY")).toBe(false);
	});

	it("names both states in the error", () => {
		expect(() => assertTransition("CREATED", "PUBLISHED")).toThrow(/CREATED -> PUBLISHED/);
	});

	it("maps every pipeline state onto a status the runs table accepts", () => {
		for (const state of PIPELINE_STATES) {
			expect(RunStatus.safeParse(toPersistedStatus(state)).success).toBe(true);
		}
		expect(toPersistedStatus("PUBLISHED")).toBe("COMPLETED");
		expect(toPersistedStatus("COLLECTING")).toBe("CREATED");
	});
});
