import { ModelSilentError } from "./error-classifier.ts";
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
	if (providerSpoke(usage)) return err;
	return new ModelSilentError(
		`${spec.provider}/${spec.model} returned no tokens at all across this attempt ` +
			`(provider-reported usage was zero), so it never ran. Treating it as unavailable ` +
			`rather than as a bad answer. Original: ${err instanceof Error ? err.message : String(err)}`,
		{ cause: err },
	);
}
