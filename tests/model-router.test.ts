import { describe, expect, it } from "vitest";
import type { AgentAttempt, FailureClass } from "../src/schemas/run.ts";
import { AgentAttempt as AgentAttemptSchema } from "../src/schemas/run.ts";
import { MODEL_CHAIN, modelKey, parseModelKey } from "../src/runtime/model-config.ts";
import { ProgrammerError, ToolLoopError, InvalidAgentOutputError } from "../src/runtime/error-classifier.ts";
import { RouterState, decideAction, runStageWithFallback } from "../src/runtime/model-router.ts";

const [GEMINI, GPT, DEEPSEEK] = MODEL_CHAIN as readonly [
	(typeof MODEL_CHAIN)[number],
	(typeof MODEL_CHAIN)[number],
	(typeof MODEL_CHAIN)[number],
];

function httpError(message: string, status: number): Error {
	return Object.assign(new Error(message), { status });
}

/** A clock that advances 10ms per read, so durationMs is deterministic. */
function fakeClock(): () => Date {
	let t = Date.UTC(2026, 8, 13, 12, 0, 0);
	return () => {
		const d = new Date(t);
		t += 10;
		return d;
	};
}

describe("model-config", () => {
	it("is the verified three-model chain in priority order", () => {
		expect(MODEL_CHAIN.map(modelKey)).toEqual([
			"github-copilot/gemini-3.8-flash",
			"openai-codex/gpt-5.6-sol",
			"opencode-go/deepseek-v4.1-flash",
		]);
	});

	it("round-trips through modelKey/parseModelKey", () => {
		for (const spec of MODEL_CHAIN) {
			expect(parseModelKey(modelKey(spec))).toEqual({ provider: spec.provider, model: spec.model });
		}
	});

	it("splits only on the first slash so model ids may contain slashes", () => {
		expect(parseModelKey("openrouter/meta/llama-3")).toEqual({ provider: "openrouter", model: "meta/llama-3" });
	});

	it("rejects malformed keys", () => {
		expect(() => parseModelKey("nokey")).toThrow();
		expect(() => parseModelKey("/leading")).toThrow();
		expect(() => parseModelKey("trailing/")).toThrow();
	});
});

describe("decideAction — policy table", () => {
	const transient: FailureClass[] = ["NETWORK", "TIMEOUT", "RATE_LIMIT", "SERVER_ERROR"];
	it.each(transient)("%s retries once then falls back", (fc) => {
		expect(decideAction(fc, 1)).toEqual({ kind: "RETRY_SAME" });
		expect(decideAction(fc, 2)).toEqual({ kind: "FALLBACK" });
		expect(decideAction(fc, 3)).toEqual({ kind: "FALLBACK" });
	});

	const terminalForModel: FailureClass[] = ["QUOTA", "BILLING", "MODEL_UNAVAILABLE", "AUTH"];
	it.each(terminalForModel)("%s always falls back immediately", (fc) => {
		expect(decideAction(fc, 1)).toEqual({ kind: "FALLBACK" });
		expect(decideAction(fc, 2)).toEqual({ kind: "FALLBACK" });
	});

	it("INVALID_AGENT_OUTPUT gets one corrective retry", () => {
		expect(decideAction("INVALID_AGENT_OUTPUT", 1)).toEqual({ kind: "CORRECTIVE_RETRY_SAME" });
		expect(decideAction("INVALID_AGENT_OUTPUT", 2)).toEqual({ kind: "FALLBACK" });
	});

	it("TOOL_LOOP gets one resume", () => {
		expect(decideAction("TOOL_LOOP", 1)).toEqual({ kind: "RESUME_SAME" });
		expect(decideAction("TOOL_LOOP", 2)).toEqual({ kind: "FALLBACK" });
	});

	it("CONTEXT_OVERFLOW never switches model automatically", () => {
		for (const n of [1, 2, 5, 50]) {
			expect(decideAction("CONTEXT_OVERFLOW", n)).toEqual({ kind: "FRESH_SESSION_SAME" });
		}
	});

	it.each(["PROGRAMMER_ERROR", "USER_ABORT"] as FailureClass[])("%s fails outright", (fc) => {
		expect(decideAction(fc, 1)).toEqual({ kind: "FAIL" });
		expect(decideAction(fc, 9)).toEqual({ kind: "FAIL" });
	});

	it("UNKNOWN retries once then falls back", () => {
		expect(decideAction("UNKNOWN", 1)).toEqual({ kind: "RETRY_SAME" });
		expect(decideAction("UNKNOWN", 2)).toEqual({ kind: "FALLBACK" });
	});
});

