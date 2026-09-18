import { randomUUID } from "node:crypto";
import type { AgentAttempt, FailureClass, Stage, TokenUsage } from "../schemas/run.ts";
import { classifyError } from "./error-classifier.ts";
import { FaultInjector, getFaultInjectionRecord } from "./fault-injection.ts";
import { type ModelSpec, modelKey } from "./model-config.ts";
import { isProgressYield } from "./progress-yield.ts";
import { isTurnAbandoned } from "./turn-timeout.ts";

/** What the router wants the driver to do after a failed attempt. */
export type Action =
	| { kind: "RETRY_SAME" }
	| { kind: "CORRECTIVE_RETRY_SAME" }
	| { kind: "RESUME_SAME" }
	| { kind: "FRESH_SESSION_SAME" }
	/**
	 * Not a failure response. The turn reached its work-unit ceiling with
	 * progress committed; carry on with the same model in a fresh session. It is
	 * the only action that does not count against `maxAttemptsPerModel`, because
	 * a bounded worker doing its job must not look like a model running out of
	 * retries. See runtime/progress-yield.ts.
	 */
	| { kind: "CONTINUE_SAME" }
	| { kind: "FALLBACK" }
	| { kind: "FAIL" };

export type AttemptMode = "FRESH" | "CORRECTIVE" | "RESUME";

/**
 * Per-run routing state. The only thing that survives across stages is the set
 * of providers that proved to be unusable (bad or missing credentials): there is
 * no point paying the latency of re-authenticating against them every attempt.
 */
export class RouterState {
	readonly #degraded = new Map<string, FailureClass>();

