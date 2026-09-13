import { randomUUID } from "node:crypto";
import type { AgentAttempt, FailureClass, Stage } from "../schemas/run.ts";
import { classifyError } from "./error-classifier.ts";
import { FaultInjector, getFaultInjectionRecord } from "./fault-injection.ts";
import { type ModelSpec, modelKey } from "./model-config.ts";

/** What the router wants the driver to do after a failed attempt. */
export type Action =
	| { kind: "RETRY_SAME" }
	| { kind: "CORRECTIVE_RETRY_SAME" }
	| { kind: "RESUME_SAME" }
	| { kind: "FRESH_SESSION_SAME" }
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
	if (kind === "RESUME_SAME") return "RESUME";
	return "FRESH";
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
		 * Test-only fault injection checkpoint. The stage callback reports its own
		 * progress (items decided, tool calls made, ...) at whatever points make
		 * sense for it; this throws a classifier-real synthetic error, at most once
		 * per run, if the active `DAILY_INTELLIGENCE_FAULT_INJECTION` spec matches
		 * the current stage/model and that threshold. A no-op when fault injection
		 * is off, which is the default.
		 */
		checkFault: (processedItems: number) => void;
	}) => Promise<T>;
	recordAttempt: (attempt: AgentAttempt) => void;
	now?: () => Date;
	/**
	 * Hard ceiling on attempts against a single model. CONTEXT_OVERFLOW asks to
	 * stay on the same model forever; this keeps that from becoming a hang.
	 */
	maxAttemptsPerModel?: number;
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

	let attemptIndex = 0;
	let lastError: unknown;
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

			try {
				const chainIndex = i;
				const checkFault = (processedItems: number) => {
					const err = faultInjector.check({ stage, spec, chainIndex, processedItems });
					if (err) throw err;
				};
				const result = await onAttempt({ spec, attemptIndex, mode, checkFault });
				const finishedAt = now();
				recordAttempt({
					...base,
					finishedAt: finishedAt.toISOString(),
					durationMs: finishedAt.getTime() - startedAt.getTime(),
					status: "SUCCESS",
				});
				return result;
			} catch (err) {
				lastError = err;
				const { failureClass, errorMeta } = classifyError(err);
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
					fallbackReason:
						effective.kind === "FALLBACK"
							? `${modelKey(spec)} failed with ${failureClass}; falling back`
							: `${modelKey(spec)} failed with ${failureClass}; ${effective.kind}`,
					errorMeta,
					...(faultInjected ? { faultInjected } : {}),
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
