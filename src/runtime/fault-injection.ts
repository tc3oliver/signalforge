import { z } from "zod";
import { FailureClass, type Stage } from "../schemas/run.ts";
import { InvalidAgentOutputError, ProgrammerError, ToolLoopError } from "./error-classifier.ts";
import { type ModelSpec, modelKey } from "./model-config.ts";

/**
 * Test-only fault injection. See the "Fault injection (test-only)" section of
 * README.md before touching this file — it must never fire in a production run,
 * and it must never bypass the real classifier.
 */

export const FAULT_INJECTION_ENV_VAR = "DAILY_INTELLIGENCE_FAULT_INJECTION";

const FaultInjectionSpecSchema = z
	.object({
		stage: z.enum(["curator", "editor"]),
		/** "primary" | "secondary" | "tertiary" (chain position) or a full "provider/model" key. */
		model: z.string().min(1),
		afterProcessedItems: z.number().int().nonnegative(),
		failureClass: FailureClass,
	})
	.strict();

export type FaultInjectionSpec = z.infer<typeof FaultInjectionSpecSchema>;

/**
 * Parse and validate the raw env var contents. Throws on anything that is not a
 * well-formed spec — a typo here must fail loudly at startup rather than silently
 * running with fault injection disabled, which would make a run look normal when
 * it was actually misconfigured.
 */
