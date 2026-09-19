import {
	InvalidAgentOutputError,
	ModelSilentError,
	ToolLoopError,
} from "./error-classifier.ts";
import { isProgressYield } from "./progress-yield.ts";
import type { TokenUsage } from "../schemas/run.ts";

/*
 * Telling "the model did badly" apart from "the provider ran nothing".
 *
 * Both end a stage without a result, and until now both were reported as the
 * model's fault. The difference is visible in one number: an attempt where the
 * provider reports zero tokens never ran. A model that read the prompt and
 * produced a useless answer still bills for the prompt.
 */

/** True when the provider answered at all, on any turn of this attempt. */
export function providerSpoke(usage: TokenUsage | undefined): boolean {
	if (!usage) return true; // No telemetry is not evidence of silence.
	return usage.totalTokens > 0 || usage.input > 0 || usage.output > 0;
}

/*
 * Only these two are ever re-labelled.
 *
 * They are the two failures that mean "the session ended without the model
 * producing what it was asked for", and they are the only two that a provider
 * returning nothing is indistinguishable from. Every other class -- NETWORK,
 * TIMEOUT, RATE_LIMIT, AUTH, SERVER_ERROR -- already names a real cause that
 * the error itself carried, and several of them also report zero tokens because
 * the request never completed. Re-labelling those would turn a transient blip
 * on the first turn into an immediate fallback, losing the one cheap retry the
 * router exists to give it.
 */
function isAgentOutputFailure(err: unknown): boolean {
	return err instanceof InvalidAgentOutputError || err instanceof ToolLoopError;
}

/**
 * Re-labels a stage failure that happened while the provider said nothing.
 *
 * A progress yield is never re-labelled: it is not a failure, and a yield that
 * committed decisions self-evidently ran. Anything else is passed through
 * unchanged when the provider did speak, so a genuinely bad answer keeps the
 * class that describes it.
 */
export function asSilentProviderFailure(
	err: unknown,
	usage: TokenUsage | undefined,
	spec: { provider: string; model: string },
): unknown {
	if (isProgressYield(err)) return err;
	if (!isAgentOutputFailure(err)) return err;
	if (providerSpoke(usage)) return err;
	return new ModelSilentError(
		`${spec.provider}/${spec.model} returned no tokens at all across this attempt ` +
			`(provider-reported usage was zero), so it never ran. Treating it as unavailable ` +
			`rather than as a bad answer. Original: ${err instanceof Error ? err.message : String(err)}`,
		{ cause: err },
	);
}
