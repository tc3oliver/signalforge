import { describe, expect, it, vi } from "vitest";
import { classifyWithModel } from "../src/triage/model-classifier.ts";
import type { ModelTriageDeps } from "../src/triage/model-classifier.ts";
import type { TriageInput } from "../src/triage/types.ts";
import type { InterestsConfig, TriageModelConfig } from "../src/config/schema.ts";

const interests = {
	topics: [
		{ id: "ai-llm", label: "AI and LLMs", weight: 1, keywords: [] },
		{ id: "security", label: "Security", weight: 1, keywords: [] },
	],
} as unknown as InterestsConfig;

const config: TriageModelConfig = {
	enabled: true,
	baseUrl: "https://api.test/v1",
	model: "test-model",
	apiKeySecret: "OPENAI_API_KEY",
	batchSize: 2,
	concurrency: 2,
	timeoutMs: 5_000,
	maxWallClockMs: 30_000,
	rulesVersion: "model-test",
};

function items(n: number): TriageInput[] {
	return Array.from({ length: n }, (_, i) => ({
		itemId: `item-${i}`,
		sourceType: "rss",
		sourceName: "Feed",
		title: `Title ${i}`,
		summary: `Summary ${i}`,
		publishedAt: "2026-09-18T00:00:00.000Z",
		metadata: {},
	}));
}

function completion(verdicts: unknown): Response {
	return new Response(
		JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdicts }) } }] }),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function deps(fetchImpl: typeof fetch, over: Partial<ModelTriageDeps> = {}): ModelTriageDeps {
	return { config, apiKey: "test-key", interests, fetchImpl, log: () => {}, ...over };
}

describe("classifyWithModel", () => {
	it("returns one result per input item, in input order", async () => {
		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
			const ids = [...String(body.messages[1]?.content).matchAll(/itemId: (\S+)/g)].map((m) => m[1]);
			return completion(ids.map((id) => ({ itemId: id, category: "NORMAL", reason: "ok" })));
		}) as unknown as typeof fetch;

		const outcome = await classifyWithModel(items(5), deps(fetchImpl));

		expect(outcome.results.map((r) => r.itemId)).toEqual([
			"item-0", "item-1", "item-2", "item-3", "item-4",
		]);
		expect(outcome.degraded).toBe(0);
		expect(outcome.batchesFailed).toBe(0);
		// 5 items at batchSize 2 -> 3 batches.
		expect(outcome.batchesOk).toBe(3);
	});

	/*
	 * The property the whole pass depends on. LOW is the only bucket a future
	 * filter would drop, so a transport error, a malformed body or a model that
	 * simply skipped an item must never be able to put anything in it. Anything
	 * this pass could not genuinely judge comes back UNCERTAIN, with the failure
	 * named rather than dressed up as an opinion about the article.
	 */
	describe("a failure is never a verdict", () => {
		it("degrades a failed batch to UNCERTAIN, never LOW", async () => {
			const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

			const outcome = await classifyWithModel(items(4), deps(fetchImpl));

			expect(outcome.results).toHaveLength(4);
			expect(outcome.results.every((r) => r.category === "UNCERTAIN")).toBe(true);
			expect(outcome.results.some((r) => r.category === "LOW")).toBe(false);
			expect(outcome.degraded).toBe(4);
			expect(outcome.batchesOk).toBe(0);
			expect(outcome.results[0]?.ruleId).toBe("model-unavailable");
			expect(outcome.results[0]?.reason).toContain("HTTP 500");
		});

		it("degrades an item the model silently skipped", async () => {
			// One verdict returned for a two-item batch. The missing item is a gap in
			// the measurement; reading it as NORMAL would invent data.
			const fetchImpl = vi.fn(async () =>
				completion([{ itemId: "item-0", category: "PRIORITY", reason: "advisory" }]),
			) as unknown as typeof fetch;

			const outcome = await classifyWithModel(items(2), deps(fetchImpl));

			expect(outcome.results[0]?.category).toBe("PRIORITY");
			expect(outcome.results[1]?.category).toBe("UNCERTAIN");
			expect(outcome.results[1]?.reason).toContain("no verdict");
		});

		it("degrades a response that is not the expected shape", async () => {
			const fetchImpl = vi.fn(async () =>
				new Response(JSON.stringify({ choices: [{ message: { content: '{"nonsense":1}' } }] }), {
					status: 200,
				}),
			) as unknown as typeof fetch;

			const outcome = await classifyWithModel(items(2), deps(fetchImpl));

			expect(outcome.results.every((r) => r.category === "UNCERTAIN")).toBe(true);
			expect(outcome.results[0]?.reason).toContain("expected shape");
		});

		it("degrades a category the model made up", async () => {
			// An unknown category is a schema failure for the whole batch, not a
			// value to pass through: item_triage has a check constraint and a row it
			// rejects would fail the write for every other item in the same insert.
			const fetchImpl = vi.fn(async () =>
				completion([
					{ itemId: "item-0", category: "VERY_IMPORTANT", reason: "made up" },
					{ itemId: "item-1", category: "NORMAL", reason: "fine" },
				]),
			) as unknown as typeof fetch;

			const outcome = await classifyWithModel(items(2), deps(fetchImpl));

			expect(outcome.results.every((r) => r.category === "UNCERTAIN")).toBe(true);
			expect(outcome.batchesOk).toBe(0);
		});

		it("never throws, whatever the transport does", async () => {
			const fetchImpl = vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch;

			await expect(classifyWithModel(items(3), deps(fetchImpl))).resolves.toMatchObject({
				degraded: 3,
			});
		});
	});

	it("sends no item body, only the triage projection", async () => {
		// TriageInput has no `content` field by construction; this pins that the
		// prompt does not quietly reintroduce one and turn a cheap pass expensive.
		let sent = "";
		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
			sent = String(body.messages[1]?.content);
			return completion([{ itemId: "item-0", category: "NORMAL", reason: "ok" }]);
		}) as unknown as typeof fetch;

		await classifyWithModel(items(1), deps(fetchImpl));

		expect(sent).toContain("title: Title 0");
		expect(sent).toContain("summary: Summary 0");
		expect(sent).not.toContain("content:");
	});

	it("does nothing, and calls nothing, for an empty manifest", async () => {
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		const outcome = await classifyWithModel([], deps(fetchImpl));

		expect(outcome.results).toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("runs batches concurrently rather than one after another", async () => {
		let inFlight = 0;
		let peak = 0;
		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight -= 1;
			const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
			const ids = [...String(body.messages[1]?.content).matchAll(/itemId: (\S+)/g)].map((m) => m[1]);
			return completion(ids.map((id) => ({ itemId: id, category: "NORMAL", reason: "ok" })));
		}) as unknown as typeof fetch;

		await classifyWithModel(items(8), deps(fetchImpl));

		// 4 batches, concurrency 2: serial would peak at 1.
		expect(peak).toBe(2);
	});
});
