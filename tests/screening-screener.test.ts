import { describe, expect, it } from "vitest";
import { InterestsConfig, ScreeningConfig } from "../src/config/schema.ts";
import { buildScreeningPolicy, renderScreeningBatch, screenItems } from "../src/screening/screener.ts";
import { routingIsTrusted } from "../src/screening/stage.ts";
import { isAuditSampled, type ScreeningInput } from "../src/screening/types.ts";

/*
 * The screener is a batched model function with three non-negotiable
 * properties: it never fails a run, it never invents a verdict, and it is
 * bounded. These tests are about the second one above all -- every failure
 * path must produce NO decision for the affected items, because "no decision"
 * is what fails open to the Curator and a fabricated UNSURE would make the
 * measurement claim the model judged something it never saw.
 */

const interests = InterestsConfig.parse({
	topics: [
		{ id: "ai-llm", label: "AI / LLM", weight: 1.0, keywords: ["ai"], aliases: [] },
		{ id: "vllm", label: "vLLM", weight: 0.8, keywords: ["vllm"], aliases: [] },
	],
});

const config = ScreeningConfig.parse({
	mode: "shadow",
	model: "test-screener",
	batchSize: 2,
	concurrency: 2,
	timeoutMs: 5_000,
	maxWallClockMs: 10_000,
});

function item(id: string, over: Partial<ScreeningInput> = {}): ScreeningInput {
	return {
		id,
		sourceType: "rss",
		sourceName: "Example",
		title: `Title ${id}`,
		summary: `Summary ${id}`,
		...over,
	};
}

type Decision = { id: string; verdict: string; reasonCode: string; reason: string };