export function parseFaultInjectionSpec(raw: string): FaultInjectionSpec {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (err) {
		throw new Error(
			`${FAULT_INJECTION_ENV_VAR} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const result = FaultInjectionSpecSchema.safeParse(json);
	if (!result.success) {
		throw new Error(`${FAULT_INJECTION_ENV_VAR} is invalid: ${result.error.message}`);
	}
	return result.data;
}

/**
 * Read and validate the env var. Undefined or empty means "off" (the default);
 * anything else is parsed strictly. Never consult NODE_ENV or any config file —
 * this is an explicit, single-variable opt-in.
 */
export function loadFaultInjectionSpec(env: Record<string, string | undefined> = process.env): FaultInjectionSpec | undefined {
	const raw = env[FAULT_INJECTION_ENV_VAR];
	if (raw === undefined || raw.trim() === "") return undefined;
	return parseFaultInjectionSpec(raw);
}

/** Recorded on the run's attempt so a report can never mistake this for a spontaneous fallback. */
export interface FaultInjectionRecord {
	stage: Stage;
	model: string;
	failureClass: FailureClass;
	afterProcessedItems: number;
	firedAtProcessedItems: number;
}

const FAULT_MARKER = Symbol.for("daily-intelligence.fault-injection");

interface Marked {
	[FAULT_MARKER]?: FaultInjectionRecord;
}

/** Tag an error (non-enumerably, so it never leaks into sanitized errorMeta) with its injection record. */
function markInjected(err: Error, record: FaultInjectionRecord): Error {
	Object.defineProperty(err, FAULT_MARKER, {
		value: record,
		enumerable: false,
		configurable: true,
	});
	return err;
}

/** Walk an error's own value plus its cause chain looking for the injection marker. */
export function getFaultInjectionRecord(err: unknown): FaultInjectionRecord | undefined {
	let cur: unknown = err;
	const seen = new Set<unknown>();
	while (typeof cur === "object" && cur !== null && !seen.has(cur)) {
		seen.add(cur);
		const marked = (cur as Marked)[FAULT_MARKER];
		if (marked) return marked;
		cur = (cur as { cause?: unknown }).cause;
	}
	return undefined;
}

function withStatus(message: string, status: number): Error {
	return Object.assign(new Error(message), { status });
}

function withCode(message: string, code: string): Error {
	return Object.assign(new Error(message), { code });
}

/**
 * Build a real error object that the existing {@link classifyError} classifies,
 * through its normal structural/message heuristics, into `failureClass`. No
 * special-case bypass exists in the classifier — this only manufactures inputs
 * it already understands.
 */
export function synthesizeFaultError(failureClass: FailureClass): Error {
	const msg = `[fault-injection] synthetic ${failureClass} failure injected for testing`;
	switch (failureClass) {
		case "AUTH":
			return withStatus(msg, 401);
		case "BILLING":
			return withStatus(msg, 402);
		case "RATE_LIMIT":
			return withStatus(`${msg} (rate limit)`, 429);
		case "QUOTA":
			return withStatus(`${msg}; you exceeded your current quota`, 429);
		case "MODEL_UNAVAILABLE":
			return withStatus(msg, 404);
		case "TIMEOUT":
			return withStatus(msg, 408);
		case "SERVER_ERROR":
			return withStatus(msg, 500);
		case "NETWORK":
			return withCode(msg, "ECONNRESET");
		case "USER_ABORT": {
			const err = new Error(msg);
			err.name = "AbortError";
			return err;
		}
		case "CONTEXT_OVERFLOW":
			return new Error(`${msg}: maximum context length exceeded`);
		case "INVALID_AGENT_OUTPUT":
			return new InvalidAgentOutputError(msg);
		case "TOOL_LOOP":
			return new ToolLoopError(msg);
		case "PROGRAMMER_ERROR":
			return new ProgrammerError(msg);
		case "UNKNOWN":
			return new Error(msg);
	}
}

function stageMatches(spec: FaultInjectionSpec, stage: Stage): boolean {
	return spec.stage.toUpperCase() === stage;
}

function modelMatches(spec: FaultInjectionSpec, spec2: ModelSpec, chainIndex: number): boolean {
	if (spec.model === "primary") return chainIndex === 0;
	if (spec.model === "secondary") return chainIndex === 1;
	if (spec.model === "tertiary") return chainIndex === 2;
	return spec.model === modelKey(spec2);
}

export interface FaultCheckContext {
	stage: Stage;
	spec: ModelSpec;
	/** Position of `spec` within the model chain, 0-based. */
	chainIndex: number;
	/** Items processed so far in this run (curator) or tool calls made so far (editor). */
	processedItems: number;
}

/**
 * Consults the fault spec loaded once at construction and fires (throwing a
 * classifier-real error) at most once per run. Passed down to the worker
 * boundary (`runStageWithFallback`) and, for the curator, to the per-turn
 * progress checkpoint so a fault can fire mid-attempt rather than only between
 * model attempts.
 */
export class FaultInjector {
	readonly #spec: FaultInjectionSpec | undefined;
	#fired = false;

	constructor(spec: FaultInjectionSpec | undefined) {
		this.#spec = spec;
	}

	static fromEnv(env: Record<string, string | undefined> = process.env): FaultInjector {
		return new FaultInjector(loadFaultInjectionSpec(env));
	}

	static disabled(): FaultInjector {
		return new FaultInjector(undefined);
	}

	get enabled(): boolean {
		return this.#spec !== undefined;
	}

	get hasFired(): boolean {
		return this.#fired;
	}

	/**
	 * Returns a synthetic error to throw if the spec matches and has not fired
	 * yet, else `undefined`. Marks itself as fired as a side effect of returning
	 * an error, so it is safe to call this repeatedly (e.g. once per curator
	 * nudge) without double-firing.
	 */
	check(ctx: FaultCheckContext): Error | undefined {
		if (!this.#spec || this.#fired) return undefined;
		if (!stageMatches(this.#spec, ctx.stage)) return undefined;
		if (!modelMatches(this.#spec, ctx.spec, ctx.chainIndex)) return undefined;
		if (ctx.processedItems < this.#spec.afterProcessedItems) return undefined;

		this.#fired = true;
		const err = synthesizeFaultError(this.#spec.failureClass);
		return markInjected(err, {
			stage: ctx.stage,
			model: modelKey(ctx.spec),
			failureClass: this.#spec.failureClass,
			afterProcessedItems: this.#spec.afterProcessedItems,
			firedAtProcessedItems: ctx.processedItems,
		});
	}
}
