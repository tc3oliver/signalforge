import { describe, expect, it } from "vitest";
import { classifyError } from "../src/runtime/error-classifier.ts";
import type { FailureClass } from "../src/schemas/run.ts";
import { FailureClass as FailureClassSchema } from "../src/schemas/run.ts";
import {
	FAULT_INJECTION_ENV_VAR,
	FaultInjector,
	getFaultInjectionRecord,
	loadFaultInjectionSpec,
	parseFaultInjectionSpec,
	synthesizeFaultError,
} from "../src/runtime/fault-injection.ts";
import type { ModelSpec } from "../src/runtime/model-config.ts";

const CHAIN: readonly ModelSpec[] = [
	{ provider: "github-copilot", model: "gemini-3.8-flash" },
	{ provider: "openai-codex", model: "gpt-5.6-sol" },
	{ provider: "opencode-go", model: "deepseek-v4.1-flash" },
];

const VALID_JSON = JSON.stringify({
	stage: "curator",
	model: "primary",
	afterProcessedItems: 20,
	failureClass: "RATE_LIMIT",
});

describe("parseFaultInjectionSpec", () => {
	it("accepts a well-formed spec", () => {
		expect(parseFaultInjectionSpec(VALID_JSON)).toEqual({
			stage: "curator",
			model: "primary",
			afterProcessedItems: 20,
			failureClass: "RATE_LIMIT",
		});
	});

	it("throws a clear error on invalid JSON", () => {
		expect(() => parseFaultInjectionSpec("{not json")).toThrow(/not valid JSON/);
	});

	it("throws on an unknown field rather than silently ignoring it", () => {
		const raw = JSON.stringify({
			stage: "curator",
			model: "primary",
			afterProcessedItems: 20,
			failureClass: "RATE_LIMIT",
			typoField: true,
		});
		expect(() => parseFaultInjectionSpec(raw)).toThrow(new RegExp(FAULT_INJECTION_ENV_VAR));
	});

	it("throws on an unrecognized failureClass enum value", () => {
		const raw = JSON.stringify({
			stage: "curator",
			model: "primary",
			afterProcessedItems: 20,
			failureClass: "NOT_A_REAL_CLASS",
		});
		expect(() => parseFaultInjectionSpec(raw)).toThrow();
	});

	it("throws on an unrecognized stage", () => {
		const raw = JSON.stringify({
			stage: "validator",
			model: "primary",
			afterProcessedItems: 20,
			failureClass: "RATE_LIMIT",
		});
		expect(() => parseFaultInjectionSpec(raw)).toThrow();
	});
});

describe("loadFaultInjectionSpec (off by default)", () => {
	it("is undefined when the env var is absent", () => {
		expect(loadFaultInjectionSpec({})).toBeUndefined();
	});

	it("is undefined when the env var is empty", () => {
		expect(loadFaultInjectionSpec({ [FAULT_INJECTION_ENV_VAR]: "" })).toBeUndefined();
		expect(loadFaultInjectionSpec({ [FAULT_INJECTION_ENV_VAR]: "   " })).toBeUndefined();
	});

	it("parses when the env var is set", () => {
		expect(loadFaultInjectionSpec({ [FAULT_INJECTION_ENV_VAR]: VALID_JSON })).toEqual({
			stage: "curator",
			model: "primary",
			afterProcessedItems: 20,
			failureClass: "RATE_LIMIT",
		});
	});

	it("throws for a set-but-invalid env var rather than disabling silently", () => {
		expect(() => loadFaultInjectionSpec({ [FAULT_INJECTION_ENV_VAR]: "{broken" })).toThrow();
	});
});

