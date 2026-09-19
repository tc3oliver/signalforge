import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureCuratorEvidence, createCuratorTools, type CuratorContext } from "../src/curator/tools.ts";
import { EvidenceConfig } from "../src/config/schema.ts";
import { JsonStoryRepository } from "../src/stories/json-repository.ts";
import type { DailyManifest, NormalizedItem } from "../src/schemas/index.ts";
import { htmlToText } from "../src/collectors/html-text.ts";

/*
 * What these pin: the Curator is never shown a passage the server could not
 * find in the source, and no failure of the distilling model sends it back to
 * reading whole articles -- which is the cost this path exists to remove.
 */

const DATE = "2026-09-19";
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "di-evidence-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	configureCuratorEvidence(undefined);
});

const BODY =
	"<p>The gateway routes on live signals.</p><p>It considers prefix cache hit rate and queue depth.</p>";

function item(over: Partial<NormalizedItem> & { id: string }): NormalizedItem {
	return {
		sourceType: "rss",
		sourceName: "Example",
		title: "A gateway ships",
		summary: "A summary",
		publishedAt: "2026-09-19T00:00:00.000Z",
		metadata: {},
		trust: "UNTRUSTED_EXTERNAL_CONTENT",
		...over,
	} as NormalizedItem;
}

/** A fake endpoint returning whatever the model is pretended to have said. */
function fakeFetch(body: unknown, status = 200): typeof fetch {
	return (async () =>
		new Response(
			JSON.stringify({
				choices: [{ message: { content: JSON.stringify(body) } }],
				usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
			}),
			{ status, headers: { "content-type": "application/json" } },
		)) as unknown as typeof fetch;
}

function tools(fetchImpl: typeof fetch, calls?: { onToolCall?: CuratorContext["onToolCall"] }, over?: Partial<Record<string, unknown>>) {
	const manifest: DailyManifest = {
		date: DATE,
		generatedAt: DATE,
		items: [item({ id: "i1", content: BODY }), item({ id: "i2", content: "", summary: "" })],
		facts: [],
	};
	configureCuratorEvidence({
		config: EvidenceConfig.parse({ enabled: true, model: "test-model", ...over }),
		apiKey: "unused-in-test",
		fetchImpl,
	});
	const ctx: CuratorContext = {
		date: DATE,
		manifest,
		repo: new JsonStoryRepository(join(root, "ledger")),
		now: () => new Date("2026-09-19T12:00:00Z"),
		...(calls?.onToolCall ? { onToolCall: calls.onToolCall } : {}),
	};
	return createCuratorTools(ctx);
}