describe("RouterState", () => {
	it("marks and reports degraded providers", () => {
		const s = new RouterState();
		expect(s.isProviderDegraded("github-copilot")).toBe(false);
		s.markProviderDegraded("github-copilot", "AUTH");
		expect(s.isProviderDegraded("github-copilot")).toBe(true);
		expect(s.degradedReason("github-copilot")).toBe("AUTH");
		expect(s.degradedProviders()).toEqual(["github-copilot"]);
	});
});

describe("runStageWithFallback", () => {
	it("returns the first model's result and records one SUCCESS attempt", async () => {
		const attempts: AgentAttempt[] = [];
		const result = await runStageWithFallback<string>({
			stage: "CURATOR",
			chain: MODEL_CHAIN,
			routerState: new RouterState(),
			onAttempt: async () => "materials",
			recordAttempt: (a) => attempts.push(a),
			now: fakeClock(),
		});

		expect(result).toBe("materials");
		expect(attempts).toHaveLength(1);
		expect(attempts[0]).toMatchObject({
			stage: "CURATOR",
			provider: GEMINI.provider,
			model: GEMINI.model,
			status: "SUCCESS",
			durationMs: 10,
		});
		expect(attempts[0]?.failureClass).toBeUndefined();
		for (const a of attempts) expect(() => AgentAttemptSchema.parse(a)).not.toThrow();
	});

	it("falls back from Gemini QUOTA to GPT and records both attempts", async () => {
		const attempts: AgentAttempt[] = [];
		const seen: string[] = [];

		const result = await runStageWithFallback<string>({
			stage: "EDITOR",
			chain: MODEL_CHAIN,
			routerState: new RouterState(),
			onAttempt: async ({ spec }) => {
				seen.push(modelKey(spec));
				if (spec.provider === GEMINI.provider) {
					throw httpError("You exceeded your current quota", 429);
				}
				return `draft from ${spec.model}`;
			},
			recordAttempt: (a) => attempts.push(a),
			now: fakeClock(),
		});

		expect(result).toBe(`draft from ${GPT.model}`);
		expect(seen).toEqual([modelKey(GEMINI), modelKey(GPT)]);
		expect(attempts).toHaveLength(2);

		expect(attempts[0]).toMatchObject({
			stage: "EDITOR",
			provider: GEMINI.provider,
			model: GEMINI.model,
			status: "FAILED",
			failureClass: "QUOTA",
		});
		expect(attempts[0]?.fallbackReason).toContain("QUOTA");
		expect(attempts[0]?.errorMeta).toMatchObject({ status: 429 });

		expect(attempts[1]).toMatchObject({ provider: GPT.provider, model: GPT.model, status: "SUCCESS" });
		for (const a of attempts) expect(() => AgentAttemptSchema.parse(a)).not.toThrow();
	});

	it("retries the same model once on a transient failure before falling back", async () => {
		const attempts: AgentAttempt[] = [];
		const seen: Array<{ key: string; mode: string }> = [];

		await runStageWithFallback<string>({
			stage: "CURATOR",
			chain: MODEL_CHAIN,
			routerState: new RouterState(),
			onAttempt: async ({ spec, mode }) => {
				seen.push({ key: modelKey(spec), mode });
				if (spec.provider === GEMINI.provider) throw httpError("upstream exploded", 503);
				return "ok";
			},
			recordAttempt: (a) => attempts.push(a),
			now: fakeClock(),
		});

		expect(seen).toEqual([
			{ key: modelKey(GEMINI), mode: "FRESH" },
			{ key: modelKey(GEMINI), mode: "FRESH" },
			{ key: modelKey(GPT), mode: "FRESH" },
		]);
		expect(attempts.map((a) => a.status)).toEqual(["FAILED", "FAILED", "SUCCESS"]);
		expect(attempts.slice(0, 2).every((a) => a.failureClass === "SERVER_ERROR")).toBe(true);
	});

	it("passes mode CORRECTIVE on the retry after INVALID_AGENT_OUTPUT", async () => {
		const modes: string[] = [];
		const result = await runStageWithFallback<string>({
			stage: "EDITOR",
			chain: MODEL_CHAIN,
			routerState: new RouterState(),
			onAttempt: async ({ mode }) => {
				modes.push(mode);
				if (modes.length === 1) throw new InvalidAgentOutputError("missing storyId");
				return "fixed";
			},
			recordAttempt: () => {},
			now: fakeClock(),
		});
		expect(result).toBe("fixed");
		expect(modes).toEqual(["FRESH", "CORRECTIVE"]);
	});

	it("passes mode RESUME on the retry after TOOL_LOOP", async () => {
		const modes: string[] = [];
		await runStageWithFallback<string>({
			stage: "EDITOR",
			chain: MODEL_CHAIN,
			routerState: new RouterState(),
			onAttempt: async ({ mode }) => {
				modes.push(mode);
				if (modes.length === 1) throw new ToolLoopError("tool thrash");
				return "done";
			},
			recordAttempt: () => {},
			now: fakeClock(),
		});
		expect(modes).toEqual(["FRESH", "RESUME"]);
	});

	it("stays on the same model for CONTEXT_OVERFLOW, bounded by maxAttemptsPerModel", async () => {
		const seen: string[] = [];
		const attempts: AgentAttempt[] = [];

		await runStageWithFallback<string>({
			stage: "EDITOR",
			chain: MODEL_CHAIN,
			routerState: new RouterState(),
			onAttempt: async ({ spec }) => {
				seen.push(modelKey(spec));
				if (spec.provider === GEMINI.provider) throw new Error("maximum context length exceeded");
				return "ok";
			},
			recordAttempt: (a) => attempts.push(a),
			now: fakeClock(),
			maxAttemptsPerModel: 3,
		});

		// Three tries on Gemini (never switching model on its own), then the cap.
		expect(seen).toEqual([modelKey(GEMINI), modelKey(GEMINI), modelKey(GEMINI), modelKey(GPT)]);
		expect(attempts.slice(0, 3).every((a) => a.failureClass === "CONTEXT_OVERFLOW")).toBe(true);
		expect(attempts[2]?.fallbackReason).toContain("falling back");
	});

	it("degrades a provider on AUTH and skips it for the rest of the run", async () => {
		const routerState = new RouterState();
		const attempts: AgentAttempt[] = [];
		const seen: string[] = [];

		const onAttempt = async ({ spec }: { spec: { provider: string; model: string } }) => {
			seen.push(modelKey(spec));
			if (spec.provider === GEMINI.provider) throw httpError("Unauthorized", 401);
			return "ok";
		};

		await runStageWithFallback<string>({
			stage: "CURATOR",
			chain: MODEL_CHAIN,
			routerState,
			onAttempt,
			recordAttempt: (a) => attempts.push(a),
			now: fakeClock(),
		});
		expect(routerState.isProviderDegraded(GEMINI.provider)).toBe(true);
		expect(seen).toEqual([modelKey(GEMINI), modelKey(GPT)]);

		// Second stage in the same run: Gemini is never called again.
		seen.length = 0;
		await runStageWithFallback<string>({
			stage: "EDITOR",
			chain: MODEL_CHAIN,
			routerState,
			onAttempt,
			recordAttempt: (a) => attempts.push(a),
			now: fakeClock(),
		});
		expect(seen).toEqual([modelKey(GPT)]);
	});

	it("fails immediately on PROGRAMMER_ERROR without falling back", async () => {
		const attempts: AgentAttempt[] = [];
		const seen: string[] = [];
		const boom = new ProgrammerError("unreachable branch");

		await expect(
			runStageWithFallback<string>({
				stage: "CURATOR",
				chain: MODEL_CHAIN,
				routerState: new RouterState(),
				onAttempt: async ({ spec }) => {
					seen.push(modelKey(spec));
					throw boom;
				},
				recordAttempt: (a) => attempts.push(a),
				now: fakeClock(),
			}),
		).rejects.toBe(boom);

		expect(seen).toEqual([modelKey(GEMINI)]);
		expect(attempts).toHaveLength(1);
		expect(attempts[0]).toMatchObject({ status: "FAILED", failureClass: "PROGRAMMER_ERROR" });
	});

	it("fails immediately on USER_ABORT", async () => {
		const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
		const seen: string[] = [];
		await expect(
			runStageWithFallback<string>({
				stage: "EDITOR",
				chain: MODEL_CHAIN,
				routerState: new RouterState(),
				onAttempt: async ({ spec }) => {
					seen.push(modelKey(spec));
					throw abort;
				},
				recordAttempt: () => {},
				now: fakeClock(),
			}),
		).rejects.toBe(abort);
		expect(seen).toHaveLength(1);
	});

	it("rethrows the last error when the whole chain is exhausted", async () => {
		const attempts: AgentAttempt[] = [];
		const seen: string[] = [];
		const last = httpError("out of credit", 402);

		await expect(
			runStageWithFallback<string>({
				stage: "CURATOR",
				chain: MODEL_CHAIN,
				routerState: new RouterState(),
				onAttempt: async ({ spec }) => {
					seen.push(modelKey(spec));
					if (spec.provider === DEEPSEEK.provider) throw last;
					throw httpError("out of credit", 402);
				},
				recordAttempt: (a) => attempts.push(a),
				now: fakeClock(),
			}),
		).rejects.toBe(last);

		expect(seen).toEqual([modelKey(GEMINI), modelKey(GPT), modelKey(DEEPSEEK)]);
		expect(attempts).toHaveLength(3);
		expect(attempts.every((a) => a.status === "FAILED" && a.failureClass === "BILLING")).toBe(true);
	});

	it("throws a clear error when every provider is already degraded", async () => {
		const routerState = new RouterState();
		for (const spec of MODEL_CHAIN) routerState.markProviderDegraded(spec.provider, "AUTH");

		await expect(
			runStageWithFallback<string>({
				stage: "CURATOR",
				chain: MODEL_CHAIN,
				routerState,
				onAttempt: async () => "never",
				recordAttempt: () => {},
				now: fakeClock(),
			}),
		).rejects.toThrow(/every provider in the chain is degraded/);
	});

	it("gives every attempt a unique id and a monotonic attemptIndex", async () => {
		const attempts: AgentAttempt[] = [];
		const indexes: number[] = [];

		await runStageWithFallback<string>({
			stage: "CURATOR",
			chain: MODEL_CHAIN,
			routerState: new RouterState(),
			onAttempt: async ({ spec, attemptIndex }) => {
				indexes.push(attemptIndex);
				if (spec.provider !== DEEPSEEK.provider) throw httpError("quota exhausted, no credit", 429);
				return "ok";
			},
			recordAttempt: (a) => attempts.push(a),
			now: fakeClock(),
		});

		expect(indexes).toEqual([0, 1, 2]);
		expect(new Set(attempts.map((a) => a.attemptId)).size).toBe(3);
	});
});
