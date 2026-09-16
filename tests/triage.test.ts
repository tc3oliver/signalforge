import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InterestsConfig, WatchlistsConfig } from "../src/config/schema.ts";
import { buildTriageRules } from "../src/triage/rules.ts";
import { titleKey, triageManifest, triageTally } from "../src/triage/run.ts";
import { TriageResult, type TriageInput } from "../src/triage/types.ts";
import {
	assessRoutingReadiness,
	buildTriageFunnel,
	ROUTING_GATE,
	type TriageOutcomeRow,
} from "../src/observation/triage-funnel.ts";

/*
 * Triage ships in shadow mode, so the tests that matter are the ones about what
 * it must NOT do: it must not reach the decision path, and it must not put a
 * technical release in the bucket a future filter would drop.
 */

const interests = InterestsConfig.parse({
	topics: [
		{ id: "ai-llm", label: "AI / LLM", weight: 1.0, keywords: ["ai", "llm"], aliases: [] },
		{ id: "vllm", label: "vLLM", weight: 0.8, keywords: ["vllm"], aliases: [] },
		{ id: "btc", label: "BTC", weight: 0.7, keywords: ["bitcoin"], aliases: ["btc"] },
		{ id: "macro", label: "Macro", weight: 0.8, keywords: ["inflation"], aliases: [] },
	],
});

const watchlists = WatchlistsConfig.parse({
	github_repos: ["vllm-project/vllm", "ggerganov/llama.cpp"],
	sec_companies: [{ ticker: "NVDA", name: "Nvidia", cik: null }],
	crypto_assets: [{ id: "bitcoin", symbol: "btc" }],
});

const rules = buildTriageRules({ interests, watchlists });

function item(over: Partial<TriageInput> & { title: string }): TriageInput {
	return {
		itemId: `i-${over.title.slice(0, 12)}`,
		sourceType: "rss",
		sourceName: "Example",
		summary: "",
		publishedAt: "2026-09-16T00:00:00.000Z",
		metadata: {},
		...over,
	};
}

describe("triage rules: what must never be LOW", () => {
	const mustNotBeLow = [
		"vLLM 0.9.0 released with improved throughput",
		"ROCm 7.2 now available for MI300 accelerators",
		"MLX adds quantization support for Apple silicon",
		"Announcing an MCP server for Postgres",
		"Qwen3-72B open-weight model released",
		"SGLang speculative decoding lands in main",
		"llama.cpp adds GGUF support for a new architecture",
		"Ethereum protocol upgrade scheduled for mainnet",
		"Critical CVE-2026-1234 in widely used TLS library",
		"Stablecoin bridge exploit drains reserves",
	];

	for (const title of mustNotBeLow) {
		it(`does not mark "${title.slice(0, 40)}..." as LOW`, () => {
			const result = rules.classify(item({ title }));
			expect(result.category).not.toBe("LOW");
		});
	}

	it("marks a watched repo release PRIORITY", () => {
		const result = rules.classify(
			item({
				title: "v0.9.0",
				sourceType: "github",
				metadata: { repo: "vllm-project/vllm" },
			}),
		);
		expect(result.category).toBe("PRIORITY");
		expect(result.ruleId).toBe("watched-repo-release");
	});

	it("marks a security advisory PRIORITY even with no topic match", () => {
		const result = rules.classify(item({ title: "Zero-day exploit in an unrelated appliance" }));
		expect(result.category).toBe("PRIORITY");
		expect(result.topicIds).toEqual([]);
	});

	it("marks a watched asset protocol event PRIORITY, not price chatter", () => {
		expect(rules.classify(item({ title: "Bitcoin custody rules change for validators" })).category).toBe(
			"PRIORITY",
		);
	});
});

describe("triage rules: what LOW is for", () => {
	it("marks a generic funding round LOW", () => {
		const result = rules.classify(item({ title: "Startup raises $40M Series B to build software" }));
		expect(result.category).toBe("LOW");
		expect(result.ruleId).toBe("business-noise");
	});

	it("marks valuation and executive commentary LOW", () => {
		expect(rules.classify(item({ title: "Company valued at $12B after new round" })).category).toBe("LOW");
		expect(
			rules.classify(item({ title: "CEO told Reuters the market is maturing" })).category,
		).toBe("LOW");
	});

	it("does not mark a funding story LOW when a high-weight topic matches", () => {
		// The profile is a prior in both directions: a raise for something the
		// reader tracks is not the same as a generic raise.
		const result = rules.classify(item({ title: "Inflation data drives a $40M seed round" }));
		expect(result.category).not.toBe("LOW");
		expect(result.ruleId).toBe("business-but-tracked");
	});

	it("keeps an engineering signal out of LOW even when wrapped in funding language", () => {
		// The engineering rules run before the business rules on purpose: "vLLM"
		// in a headline is the part worth reading whatever else the headline says.
		const result = rules.classify(item({ title: "vLLM maintainers raise $10M seed round" }));
		expect(result.category).not.toBe("LOW");
		expect(result.ruleId).toBe("ai-engineering-mention");
	});

	it("never returns LOW for anything it did not positively recognise", () => {
		const result = rules.classify(item({ title: "Zorblax quibnar frotz release cadence" }));
		expect(result.category).toBe("UNCERTAIN");
		expect(result.reason).toContain("drop bucket");
	});
});