function responseFor(decisions: Decision[], usage?: Record<string, unknown>): Response {
	return new Response(
		JSON.stringify({
			choices: [{ message: { content: JSON.stringify({ decisions }) } }],
			...(usage ? { usage } : {}),
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function idsIn(body: string): string[] {
	const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
	return [...String(parsed.messages[1]?.content).matchAll(/^id: (\S+)$/gm)].map((m) => m[1]!);
}

function stub(handler: (ids: string[], body: string) => Response | Promise<Response>): typeof fetch {
	return (async (_url: unknown, init?: RequestInit) => {
		const body = String(init?.body ?? "");
		return handler(idsIn(body), body);
	}) as typeof fetch;
}

const verdictAll = (verdict: string, reasonCode: string) => (ids: string[]) =>
	responseFor(ids.map((id) => ({ id, verdict, reasonCode, reason: "stub" })));

describe("screenItems: one decision per judged item", () => {
	it("returns decisions in input order and nothing for unjudged items", async () => {
		const outcome = await screenItems([item("a"), item("b"), item("c")], {
			config,
			apiKey: "k",
			interests,
			fetchImpl: stub(verdictAll("KEEP", "TRACKED_AREA")),
		});
		expect(outcome.decisions.map((d) => d.itemId)).toEqual(["a", "b", "c"]);
		expect(outcome.unscreened).toEqual([]);
		expect(outcome.batchesOk).toBe(2);
	});

	it("passes exactly the five scan fields and never a body or metadata", async () => {
		let sent = "";
		await screenItems([item("a", { summary: "S" })], {
			config,
			apiKey: "k",
			interests,
			fetchImpl: stub((ids, body) => {
				sent = body;
				return verdictAll("KEEP", "TRACKED_AREA")(ids);
			}),
		});
		const rendered = renderScreeningBatch([item("a", { summary: "S" })]);
		const request = JSON.parse(sent) as { messages: Array<{ role: string; content: string }> };
		expect(request.messages[1]).toEqual({ role: "user", content: rendered });
		expect(rendered.split("\n")).toEqual(["id: a", "source: Example (rss)", "title: Title a", "summary: S"]);
		expect(request.messages[1]?.content).not.toMatch(/metadata|publishedAt|Full body/);
	});

	it("truncates a long summary rather than sending the whole thing", () => {
		const rendered = renderScreeningBatch([item("a", { summary: "x".repeat(2000) })]);
		expect(rendered.length).toBeLessThan(700);
	});
});

describe("screenItems: a failure is never a verdict", () => {
	it("leaves a failed batch unscreened, with the failure named", async () => {
		const outcome = await screenItems([item("a"), item("b"), item("c")], {
			config,
			apiKey: "k",
			interests,
			fetchImpl: stub((ids) =>
				ids.includes("a") ? new Response("down", { status: 503 }) : verdictAll("DROP", "OFF_TOPIC")(ids),
			),
		});
		expect(outcome.decisions.map((d) => d.itemId)).toEqual(["c"]);
		expect(outcome.unscreened).toEqual([
			{ itemId: "a", why: "HTTP 503" },
			{ itemId: "b", why: "HTTP 503" },
		]);
		expect(outcome.batchesFailed).toBe(1);
	});

	it("leaves an item the model skipped unscreened, and keeps the rest of its batch", async () => {
		const outcome = await screenItems([item("a"), item("b")], {
			config,
			apiKey: "k",
			interests,
			fetchImpl: stub(() => responseFor([{ id: "a", verdict: "DROP", reasonCode: "MARKETING", reason: "r" }])),
		});
		expect(outcome.decisions.map((d) => d.itemId)).toEqual(["a"]);
		expect(outcome.unscreened).toEqual([{ itemId: "b", why: "model returned no decision for this item" }]);
	});

	it("drops a decision with a made-up verdict or reason code, not the batch", async () => {
		const outcome = await screenItems([item("a"), item("b")], {
			config,
			apiKey: "k",
			interests,
			fetchImpl: stub(() =>
				responseFor([
					{ id: "a", verdict: "LOW", reasonCode: "MARKETING", reason: "old vocabulary" },
					{ id: "b", verdict: "DROP", reasonCode: "VIBES", reason: "made up" },
				]),
			),
		});
		expect(outcome.decisions).toEqual([]);
		expect(outcome.unscreened.map((u) => u.itemId)).toEqual(["a", "b"]);
		expect(outcome.unscreened[0]?.why).toBe("decision did not match the contract");
	});

	it("treats a non-JSON completion as a failed batch", async () => {
		const outcome = await screenItems([item("a")], {
			config,
			apiKey: "k",
			interests,
			fetchImpl: stub(
				() =>
					new Response(JSON.stringify({ choices: [{ message: { content: "sure, DROP everything" } }] }), {
						status: 200,
					}),
			),
		});
		expect(outcome.decisions).toEqual([]);
		expect(outcome.unscreened[0]?.why).toBe("completion was not JSON");
	});

	it("never throws, whatever the transport does", async () => {
		const outcome = await screenItems([item("a")], {
			config,
			apiKey: "k",
			interests,
			fetchImpl: (async () => {
				throw new TypeError("fetch failed");
			}) as typeof fetch,
		});
		expect(outcome.decisions).toEqual([]);
		expect(outcome.unscreened).toEqual([{ itemId: "a", why: "fetch failed" }]);
	});

	it("does nothing, and calls nothing, for no items", async () => {
		let calls = 0;
		const outcome = await screenItems([], {
			config,
			apiKey: "k",
			interests,
			fetchImpl: (async () => {
				calls++;
				return new Response("{}");
			}) as typeof fetch,
		});
		expect(calls).toBe(0);
		expect(outcome).toEqual({ decisions: [], unscreened: [], batchesOk: 0, batchesFailed: 0, durationMs: 0 });
	});
});

describe("screenItems: provider-reported usage", () => {
	it("sums usage across the batches that reported it, and counts them", async () => {
		const outcome = await screenItems([item("a"), item("b"), item("c")], {
			config,
			apiKey: "k",
			interests,
			fetchImpl: stub((ids) =>
				responseFor(
					ids.map((id) => ({ id, verdict: "KEEP", reasonCode: "TRACKED_AREA", reason: "r" })),
					ids.includes("a")
						? { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 40 } }
						: undefined,
				),
			),
		});
		expect(outcome.usage).toEqual({ input: 100, output: 10, cacheRead: 40, cacheWrite: 0, totalTokens: 110, reportedBy: 1 });
	});

	it("reports no usage at all when nothing reported it", async () => {
		const outcome = await screenItems([item("a")], {
			config,
			apiKey: "k",
			interests,
			fetchImpl: stub(verdictAll("KEEP", "TRACKED_AREA")),
		});
		expect(outcome.usage).toBeUndefined();
	});
});

describe("the screening policy", () => {
	it("names the tracked areas and the three verdicts, and nothing about ranking", () => {
		for (const version of ["screening-v1", "screening-v2"]) {
			const policy = buildScreeningPolicy(interests, version);
			expect(policy).toContain("- vllm: vLLM");
			for (const v of ["DROP", "KEEP", "UNSURE"]) expect(policy).toContain(v);
			expect(policy).not.toMatch(/PRIORITY|NORMAL|LOW\b/);
			expect(policy).toMatch(/DROP is a claim, not a shrug|Be conservative with DROP/);
		}
	});

	it("resolves an experiment label to its base policy by prefix, and refuses an unknown version", () => {
		expect(buildScreeningPolicy(interests, "screening-v2-rerun")).toBe(buildScreeningPolicy(interests, "screening-v2"));
		expect(buildScreeningPolicy(interests, "screening-v1")).not.toBe(buildScreeningPolicy(interests, "screening-v2"));
		expect(() => buildScreeningPolicy(interests, "screening-v9")).toThrow(/no screening policy registered/);
	});

	it("sends the hint line only when the input carries one", () => {
		expect(renderScreeningBatch([item("a", { hint: "score 120" })])).toContain("hint: score 120");
		expect(renderScreeningBatch([item("a")])).not.toContain("hint:");
	});
});

describe("audit sampling is deterministic", () => {
	const key = { date: "2026-09-18", itemId: "itm-1", policyVersion: "screening-v1" };

	it("answers the same for the same inputs, every time", () => {
		const first = isAuditSampled(key, 0.05);
		for (let i = 0; i < 20; i++) expect(isAuditSampled(key, 0.05)).toBe(first);
	});

	it("draws a fresh sample for a new policy version", () => {
		const ids = Array.from({ length: 2000 }, (_, i) => `itm-${i}`);
		const v1 = ids.filter((itemId) => isAuditSampled({ ...key, itemId }, 0.05));
		const v2 = ids.filter((itemId) => isAuditSampled({ ...key, itemId, policyVersion: "screening-v2" }, 0.05));
		expect(v1).not.toEqual(v2);
	});

	it("samples at about the configured rate", () => {
		const ids = Array.from({ length: 10_000 }, (_, i) => `itm-${i}`);
		const sampled = ids.filter((itemId) => isAuditSampled({ ...key, itemId }, 0.05)).length;
		expect(sampled).toBeGreaterThan(350);
		expect(sampled).toBeLessThan(650);
	});

	/*
	 * A golden vector, not another property.
	 *
	 * The properties above all hold for ANY hash of these three fields, so none
	 * of them would notice the sample being redrawn. The separator used to be
	 * two literal NUL bytes embedded in src/screening/types.ts, which made the
	 * file read as binary to every text tool and would have been silently
	 * rewritten by anything that normalised control characters on save. That
	 * would have changed which items were audited on every past and future day,
	 * while `isAuditSampled` still looked deterministic and still sampled at the
	 * right rate.
	 *
	 * These values were taken from the implementation as it shipped on
	 * 2026-09-19, when routing went live with a 10% audit rate. If this test
	 * fails, the audit sample has moved and the leakage figures recorded against
	 * earlier days no longer describe the same sample.
	 */
	it("draws the sample it drew when routing went live", () => {
		const ids = Array.from({ length: 2000 }, (_, i) => `itm-${i}`);
		const sampled = ids.filter((itemId) =>
			isAuditSampled({ date: "2026-09-19", itemId, policyVersion: "screening-v3" }, 0.1),
		);
		expect(sampled.length).toBe(212);
		expect(sampled.slice(0, 5)).toEqual(["itm-9", "itm-14", "itm-25", "itm-26", "itm-30"]);
	});

	it("samples nothing at 0 and everything at 1", () => {
		expect(isAuditSampled(key, 0)).toBe(false);
		expect(isAuditSampled(key, 1)).toBe(true);
	});
});

describe("routing trust", () => {
	const base = { mode: "route" as const, model: "m", policyVersion: "p" };
	it("requires an explicit trusted pair that matches the configured screener", () => {
		expect(routingIsTrusted(ScreeningConfig.parse({ ...base })).ok).toBe(false);
		expect(
			routingIsTrusted(ScreeningConfig.parse({ ...base, routing: { trustedModel: "m", trustedPolicyVersion: "p" } })).ok,
		).toBe(true);
	});
	it("fails open when the policy version or the model moved on", () => {
		const policy = routingIsTrusted(
			ScreeningConfig.parse({ ...base, policyVersion: "p2", routing: { trustedModel: "m", trustedPolicyVersion: "p" } }),
		);
		expect(policy.ok).toBe(false);
		expect(policy.ok ? "" : policy.why).toMatch(/policyVersion p2 is not the trusted p/);
		const model = routingIsTrusted(
			ScreeningConfig.parse({ ...base, model: "m2", routing: { trustedModel: "m", trustedPolicyVersion: "p" } }),
		);
		expect(model.ok).toBe(false);
	});
	it("never trusts outside route mode", () => {
		expect(
			routingIsTrusted(
				ScreeningConfig.parse({ ...base, mode: "shadow", routing: { trustedModel: "m", trustedPolicyVersion: "p" } }),
			).ok,
		).toBe(false);
	});
});

/*
 * The screener has no tool surface, pinned structurally: nothing under
 * src/screening may reach the curator, the editor, the agent tools, the
 * research router or the Pi runtime. A screener that could look things up
 * would start spending tokens on the questions the Curator exists to answer.
 */
describe("the screener stays a stateless function", () => {
	it("imports nothing from the agent side of the pipeline", async () => {
		const { readdir, readFile } = await import("node:fs/promises");
		const { fileURLToPath } = await import("node:url");
		const { join } = await import("node:path");
		const dir = fileURLToPath(new URL("../src/screening", import.meta.url));
		const offenders: string[] = [];
		for (const name of await readdir(dir)) {
			if (!name.endsWith(".ts")) continue;
			const text = await readFile(join(dir, name), "utf8");
			if (/from\s+["'][^"']*\/(curator|editor|agent-tools|research|runtime\/pi-runtime|runtime\/agent-driver)[/"']/.test(text)) {
				offenders.push(name);
			}
			if (/pi-coding-agent/.test(text)) offenders.push(`${name} (Pi SDK)`);
		}
		expect(offenders).toEqual([]);
	});
});