async function run(tool: { execute: unknown }, params: unknown): Promise<Record<string, unknown>> {
	const execute = tool.execute as (a: string, b: unknown, c: unknown, d: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }>;
	const result = await execute("call", params, undefined, undefined, {});
	return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("get_item_evidence", () => {
	it("is absent unless evidence is configured for the run", () => {
		configureCuratorEvidence(undefined);
		const manifest: DailyManifest = { date: DATE, generatedAt: DATE, items: [item({ id: "i1" })], facts: [] };
		const set = createCuratorTools({
			date: DATE,
			manifest,
			repo: new JsonStoryRepository(join(root, "ledger")),
			now: () => new Date(),
		});
		expect(set.map((t) => t.name)).not.toContain("get_item_evidence");
	});

	it("returns quotes as the source's own characters, with an offset into the body", async () => {
		const set = tools(
			fakeFetch({
				answer: "It routes on cache state.",
				attribution: "The vendor",
				// Straight punctuation and different case: the source's text wins.
				quotes: ["it considers PREFIX CACHE HIT RATE and queue depth."],
			}),
		);
		const out = await run(set.find((t) => t.name === "get_item_evidence")!, {
			itemIds: ["i1"],
			question: "What does the gateway route on?",
		});
		const items = out["items"] as Array<Record<string, unknown>>;
		expect(items[0]!["status"]).toBe("OK");
		expect(items[0]!["attribution"]).toBe("The vendor");
		const evidence = items[0]!["evidence"] as Array<Record<string, unknown>>;
		expect(evidence[0]!["quote"]).toBe("It considers prefix cache hit rate and queue depth.");
		// The offset addresses the canonical prose, which is what read_item_body
		// also reads, so a follow-up range read lands where this says it will.
		const canonical = htmlToText(BODY);
		const at = evidence[0]!["at"] as number;
		expect(canonical.slice(at, at + (evidence[0]!["quote"] as string).length)).toBe(evidence[0]!["quote"]);
	});

	it("discards a passage that is not in the document, and counts it", async () => {
		const set = tools(
			fakeFetch({
				answer: "It routes on cache state.",
				quotes: [
					"It considers prefix cache hit rate and queue depth.",
					"It considers KV cache utilisation.",
				],
			}),
		);
		const out = await run(set.find((t) => t.name === "get_item_evidence")!, {
			itemIds: ["i1"],
			question: "What does the gateway route on?",
		});
		const items = out["items"] as Array<Record<string, unknown>>;
		expect((items[0]!["evidence"] as unknown[]).length).toBe(1);
		expect(items[0]!["dropped"]).toBe(1);
	});

	it("withholds an answer that nothing verifiable supports", async () => {
		const set = tools(fakeFetch({ answer: "Something confident.", quotes: ["A sentence never written."] }));
		const out = await run(set.find((t) => t.name === "get_item_evidence")!, {
			itemIds: ["i1"],
			question: "What does the gateway route on?",
		});
		const items = out["items"] as Array<Record<string, unknown>>;
		expect(items[0]!["status"]).toBe("NO_EVIDENCE");
		expect(items[0]!["answer"]).toBeUndefined();
		expect(items[0]!["dropped"]).toBe(1);
	});

	it("marks an item with no body rather than calling the model for it", async () => {
		let called = 0;
		const counting: typeof fetch = (async (...args: Parameters<typeof fetch>) => {
			called += 1;
			return fakeFetch({ answer: "x", quotes: ["y"] })(...args);
		}) as unknown as typeof fetch;
		const set = tools(counting);
		const out = await run(set.find((t) => t.name === "get_item_evidence")!, {
			itemIds: ["i2"],
			question: "What does this say about anything?",
		});
		const items = out["items"] as Array<Record<string, unknown>>;
		expect(items[0]!["status"]).toBe("EMPTY_BODY");
		expect(called).toBe(0);
	});

	it("degrades rather than failing when the provider is unreachable", async () => {
		const degraded: string[] = [];
		configureCuratorEvidence(undefined);
		const manifest: DailyManifest = { date: DATE, generatedAt: DATE, items: [item({ id: "i1", content: BODY })], facts: [] };
		configureCuratorEvidence({
			config: EvidenceConfig.parse({ enabled: true, model: "test-model" }),
			apiKey: "unused-in-test",
			fetchImpl: (async () => {
				throw new Error("connection refused");
			}) as unknown as typeof fetch,
			onDegraded: (reason) => degraded.push(reason),
		});
		const set = createCuratorTools({
			date: DATE,
			manifest,
			repo: new JsonStoryRepository(join(root, "ledger")),
			now: () => new Date(),
		});
		const out = await run(set.find((t) => t.name === "get_item_evidence")!, {
			itemIds: ["i1"],
			question: "What does the gateway route on?",
		});
		const items = out["items"] as Array<Record<string, unknown>>;
		expect(items[0]!["status"]).toBe("UNAVAILABLE");
		expect(items[0]!["bodyChars"]).toBeGreaterThan(0);
		expect(degraded[0]).toMatch(/evidence distillation failed/);
	});

	it("refuses an item id that is not in the manifest", async () => {
		const set = tools(fakeFetch({ answer: "x", quotes: ["y"] }));
		await expect(
			run(set.find((t) => t.name === "get_item_evidence")!, { itemIds: ["nope"], question: "Anything at all here?" }),
		).rejects.toThrow(/Unknown item id/);
	});

	it("stops spending once the run's budget is gone, without refusing", async () => {
		const set = tools(fakeFetch({ answer: "a", quotes: ["It considers prefix cache hit rate and queue depth."] }), undefined, {
			maxCallsPerRun: 1,
		});
		const tool = set.find((t) => t.name === "get_item_evidence")!;
		const first = await run(tool, { itemIds: ["i1"], question: "What does the gateway route on?" });
		expect((first["items"] as unknown[]).length).toBe(1);
		const second = await run(tool, { itemIds: ["i1"], question: "What does the gateway route on?" });
		expect(second["note"]).toMatch(/budget/);
		expect((second["items"] as unknown[]).length).toBe(0);
	});

	it("records what it cost and what it discarded", async () => {
		const calls: Array<{ name: string; summary: Record<string, unknown> }> = [];
		const set = tools(
			fakeFetch({ answer: "a", quotes: ["It considers prefix cache hit rate and queue depth.", "not present"] }),
			{ onToolCall: (name, summary) => calls.push({ name, summary }) },
		);
		await run(set.find((t) => t.name === "get_item_evidence")!, {
			itemIds: ["i1"],
			question: "What does the gateway route on?",
		});
		const note = calls.find((c) => c.name === "get_item_evidence")!;
		expect(note.summary["quotes"]).toBe(1);
		expect(note.summary["dropped"]).toBe(1);
		expect(note.summary["sourceChars"]).toBeGreaterThan(0);
		expect(note.summary["tokenUsage"]).toMatchObject({ input: 100, output: 20 });
	});
});
