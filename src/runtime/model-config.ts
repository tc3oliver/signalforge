/**
 * The default model chain. Order is the fallback order: the first entry is
 * tried first, and each subsequent entry is a strictly cheaper/last-resort
 * option.
 *
 * This is a default, not a fixed list. The daily CLI passes the chain from
 * `config/agent.yaml`, which is where an operator changes providers; this
 * constant is what the pipeline falls back to when no chain is supplied, and
 * what tests pin against. The two are held in agreement by
 * `tests/model-chain-config.test.ts`.
 *
 * The providers named here are the ones available on the machine this was
 * built on. They are not a requirement: any provider the installed Pi agent
 * can authenticate as will do.
 */

export type ModelSpec = {
	provider: string;
	model: string;
};

export const MODEL_CHAIN: readonly ModelSpec[] = Object.freeze([
	Object.freeze({ provider: "github-copilot", model: "gemini-3.8-flash" }),
	Object.freeze({ provider: "openai-codex", model: "gpt-5.6-sol" }),
	Object.freeze({ provider: "opencode-go", model: "deepseek-v4.1-flash" }),
]) as readonly ModelSpec[];

/** Stable identity for a spec, used as a map key and in logs. */
export function modelKey(spec: ModelSpec): string {
	return `${spec.provider}/${spec.model}`;
}

/**
 * Inverse of {@link modelKey}. Only the first "/" separates provider from model,
 * because model ids may themselves contain slashes.
 */
export function parseModelKey(key: string): ModelSpec {
	const slash = key.indexOf("/");
	if (slash <= 0 || slash === key.length - 1) {
		throw new Error(`Invalid model key: ${JSON.stringify(key)}`);
	}
	return { provider: key.slice(0, slash), model: key.slice(slash + 1) };
}
