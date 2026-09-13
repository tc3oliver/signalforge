import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolRejection, configureCuratorResearch, createCuratorTools } from "../src/curator/tools.ts";
import { ResearchBudgetTracker, ResearchRouter } from "../src/research/router.ts";
import type { ResearchProvider, ResearchResult } from "../src/research/types.ts";
import { JsonStoryRepository } from "../src/stories/json-repository.ts";
import { makeManifest } from "./support/fake-agent.ts";

const DATE = "2026-09-13";

const BUDGETS = {
	maxQueryLength: 40,
	maxResults: 3,
	perRequestTimeoutMs: 1000,
	maxCallsPerStory: 2,
	maxCallsPerRun: 3,
};

function result(query: string, n: number): ResearchResult {
	return {
		provider: "tavily",
		query,
		title: `Hit ${n}`,
		url: `https://example.invalid/${n}`,
		snippet: `Snippet ${n}`,
		retrievedAt: "2026-09-13T06:00:00.000Z",
		raw: { n },
	};
}

function provider(name: "tavily" | "exa", behaviour: "ok" | "timeout"): ResearchProvider {
	return {
		name,
		check: async () => ({ ok: true, detail: "fake" }),
		search: async (query) => {
			if (behaviour === "timeout") throw new Error("request timed out after 1000ms");
			return [result(query, 1), result(query, 2)];
		},
	};
}

let root: string;

function buildTools(primary: "ok" | "timeout") {
	const router = new ResearchRouter(
		provider("tavily", primary),
		provider("exa", primary),
		new ResearchBudgetTracker(BUDGETS),
	);
	configureCuratorResearch({ router, maxResults: BUDGETS.maxResults });
	return createCuratorTools({
		date: DATE,
		manifest: makeManifest({ date: DATE, groups: 2 }),
		repo: new JsonStoryRepository(join(root, "ledger")),
		now: () => new Date("2026-09-13T06:00:00.000Z"),
	});
}

function searchWebOf(tools: ReturnType<typeof createCuratorTools>) {
	const tool = tools.find((t) => t.name === "search_web");
	if (!tool) throw new Error("search_web is not registered");
	return (args: Record<string, unknown>) =>
		tool.execute("call-1", args as never, undefined, undefined, {} as never);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "di-search-web-"));
});

afterEach(() => {
	configureCuratorResearch(undefined);
	rmSync(root, { recursive: true, force: true });
});

describe("search_web registration", () => {
	it("is absent unless a research provider is configured for the run", () => {
		configureCuratorResearch(undefined);
		const tools = createCuratorTools({
			date: DATE,
			manifest: makeManifest({ date: DATE, groups: 2 }),
			repo: new JsonStoryRepository(join(root, "ledger")),
			now: () => new Date(),
		});
		expect(tools.map((t) => t.name)).not.toContain("search_web");
		// The offline tool set is exactly the eleven the restricted runtime expects.
		expect(tools).toHaveLength(11);
	});

	it("is present, and additive, when a router is configured", () => {
		const tools = buildTools("ok");
		const names = tools.map((t) => t.name);
		expect(names).toContain("search_web");
		expect(names).toContain("submit_materials");
		expect(names).toHaveLength(12);
	});

	it("states its permitted uses in the description the model sees", () => {
		const tool = buildTools("ok").find((t) => t.name === "search_web")!;
		expect(tool.description).toMatch(/primary source/i);
		expect(tool.description).toMatch(/conflicting/i);
		expect(tool.description).toMatch(/evidence gap/i);
		expect(tool.description).toMatch(/latest/i);
	});
});

describe("search_web budgets", () => {
	it("returns results with provenance for a permitted call", async () => {
		const search = searchWebOf(buildTools("ok"));
		const raw = await search({ query: "who published the primary source", storyId: "s1", reason: "MISSING_PRIMARY_SOURCE" });
		const payload = JSON.parse((raw.content[0] as { text: string }).text) as {
			results: Array<{ url: string; trust: string; retrievedAt: string; sourceName: string }>;
		};
		expect(payload.results).toHaveLength(2);
		expect(payload.results[0]!.url).toBe("https://example.invalid/1");
		expect(payload.results[0]!.trust).toBe("UNTRUSTED_EXTERNAL_CONTENT");
		expect(payload.results[0]!.sourceName).toBe("tavily");
		expect(payload.results[0]!.retrievedAt).toBe("2026-09-13T06:00:00.000Z");
	});

	it("rejects a query longer than the configured budget", async () => {
		const search = searchWebOf(buildTools("ok"));
		await expect(
			search({ query: "x".repeat(BUDGETS.maxQueryLength + 1), storyId: "s1", reason: "CONFLICTING_REPORTS" }),
		).rejects.toThrow(ToolRejection);
	});

	it("rejects once a story has used its call budget", async () => {
		const search = searchWebOf(buildTools("ok"));
		const args = { query: "budget probe", storyId: "s1", reason: "VERIFY_LATEST_CLAIM" };
		await search(args);
		await search(args);
		await expect(search(args)).rejects.toThrow(/STORY_CALL_BUDGET_EXCEEDED/);
	});

	it("rejects once the run has used its call budget", async () => {
		const search = searchWebOf(buildTools("ok"));
		await search({ query: "a", storyId: "s1", reason: "MISSING_PRIMARY_SOURCE" });
		await search({ query: "b", storyId: "s2", reason: "MISSING_PRIMARY_SOURCE" });
		await search({ query: "c", storyId: "s3", reason: "MISSING_PRIMARY_SOURCE" });
		await expect(
			search({ query: "d", storyId: "s4", reason: "MISSING_PRIMARY_SOURCE" }),
		).rejects.toThrow(/RUN_CALL_BUDGET_EXCEEDED/);
	});

	it("rejects cleanly when every provider times out", async () => {
		const search = searchWebOf(buildTools("timeout"));
		await expect(
			search({ query: "verify latest", storyId: "s1", reason: "HIGH_IMPORTANCE_EVIDENCE_GAP" }),
		).rejects.toThrow(ToolRejection);
	});
});