describe("triage rules: shape and inputs", () => {
	it("produces schema-valid results", () => {
		const result = rules.classify(item({ title: "AI model released today" }));
		expect(() => TriageResult.parse(result)).not.toThrow();
	});

	it("keeps relevanceHint inside 0..1", () => {
		for (const title of ["vLLM release", "raises $40M", "unknown thing", "CVE-2026-9"]) {
			const r = rules.classify(item({ title }));
			expect(r.relevanceHint).toBeGreaterThanOrEqual(0);
			expect(r.relevanceHint).toBeLessThanOrEqual(1);
		}
	});

	it("matches short topic aliases on word boundaries only", () => {
		// "btc" must not fire on "btcXYZ"; "ai" must not fire on "said".
		expect(rules.classify(item({ title: "He said nothing of note" })).topicIds).not.toContain("ai-llm");
	});

	it("cannot see item content, by construction", () => {
		// The input type has no `content` field. This asserts the projection rather
		// than trusting the comment: a rule that wanted full text could not get it.
		const input = item({ title: "t" }) as unknown as Record<string, unknown>;
		expect(input["content"]).toBeUndefined();
		expect(Object.keys(input).sort()).toEqual(
			["itemId", "metadata", "publishedAt", "sourceName", "sourceType", "summary", "title"].sort(),
		);
	});
});

describe("duplicate hints", () => {
	it("marks later coverage of the same event, keeping the first", () => {
		const inputs = [
			item({ itemId: "a", title: "Acme releases Widget 5 with faster indexing engine" }),
			item({ itemId: "b", title: "Widget 5 released by Acme, faster indexing engine inside" }),
		];
		const results = triageManifest(inputs, rules);
		expect(results[0]?.category).not.toBe("DUPLICATE_HINT");
		expect(results[1]?.category).toBe("DUPLICATE_HINT");
	});

	it("never downgrades a PRIORITY item to a duplicate", () => {
		const inputs = [
			item({ itemId: "a", title: "Critical CVE-2026-1234 disclosed in widely deployed TLS library" }),
			item({ itemId: "b", title: "Critical CVE-2026-1234 disclosed in widely deployed TLS library" }),
		];
		const results = triageManifest(inputs, rules);
		expect(results[0]?.category).toBe("PRIORITY");
		expect(results[1]?.category).toBe("PRIORITY");
	});

	it("ignores titles too short to compare", () => {
		const results = triageManifest(
			[item({ itemId: "a", title: "v1.2.3" }), item({ itemId: "b", title: "v1.2.4" })],
			rules,
		);
		expect(results.every((r) => r.category !== "DUPLICATE_HINT")).toBe(true);
	});

	it("builds an order-insensitive title key", () => {
		expect(titleKey("Acme ships Widget")).toBe(titleKey("Widget shipped by Acme").replace("shipped", "ships"));
	});

	it("tallies every category, including empty ones", () => {
		const tally = triageTally(triageManifest([item({ title: "AI model released" })], rules));
		expect(Object.keys(tally).sort()).toEqual(
			["DUPLICATE_HINT", "LOW", "NORMAL", "PRIORITY", "UNCERTAIN"].sort(),
		);
	});
});