	markProviderDegraded(provider: string, reason: FailureClass = "AUTH"): void {
		if (!this.#degraded.has(provider)) this.#degraded.set(provider, reason);
	}

	isProviderDegraded(provider: string): boolean {
		return this.#degraded.has(provider);
	}

	degradedReason(provider: string): FailureClass | undefined {
		return this.#degraded.get(provider);
	}

	degradedProviders(): string[] {
		return [...this.#degraded.keys()];
	}
}

/**
 * Per-failure-class policy.
 *
 * @param sameModelAttempts attempts already completed on the CURRENT model,
 *   including the one that just failed — so `1` means "this is the first
 *   failure on this model".
 */
export function decideAction(failureClass: FailureClass, sameModelAttempts: number): Action {
	const firstFailure = sameModelAttempts <= 1;
	switch (failureClass) {
		// Transient: one cheap retry on the same model, then move on.
		case "NETWORK":
		case "TIMEOUT":
		case "RATE_LIMIT":
		case "SERVER_ERROR":
			return firstFailure ? { kind: "RETRY_SAME" } : { kind: "FALLBACK" };

		// Retrying cannot help — the model/account is unusable for this run.
		case "QUOTA":
		case "BILLING":
		case "MODEL_UNAVAILABLE":
		case "AUTH":
			return { kind: "FALLBACK" };

		// The model answered, just not in the required shape: tell it so, once.
		case "INVALID_AGENT_OUTPUT":
			return firstFailure ? { kind: "CORRECTIVE_RETRY_SAME" } : { kind: "FALLBACK" };

		// Mid-flight tool thrash: resume the existing session rather than redo it.
		case "TOOL_LOOP":
			return firstFailure ? { kind: "RESUME_SAME" } : { kind: "FALLBACK" };

		// A smaller fallback model would overflow sooner; shrink the session
		// instead and stay on this model.
		case "CONTEXT_OVERFLOW":
			return { kind: "FRESH_SESSION_SAME" };

		// Our bug, or the user's decision. Neither is the model's fault.
		case "PROGRAMMER_ERROR":
		case "USER_ABORT":
			return { kind: "FAIL" };

		case "UNKNOWN":
			return firstFailure ? { kind: "RETRY_SAME" } : { kind: "FALLBACK" };
	}
}

const SAME_MODEL_ACTIONS = new Set<Action["kind"]>([
	"RETRY_SAME",
	"CORRECTIVE_RETRY_SAME",
	"RESUME_SAME",
	"FRESH_SESSION_SAME",
]);

function modeForAction(kind: Action["kind"]): AttemptMode {
	if (kind === "CORRECTIVE_RETRY_SAME") return "CORRECTIVE";
	// A continuation is a resume by definition: the next session must pick up the
	// durable decisions rather than re-read a day it has already half-scanned.
	if (kind === "RESUME_SAME" || kind === "CONTINUE_SAME") return "RESUME";
	return "FRESH";
}

/**
 * Stage-level bound on continuations.
 *
 * This exists so a model that yields without ever finishing cannot loop
 * forever. It is deliberately not the provider failure counter: exhausting it
 * means "this stage took too long", not "these models are broken", so it ends
 * the stage rather than falling through the chain trying the same oversized
 * workload on every model in turn.
 */
export interface ContinuationBounds {
	/** Hard cap on continuations for the whole stage, across all models. */
	maxContinuations: number;
	/** Wall-clock ceiling for the whole stage, measured from the first attempt. */
	maxStageWallClockMs: number;
}

export const DEFAULT_CONTINUATION_BOUNDS: ContinuationBounds = {
	/*
	 * A runaway guard, not a budget, so it has to stay clear of the largest
	 * manifest the pipeline can build -- and it scales with the work unit rather
	 * than standing on its own. At the shipped 50-decision unit, 80 continuations
	 * is 4000 items, twice the 2000-item manifest cap.
	 *
	 * It was 40, sized when the unit was 100. Halving the unit to 50 left 40 x 50
	 * = exactly 2000: the ceiling would have bound at precisely the cap, and any
	 * turn that decided fewer than its full budget -- which happens, one turn on
	 * 2026-09-16 committed 50 against a budget of 100 -- would have pushed a
	 * full-sized manifest past it and failed the stage for being large rather than
	 * for being stuck. Keep `maxContinuations * maxDecisionsPerTurn >= 2 x the
	 * manifest cap` whenever either is retuned; a test pins it.
	 */
	maxContinuations: 80,
	/* Comfortably past the ~41 minutes the 1626-item backlog needed. */
	maxStageWallClockMs: 90 * 60 * 1000,
};

/**
 * Wall-clock cost of one decision, to 2dp. Measured, not estimated: both
 * operands come from the clock and from durable decision counts.
 */
function secondsPerDecision(durationMs: number, decided: number): number | null {
	if (decided <= 0) return null;
	return Math.round((durationMs / decided / 1000) * 100) / 100;
}

/** Thrown when a stage keeps yielding past its ceiling. Distinct from any model failure. */
export class ContinuationLimitError extends Error {
	override name = "ContinuationLimitError";
	constructor(stage: string, reason: string) {
		super(`${stage} stopped after exceeding its continuation ceiling: ${reason}`);
	}
}

export type RunStageOptions<T> = {
	stage: Stage;
	chain: readonly ModelSpec[];
	routerState: RouterState;
	onAttempt: (ctx: {
		spec: ModelSpec;
		attemptIndex: number;
		mode: AttemptMode;
		/**
		 * Why the previous attempt failed, sanitized the same way the persisted
		 * attempt record is. Undefined on the first attempt against the stage.
		 *
		 * `CORRECTIVE_RETRY_SAME` exists to hand a model its own rejection and
		 * ask it to fix it, and both stages already accept a `lastError` for
		 * exactly that — but the router never told the caller what the error was,
		 * so the corrective prompt was never built and a CORRECTIVE attempt was
		 * indistinguishable from a plain retry.
		 */
		lastError?: string;
		/**
		 * Test-only fault injection checkpoint. The stage callback reports its own
		 * progress (items decided, tool calls made, ...) at whatever points make
		 * sense for it; this throws a classifier-real synthetic error, at most once
		 * per run, if the active `DAILY_INTELLIGENCE_FAULT_INJECTION` spec matches
		 * the current stage/model and that threshold. A no-op when fault injection
		 * is off, which is the default.
		 */
		checkFault: (processedItems: number) => void;
		/**
		 * Hands the attempt's provider-reported token usage to the router, so it
		 * lands on the attempt record whether the attempt succeeded, yielded or
		 * failed. Called by the stage from its driver's `getUsage()` before the
		 * driver is disposed; a stage whose driver reports nothing never calls it.
		 */
		reportUsage: (usage: TokenUsage) => void;
	}) => Promise<T>;
	recordAttempt: (attempt: AgentAttempt) => void;
	now?: () => Date;
	/**
	 * Hard ceiling on attempts against a single model. CONTEXT_OVERFLOW asks to
	 * stay on the same model forever; this keeps that from becoming a hang.
	 */
	maxAttemptsPerModel?: number;
	/** Stage-level runaway guard for progress yields. See {@link ContinuationBounds}. */
	continuationBounds?: Partial<ContinuationBounds>;
	/**
	 * Called once per continuation, before the next session starts. Production
	 * uses it to log per-turn throughput, which is the only way to tell a healthy
	 * bounded run from one that is yielding without getting anywhere.
	 */
	onContinue?: (info: {
		spec: ModelSpec;
		continuation: number;
		decidedThisTurn: number;
		decidedAfter: number;
		totalItems: number;
		reason: string;
		/** Which bound closed the work unit, when one did. See ProgressYieldInfo. */
		closedBy?: "COUNT" | "TIME";
		durationMs: number;
		/** Measured, not estimated. Null when the turn decided nothing. */
		secondsPerDecision: number | null;
		/** Provider-reported usage for the turn's session, when the driver reported it. */
		tokenUsage?: TokenUsage;
	}) => void;
	/** Test-only; defaults to reading `DAILY_INTELLIGENCE_FAULT_INJECTION` from the environment. */
	faultInjector?: FaultInjector;
};

/**
 * Walk the model chain applying {@link decideAction}, recording one
 * {@link AgentAttempt} per attempt. Deliberately free of any Pi SDK import so
 * the whole policy is unit-testable against a fake `onAttempt`.
 */
export async function runStageWithFallback<T>(opts: RunStageOptions<T>): Promise<T> {
	const { stage, chain, routerState, onAttempt, recordAttempt } = opts;
	const now = opts.now ?? (() => new Date());
	const maxAttemptsPerModel = opts.maxAttemptsPerModel ?? 4;
	const faultInjector = opts.faultInjector ?? FaultInjector.fromEnv();

	const bounds = { ...DEFAULT_CONTINUATION_BOUNDS, ...opts.continuationBounds };
	const stageStartedAt = now().getTime();
	let continuations = 0;

	let attemptIndex = 0;
	let lastError: unknown;
	// The sanitized message, carried into the next attempt's context. Kept
	// separately from `lastError`, which stays the raw error so the stage that
	// finally gives up rethrows what actually happened.
	let lastErrorMessage: string | undefined;
	let sawCandidate = false;

	for (let i = 0; i < chain.length; i++) {
		const spec = chain[i];
		if (!spec) continue;
		if (routerState.isProviderDegraded(spec.provider)) continue;
		sawCandidate = true;

		let sameModelAttempts = 0;
		let mode: AttemptMode = "FRESH";

		for (;;) {
			sameModelAttempts++;
			const startedAt = now();
			const base = {
				attemptId: randomUUID(),
				stage,
				provider: spec.provider,
				model: spec.model,
				startedAt: startedAt.toISOString(),
			};

			let usage: TokenUsage | undefined;
			const reportUsage = (u: TokenUsage) => {
				usage = u;
			};
			const withUsage = () => (usage === undefined ? {} : { tokenUsage: usage });
			try {
				const chainIndex = i;
				const checkFault = (processedItems: number) => {
					const err = faultInjector.check({ stage, spec, chainIndex, processedItems });
					if (err) throw err;
				};
				const result = await onAttempt({
					spec,
					attemptIndex,
					mode,
					checkFault,
					reportUsage,
					...(lastErrorMessage === undefined ? {} : { lastError: lastErrorMessage }),
				});
				const finishedAt = now();
				recordAttempt({
					...base,
					finishedAt: finishedAt.toISOString(),
					durationMs: finishedAt.getTime() - startedAt.getTime(),
					status: "SUCCESS",
					...withUsage(),
				});
				return result;
			} catch (err) {
				/*
				 * Terminal, before anything else is considered. The previous turn is
				 * still running, so every available response -- retry, continue, fall
				 * back -- would start a second session writing the same day's durable
				 * state. Failing the stage is the only answer that does not.
				 *
				 * Note this outranks the progress yield below: a turn that made
				 * progress and then would not stop is still a runtime failure. "It was
				 * working" is not a reason to run two of it.
				 */
				if (isTurnAbandoned(err)) {
					const finishedAt = now();
					const { failureClass, errorMeta } = classifyError(err);
					recordAttempt({
						...base,
						finishedAt: finishedAt.toISOString(),
						durationMs: finishedAt.getTime() - startedAt.getTime(),
						status: "FAILED",
						failureClass,
						errorMeta: { ...errorMeta, terminal: "session did not stop; no replacement started" },
						...withUsage(),
					});
					throw err;
				}

				/*
				 * Handled before classifyError ever sees it. A progress yield is not a
				 * provider error and must not be routed like one: it consumes no
				 * same-model attempt, records no failureClass, and never sets
				 * fallbackReason. Matching on the class rather than on the message is
				 * what keeps a real provider error that happens to say "yield" from
				 * taking this branch.
				 */
				if (isProgressYield(err)) {
					const finishedAt = now();
					const durationMs = finishedAt.getTime() - startedAt.getTime();
					continuations++;

					recordAttempt({
						...base,
						finishedAt: finishedAt.toISOString(),
						durationMs,
						status: "YIELDED",
						errorMeta: {
							reason: err.info.reason,
							decidedThisTurn: err.decidedThisTurn,
							decidedAfter: err.info.decidedAfter,
							totalItems: err.info.totalItems,
							secondsPerDecision: secondsPerDecision(durationMs, err.decidedThisTurn),
						},
						// Provider-reported, via the driver's assistant-message usage; see
						// runtime/agent-driver.ts. Absent when the driver reported nothing.
						...withUsage(),
					});
					opts.onContinue?.({
						spec,
						continuation: continuations,
						decidedThisTurn: err.decidedThisTurn,
						decidedAfter: err.info.decidedAfter,
						totalItems: err.info.totalItems,
						reason: err.info.reason,
						...(err.info.closedBy ? { closedBy: err.info.closedBy } : {}),
						durationMs,
						secondsPerDecision: secondsPerDecision(durationMs, err.decidedThisTurn),
						...withUsage(),
					});

					// The ceiling ends the stage rather than falling through the chain:
					// the same oversized workload would yield on every other model too,
					// so trying them would burn the chain to learn nothing.
					const elapsed = finishedAt.getTime() - stageStartedAt;
					if (continuations >= bounds.maxContinuations) {
						throw new ContinuationLimitError(
							stage,
							`${continuations} continuations (limit ${bounds.maxContinuations}), ` +
								`${err.info.decidedAfter}/${err.info.totalItems} items decided`,
						);
					}
					if (elapsed >= bounds.maxStageWallClockMs) {
						throw new ContinuationLimitError(
							stage,
							`${Math.round(elapsed / 1000)}s elapsed (limit ${Math.round(bounds.maxStageWallClockMs / 1000)}s), ` +
								`${err.info.decidedAfter}/${err.info.totalItems} items decided`,
						);
					}

					// Same model, fresh session, resumed from durable state. Note that
					// `sameModelAttempts` is decremented back out: the increment at the
					// top of the loop counts attempts against the retry budget, and a
					// continuation is not one.
					sameModelAttempts--;
					mode = modeForAction("CONTINUE_SAME");
					continue;
				}

				lastError = err;
				const { failureClass, errorMeta } = classifyError(err);
				const metaMessage = errorMeta["message"];
				lastErrorMessage =
					typeof metaMessage === "string" && metaMessage.length > 0 ? metaMessage : undefined;
				const action = decideAction(failureClass, sameModelAttempts);

				if (failureClass === "AUTH") {
					routerState.markProviderDegraded(spec.provider, "AUTH");
				}

				let effective = action;
				if (SAME_MODEL_ACTIONS.has(action.kind) && sameModelAttempts >= maxAttemptsPerModel) {
					effective = { kind: "FALLBACK" };
				}

				const finishedAt = now();
				const faultInjected = getFaultInjectionRecord(err);
				recordAttempt({
					...base,
					finishedAt: finishedAt.toISOString(),
					durationMs: finishedAt.getTime() - startedAt.getTime(),
					status: "FAILED",
					failureClass,
					/*
					 * Only a real fallback sets this. It used to be filled in on both
					 * branches, and every consumer tests it for truthiness to count
					 * fallbacks — so one RETRY_SAME after a transient blip reported a
					 * cross-model fallback that never happened and inflated
					 * `fallbackCount` in src/cli/benchmark.ts for every model compared.
					 * The same-model wording moved to `errorMeta.retryReason`, where the
					 * attempt record still explains itself without lying to the counter.
					 */
					...(effective.kind === "FALLBACK"
						? { fallbackReason: `${modelKey(spec)} failed with ${failureClass}; falling back` }
						: {}),
					errorMeta:
						effective.kind === "FALLBACK"
							? errorMeta
							: {
									...errorMeta,
									retryReason: `${modelKey(spec)} failed with ${failureClass}; ${effective.kind}`,
								},
					...(faultInjected ? { faultInjected } : {}),
					...withUsage(),
				});

				attemptIndex++;

				if (effective.kind === "FAIL") throw err;
				if (effective.kind === "FALLBACK") break;
				mode = modeForAction(effective.kind);
			}
		}
	}

	if (!sawCandidate) {
		throw new Error(
			`No usable model for stage ${stage}: every provider in the chain is degraded (${routerState.degradedProviders().join(", ")})`,
		);
	}
	throw lastError;
}