describe("FaultInjector.check", () => {
	it("never fires when disabled", () => {
		const injector = FaultInjector.disabled();
		expect(injector.enabled).toBe(false);
		expect(
			injector.check({ stage: "CURATOR", spec: CHAIN[0]!, chainIndex: 0, processedItems: 999 }),
		).toBeUndefined();
	});

	it("does not fire before the threshold", () => {
		const injector = new FaultInjector({
			stage: "curator",
			model: "primary",
			afterProcessedItems: 20,
			failureClass: "RATE_LIMIT",
		});
		expect(
			injector.check({ stage: "CURATOR", spec: CHAIN[0]!, chainIndex: 0, processedItems: 19 }),
		).toBeUndefined();
	});

	it("does not fire for the wrong stage", () => {
		const injector = new FaultInjector({
			stage: "editor",
			model: "primary",
			afterProcessedItems: 0,
			failureClass: "RATE_LIMIT",
		});
		expect(
			injector.check({ stage: "CURATOR", spec: CHAIN[0]!, chainIndex: 0, processedItems: 5 }),
		).toBeUndefined();
	});

	it("does not fire for the wrong model", () => {
		const injector = new FaultInjector({
			stage: "curator",
			model: "secondary",
			afterProcessedItems: 0,
			failureClass: "RATE_LIMIT",
		});
		expect(
			injector.check({ stage: "CURATOR", spec: CHAIN[0]!, chainIndex: 0, processedItems: 5 }),
		).toBeUndefined();
	});

	it("matches a chain-position selector (primary/secondary/tertiary)", () => {
		const injector = new FaultInjector({
			stage: "curator",
			model: "secondary",
			afterProcessedItems: 0,
			failureClass: "RATE_LIMIT",
		});
		expect(
			injector.check({ stage: "CURATOR", spec: CHAIN[1]!, chainIndex: 1, processedItems: 0 }),
		).toBeInstanceOf(Error);
	});

	it("matches a full provider/model key selector", () => {
		const injector = new FaultInjector({
			stage: "curator",
			model: "openai-codex/gpt-5.6-sol",
			afterProcessedItems: 0,
			failureClass: "RATE_LIMIT",
		});
		expect(
			injector.check({ stage: "CURATOR", spec: CHAIN[1]!, chainIndex: 1, processedItems: 0 }),
		).toBeInstanceOf(Error);
	});

	it("fires at most once per run (fire-once property)", () => {
		const injector = new FaultInjector({
			stage: "curator",
			model: "primary",
			afterProcessedItems: 5,
			failureClass: "RATE_LIMIT",
		});
		const ctx = { stage: "CURATOR" as const, spec: CHAIN[0]!, chainIndex: 0, processedItems: 10 };
		const first = injector.check(ctx);
		const second = injector.check(ctx);
		expect(first).toBeInstanceOf(Error);
		expect(second).toBeUndefined();
		expect(injector.hasFired).toBe(true);
	});

	it("records what fired, for artifact traceability", () => {
		const injector = new FaultInjector({
			stage: "curator",
			model: "primary",
			afterProcessedItems: 5,
			failureClass: "AUTH",
		});
		const err = injector.check({ stage: "CURATOR", spec: CHAIN[0]!, chainIndex: 0, processedItems: 7 });
		const record = getFaultInjectionRecord(err);
		expect(record).toEqual({
			stage: "CURATOR",
			model: "github-copilot/gemini-3.8-flash",
			failureClass: "AUTH",
			afterProcessedItems: 5,
			firedAtProcessedItems: 7,
		});
	});
});

describe("synthesizeFaultError classifies to the requested FailureClass via the real classifier", () => {
	for (const failureClass of FailureClassSchema.options) {
		it(`${failureClass}`, () => {
			const err = synthesizeFaultError(failureClass as FailureClass);
			const { failureClass: classified } = classifyError(err);
			expect(classified).toBe(failureClass);
		});
	}

	it("RATE_LIMIT synthetic error carries an HTTP status the classifier used", () => {
		const err = synthesizeFaultError("RATE_LIMIT") as Error & { status?: number };
		expect(err.status).toBe(429);
		const { errorMeta } = classifyError(err);
		expect(errorMeta["status"]).toBe(429);
	});
});