describe("triage metrics", () => {
	const row = (over: Partial<TriageOutcomeRow> & { itemId: string; category: string }): TriageOutcomeRow => ({
		disposition: null,
		storyId: null,
		reachedMaterial: false,
		reachedFinal: false,
		reachedMustKnow: false,
		...over,
	});

	it("counts a LOW item the Curator promoted", () => {
		const funnel = buildTriageFunnel([
			row({ itemId: "a", category: "LOW", disposition: "CANDIDATE", storyId: "s1" }),
			row({ itemId: "b", category: "NORMAL", disposition: "CANDIDATE", storyId: "s2" }),
		]);
		expect(funnel.lowLeakage.candidate).toBe(1);
		expect(funnel.recall.candidate).toBeCloseTo(0.5);
	});

	it("counts a Must Know story that would have been lost", () => {
		const funnel = buildTriageFunnel([
			row({
				itemId: "a",
				category: "LOW",
				disposition: "CANDIDATE",
				storyId: "s1",
				reachedMaterial: true,
				reachedFinal: true,
				reachedMustKnow: true,
			}),
		]);
		expect(funnel.lowLeakage.mustKnowStories).toBe(1);
		expect(funnel.recall.mustKnow).toBe(0);
		expect(funnel.lostMustKnowStoryIds).toEqual(["s1"]);
	});

	it("does not count a story as lost when any of its items survives", () => {
		// Five outlets, four duplicates: dropping the duplicates loses nothing, and
		// measuring this at item level would overstate the damage.
		const funnel = buildTriageFunnel([
			row({ itemId: "a", category: "LOW", disposition: "DUPLICATE", storyId: "s1", reachedFinal: true, reachedMustKnow: true }),
			row({ itemId: "b", category: "PRIORITY", disposition: "CANDIDATE", storyId: "s1", reachedFinal: true, reachedMustKnow: true }),
		]);
		expect(funnel.lowLeakage.mustKnowStories).toBe(0);
		expect(funnel.recall.mustKnow).toBe(1);
	});

	it("reports items that were predicted but never decided", () => {
		const funnel = buildTriageFunnel([row({ itemId: "a", category: "LOW" })]);
		expect(funnel.undecided).toBe(1);
	});

	it("returns null recall rather than a flattering 1 when nothing reached a stage", () => {
		const funnel = buildTriageFunnel([row({ itemId: "a", category: "NORMAL", disposition: "IRRELEVANT" })]);
		expect(funnel.recall.mustKnow).toBeNull();
		expect(funnel.recall.candidate).toBeNull();
	});

	it("refuses routing readiness while a Must Know story would be lost", () => {
		const funnel = buildTriageFunnel([
			row({ itemId: "a", category: "LOW", disposition: "CANDIDATE", storyId: "s1", reachedMustKnow: true }),
		]);
		const readiness = assessRoutingReadiness([funnel, funnel, funnel, funnel, funnel]);
		expect(readiness.ready).toBe(false);
		expect(readiness.reasons.join(" ")).toContain("Must Know recall must be 100%");
	});

	it("refuses routing readiness on insufficient days even when recall is perfect", () => {
		const clean = buildTriageFunnel([
			row({ itemId: "a", category: "PRIORITY", disposition: "CANDIDATE", storyId: "s1", reachedMustKnow: true, reachedFinal: true }),
		]);
		expect(assessRoutingReadiness([clean]).ready).toBe(false);
		expect(assessRoutingReadiness(Array(ROUTING_GATE.requiredDays).fill(clean)).ready).toBe(true);
	});
});

/*
 * Shadow mode, pinned structurally.
 *
 * The value of every number above depends on triage having had no influence on
 * the outcome it is measured against. A comment saying so is not enough, so the
 * tree is walked: nothing under src/curator, src/editor, src/agent-tools or
 * src/collectors may reach the triage module, and the pipeline may write it but
 * never read it back.
 */
describe("triage stays out of the decision path", () => {
	const SRC = fileURLToPath(new URL("../src", import.meta.url));
	const SOURCE_EXT = /\.(ts|tsx)$/;
	const FORBIDDEN_DIRS = ["curator", "editor", "agent-tools", "collectors", "validator", "research"];

	async function walk(dir: string): Promise<string[]> {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return [];
		}
		const out: string[] = [];
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) out.push(...(await walk(full)));
			else if (SOURCE_EXT.test(entry.name)) out.push(full);
		}
		return out;
	}

	it("is unreachable from any stage that decides anything", async () => {
		const offenders: string[] = [];
		for (const dir of FORBIDDEN_DIRS) {
			for (const file of await walk(join(SRC, dir))) {
				const text = await readFile(file, "utf8");
				if (/from\s+["'][^"']*\/(triage)\//.test(text) || /item_triage/.test(text)) {
					offenders.push(relative(SRC, file));
				}
			}
		}
		expect(offenders, `triage reached from the decision path: ${offenders.join(", ")}`).toEqual([]);
	});

	it("is written by the pipeline and never read back by it", async () => {
		const files = await walk(join(SRC, "pipeline"));
		const readers: string[] = [];
		for (const file of files) {
			const text = await readFile(file, "utf8");
			// saveTriage is the only triage symbol the pipeline may name.
			if (/fetchTriageOutcomes|buildTriageFunnel|item_triage/.test(text)) readers.push(relative(SRC, file));
		}
		expect(readers).toEqual([]);
	});

	it("exposes no read path from src/db/triage.ts", async () => {
		const text = await readFile(join(SRC, "db", "triage.ts"), "utf8");
		expect(text).not.toMatch(/\bselect\b/i);
	});
});
