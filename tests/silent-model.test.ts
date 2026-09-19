import { describe, expect, it } from "vitest";
import { asSilentProviderFailure, providerSpoke } from "../src/runtime/silent-model.ts";
import { classifyError, InvalidAgentOutputError, ToolLoopError } from "../src/runtime/error-classifier.ts";
import { decideAction } from "../src/runtime/model-router.ts";
import { ProgressYieldError } from "../src/runtime/progress-yield.ts";
import { renderModelChain } from "../src/observation/render.ts";
import type { ModelChainRow } from "../src/observation/queries.ts";
import type { TokenUsage } from "../src/schemas/run.ts";

/*
 * The failure this exists for, from the production record.
 *
 * From 2026-09-17 every model under the `github-copilot` provider began
 * returning empty completions in this Pi installation: no text, no tool call,
 * no error, zero reported tokens — while `pi auth check` still reported ready
 * and a plain chat without custom tools still answered. Reproduced on
 * gemini-3.8-flash, claude-haiku-4.5 and gpt-5.6-terra with a single tool
 * registered; `opencode-go` and `openai-codex` were unaffected.
 *
 * The chain absorbed it as an ordinary fallback. The curator recorded
 * TOOL_LOOP, the editor INVALID_AGENT_OUTPUT — both meaning "the model answered
 * badly", both earning a retry — and three days of production ran entirely on
 * the expensive model with nothing saying the cheap one had stopped existing.
 */

const SPEC = { provider: "github-copilot", model: "gemini-3.8-flash" };
const silent: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reportedBy: 1 };
const spoke: TokenUsage = { input: 427, output: 23, cacheRead: 0, cacheWrite: 0, totalTokens: 450, reportedBy: 2 };

describe("providerSpoke", () => {
	it("is false only when every counter is zero", () => {
		expect(providerSpoke(silent)).toBe(false);
		expect(providerSpoke(spoke)).toBe(true);
		expect(providerSpoke({ ...silent, input: 1 })).toBe(true);
	});

	it("treats missing telemetry as having spoken, never as silence", () => {
		// Absence of evidence must not become evidence: a provider that does not
		// report usage would otherwise be declared dead on its first bad answer.
		expect(providerSpoke(undefined)).toBe(true);
	});
});

describe("a silent provider is not a bad model", () => {
	it("relabels a curator tool loop that burned no tokens", () => {
		const err = asSilentProviderFailure(new ToolLoopError("no progress across 3 turns at 0/584"), silent, SPEC);
		expect(classifyError(err).failureClass).toBe("MODEL_UNAVAILABLE");
	});

	it("relabels an editor submission failure that burned no tokens", () => {
		const err = asSilentProviderFailure(new InvalidAgentOutputError("never called submit_brief"), silent, SPEC);
		expect(classifyError(err).failureClass).toBe("MODEL_UNAVAILABLE");
	});

	it("names the provider and model, because that is the thing to go and fix", () => {
		const err = asSilentProviderFailure(new ToolLoopError("x"), silent, SPEC) as Error;
		expect(err.message).toContain("github-copilot/gemini-3.8-flash");
		expect(err.message).toContain("never ran");
	});

	it("leaves a genuine bad answer alone", () => {
		const original = new ToolLoopError("no progress across 3 turns");
		expect(asSilentProviderFailure(original, spoke, SPEC)).toBe(original);
		expect(classifyError(original).failureClass).toBe("TOOL_LOOP");
	});

	it("never relabels a progress yield, which is not a failure", () => {
		const yielded = new ProgressYieldError({
			decidedBefore: 0,
			decidedAfter: 50,
			totalItems: 584,
			reason: "WORK_UNIT_COMPLETE",
		});
		expect(asSilentProviderFailure(yielded, silent, SPEC)).toBe(yielded);
	});

	it("keeps the original error as the cause, so the trace still says what broke", () => {
		const original = new ToolLoopError("no progress across 3 turns");
		const err = asSilentProviderFailure(original, silent, SPEC) as Error;
		expect(err.cause).toBe(original);
	});
});

describe("the router falls back at once instead of nudging a dead provider", () => {
	it("moves on from the first silent attempt rather than retrying", () => {
		expect(decideAction("MODEL_UNAVAILABLE", 1)).toEqual({ kind: "FALLBACK" });
		// What it used to do with the same real failure:
		expect(decideAction("TOOL_LOOP", 1)).toEqual({ kind: "RESUME_SAME" });
		expect(decideAction("INVALID_AGENT_OUTPUT", 1)).toEqual({ kind: "CORRECTIVE_RETRY_SAME" });
	});
});

describe("the observation report makes a dead provider impossible to miss", () => {
	const row = (over: Partial<ModelChainRow>): ModelChainRow => ({
		stage: "CURATOR",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		attempts: 12,
		succeeded: 1,
		yielded: 11,
		failed: 0,
		silent: 0,
		totalTokens: 3_148_478,
		...over,
	});

	it("calls out a model whose every attempt was silent", () => {
		const text = renderModelChain([
			row({}),
			row({ provider: "github-copilot", model: "gemini-3.8-flash", attempts: 2, succeeded: 0, yielded: 0, failed: 2, silent: 2, totalTokens: 0 }),
		]);
		expect(text).toContain("github-copilot/gemini-3.8-flash answered nothing");
		expect(text).toContain("never ran");
	});

	it("says nothing alarming about a model that failed while answering", () => {
		const text = renderModelChain([row({ failed: 2, silent: 0 })]);
		expect(text).not.toContain("answered nothing");
	});

	it("still reports the models that did the work", () => {
		const text = renderModelChain([row({})]);
		expect(text).toContain("3,148,478");
	});
});

describe("a real cause is never overwritten by silence", () => {
	/*
	 * Several genuine provider failures also report zero tokens, because the
	 * request never completed. Only the two classes that mean "the session ended
	 * without the model producing what it was asked for" are ambiguous with a
	 * provider that ran nothing; re-labelling the rest would turn a transient
	 * blip on the first turn into an immediate fallback and throw away the one
	 * cheap retry the router exists to give it.
	 */
	it("leaves a network error alone even with no tokens reported", () => {
		const err = Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
		expect(asSilentProviderFailure(err, silent, SPEC)).toBe(err);
		expect(classifyError(err).failureClass).toBe("NETWORK");
		expect(decideAction("NETWORK", 1)).toEqual({ kind: "RETRY_SAME" });
	});

	it("leaves a rate limit alone even with no tokens reported", () => {
		const err = Object.assign(new Error("too many requests"), { status: 429 });
		expect(asSilentProviderFailure(err, silent, SPEC)).toBe(err);
		expect(classifyError(err).failureClass).toBe("RATE_LIMIT");
	});
});
