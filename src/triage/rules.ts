import type { InterestsConfig, WatchlistsConfig } from "../config/schema.ts";
import type { TriageCategory, TriageInput, TriageResult } from "./types.ts";

/*
 * The deterministic rules. No model, by design.
 *
 * Adding a cheap LLM here would mean a new model dependency, a new failure
 * mode and a new cost, bought before there is any evidence that structure alone
 * is insufficient. The structure available is not nothing: which source an item
 * came from, whether it names a watched repo or asset, whether a release or an
 * advisory is being announced, and which of the reader's topics it matches.
 * Shadow mode will say how far that gets. If UNCERTAIN turns out to dominate
 * and the misses concentrate there, that is the evidence for spending a model
 * on UNCERTAIN only -- and it will be a much smaller, better-specified problem
 * than "classify everything".
 *
 * Two rules about the rules:
 *
 * 1. LOW is a claim, not a shrug. A rule may only return LOW when something
 *    positively indicates business/PR noise. Everything the rules cannot read
 *    is UNCERTAIN, because a future filter would drop LOW and the one thing
 *    that must never happen is an unrecognised technical release falling into
 *    the drop bucket by default.
 *
 * 2. The reader profile is a prior, not a whitelist. A security advisory, a
 *    major outage or a watched entity is PRIORITY whether or not a topic names
 *    it, and no rule may return LOW for one.
 */

/** Order matters: the first rule that fires wins, and PRIORITY rules come first. */
export interface TriageRules {
	classify(input: TriageInput): TriageResult;
}

function haystack(input: TriageInput): string {
	return `${input.title}\n${input.summary}`.toLowerCase();
}

function anyOf(text: string, needles: readonly string[]): string | undefined {
	return needles.find((n) => text.includes(n));
}

/**
 * Word-boundary match, for needles short enough to appear inside other words.
 * "sol" must not match "solution"; "eth" must not match "ethernet".
 */
function anyWord(text: string, needles: readonly string[]): string | undefined {
	return needles.find((n) => new RegExp(`(?:^|[^a-z0-9])${escapeRe(n)}(?:[^a-z0-9]|$)`).test(text));
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------------ signals */

/**
 * A security problem being disclosed. PRIORITY regardless of topic match: the
 * reader's own profile says a serious vulnerability reaches them whichever
 * topics they listed, and the prompt both agents read says the same.
 */
const SECURITY_TERMS = [
	"cve-",
	"vulnerability",
	"exploit",
	"zero-day",
	"0-day",
	"security advisory",
	"rce",
	"privilege escalation",
	"supply chain attack",
	"backdoor",
	"data breach",
	"ransomware",
	"malware",
	"patched a",
	"security update",
];

/** A thing shipping, as opposed to a thing being discussed. */
const RELEASE_TERMS = [
	"release",
	"released",
	"releases",
	"launch",
	"launches",
	"announcing",
	"now available",
	"general availability",
	"open-sourced",
	"open sources",
	"open-weight",
	"open weights",
	"v1.",
	"v2.",
	"v3.",
	"rc1",
	"ga release",
];

/**
 * The AI engineering vocabulary from PART G of the design note. These are the
 * terms whose titles are least dramatic and whose value to this reader is
 * highest, which is exactly the combination a naive filter gets wrong.
 */
const AI_ENGINEERING_TERMS = [
	"vllm",
	"sglang",
	"rocm",
	"cuda",
	"mlx",
	"llama.cpp",
	"ollama",
	"quantization",
	"quantized",
	"gguf",
	"awq",
	"gptq",
	"inference engine",
	"inference server",
	"kv cache",
	"speculative decoding",
	"flash attention",
	"tensor parallel",
	"model context protocol",
	"mcp server",
	"coding agent",
	"agent runtime",
	"tool calling",
	"function calling",
	"fine-tune",
	"fine-tuning",
	"lora",
	"open-weight model",
	"context window",
	"tokens per second",
	"throughput",
	"triton",
	"tensorrt",
	"gpu cluster",
	"h100",
	"h200",
	"mi300",
	"tpu",
];

const AI_MODEL_TERMS = [
	"claude",
	"gpt-",
	"gemini",
	"llama",
	"qwen",
	"deepseek",
	"mistral",
	"hermes",
	"phi-",
	"grok",
	"kimi",
	"glm-",
];

/** Crypto/Web3 substance, as opposed to price commentary. */
const CRYPTO_INFRA_TERMS = [
	"protocol upgrade",
	"hard fork",
	"soft fork",
	"mainnet",
	"testnet",
	"layer 2",
	"rollup",
	"bridge exploit",
	"stablecoin",
	"defi",
	"rwa",
	"real-world asset",
	"staking",
	"validator",
	"smart contract",
	"eip-",
	"bip-",
	"erc-",
	"tokenomics",
	"custody",
	"etf approval",
];

/**
 * Business and PR. The only bucket a future filter would consider dropping, so
 * a term only belongs here if its presence genuinely signals "this is about
 * money moving, not about a thing being built".
 */
const BUSINESS_TERMS = [
	"raises $",
	"raises €",
	"funding round",
	"series a",
	"series b",
	"series c",
	"series d",
	"seed round",
	"valuation",
	"valued at",
	"ipo",
	"goes public",
	"acquisition",
	"acquires",
	"merger",
	"stake in",
	"investment in",
	"shares rise",
	"shares fall",
	"stock jumps",
	"stock slides",
	"market cap",
	"earnings call",
	"quarterly results",
	"appoints",
	"steps down",
	"names new ceo",
	"hires",
	"in an interview",
	"told reuters",
	"told bloomberg",
	"op-ed",
	"opinion:",
];

/** Sources whose output is primary: the thing itself, not coverage of it. */
const PRIMARY_SOURCE_TYPES = new Set(["github", "arxiv", "semantic-scholar", "sec", "fred"]);

/* -------------------------------------------------------------------- rules */

export interface BuildRulesOptions {
	interests: InterestsConfig;
	watchlists: WatchlistsConfig;
	/** Topics at or above this weight count as a strong reader signal. */
	highWeightThreshold?: number;
}

const DEFAULT_HIGH_WEIGHT = 0.8;

export function buildTriageRules(opts: BuildRulesOptions): TriageRules {
	const { interests, watchlists } = opts;
	const highWeight = opts.highWeightThreshold ?? DEFAULT_HIGH_WEIGHT;

	/** topic -> its needles, lowercased once. */
	const topics = interests.topics.map((t) => ({
		id: t.id,
		weight: t.weight,
		needles: [...t.keywords, ...t.aliases, t.label].map((k) => k.toLowerCase()).filter((k) => k.length > 1),
	}));

	const watchedRepos = watchlists.github_repos.map((r) => r.toLowerCase());
	// Both halves: a title may name "vllm-project/vllm" or just "vLLM".
	const watchedRepoNames = watchedRepos.flatMap((r) => r.split("/")).filter((n) => n.length > 2);
	const watchedTickers = watchlists.sec_companies.map((c) => c.ticker.toLowerCase());
	const watchedCompanies = watchlists.sec_companies.map((c) => c.name.toLowerCase());
	const watchedAssets = watchlists.crypto_assets.flatMap((a) => [a.id.toLowerCase(), a.symbol.toLowerCase()]);

	function matchedTopics(text: string): { ids: string[]; maxWeight: number } {
		const ids: string[] = [];
		let maxWeight = 0;
		for (const topic of topics) {
			if (topic.needles.some((n) => (n.length <= 4 ? anyWord(text, [n]) : text.includes(n)))) {
				ids.push(topic.id);
				maxWeight = Math.max(maxWeight, topic.weight);
			}
		}
		return { ids, maxWeight };
	}

	function result(
		input: TriageInput,
		category: TriageCategory,
		ruleId: string,
		reason: string,
		relevanceHint: number,
		topicIds: string[],
	): TriageResult {
		return { itemId: input.itemId, category, ruleId, reason, relevanceHint, topicIds };
	}

	return {
		classify(input: TriageInput): TriageResult {
			const text = haystack(input);
			const { ids: topicIds, maxWeight } = matchedTopics(text);

			/* ---- PRIORITY: things the reader has explicitly asked to see ---- */

			const securityHit = anyOf(text, SECURITY_TERMS);
			if (securityHit) {
				return result(
					input,
					"PRIORITY",
					"security-advisory",
					`security disclosure signal ("${securityHit}"); reaches the reader whatever the topic match`,
					0.9,
					topicIds,
				);
			}

			// A watched GitHub repo publishing a release or tag is the single
			// strongest structural signal available: the reader named the repo and
			// the collector only emits it when something was actually cut.
			if (input.sourceType === "github") {
				const repo = String(input.metadata["repo"] ?? "").toLowerCase();
				const isWatched = watchedRepos.includes(repo) || anyOf(text, watchedRepoNames) !== undefined;
				if (isWatched) {
					return result(
						input,
						"PRIORITY",
						"watched-repo-release",
						`watched repository${repo ? ` ${repo}` : ""} published a release or tag`,
						0.95,
						topicIds,
					);
				}
			}

			const assetHit = anyWord(text, watchedAssets);
			if (assetHit && anyOf(text, CRYPTO_INFRA_TERMS)) {
				return result(
					input,
					"PRIORITY",
					"watched-asset-infrastructure",
					`watched asset "${assetHit}" with a protocol/infrastructure signal, not price commentary`,
					0.85,
					topicIds,
				);
			}

			const entityHit = anyOf(text, [...watchedCompanies]) ?? anyWord(text, watchedTickers);
			if (entityHit && anyOf(text, RELEASE_TERMS)) {
				return result(
					input,
					"PRIORITY",
					"watched-entity-release",
					`explicitly watched entity "${entityHit}" shipping something`,
					0.85,
					topicIds,
				);
			}

			const engineeringHit = anyOf(text, AI_ENGINEERING_TERMS);
			if (engineeringHit) {
				const shipping = anyOf(text, RELEASE_TERMS);
				return result(
					input,
					shipping ? "PRIORITY" : "NORMAL",
					shipping ? "ai-engineering-release" : "ai-engineering-mention",
					`AI engineering signal ("${engineeringHit}")${shipping ? ` with a release signal ("${shipping}")` : ""}`,
					shipping ? 0.9 : 0.65,
					topicIds,
				);
			}

			const modelHit = anyOf(text, AI_MODEL_TERMS);
			if (modelHit && anyOf(text, RELEASE_TERMS)) {
				return result(
					input,
					"PRIORITY",
					"model-release",
					`named model "${modelHit}" with a release signal`,
					0.9,
					topicIds,
				);
			}

			if (maxWeight >= highWeight && PRIMARY_SOURCE_TYPES.has(input.sourceType)) {
				return result(
					input,
					"PRIORITY",
					"high-weight-primary-source",
					`primary source (${input.sourceType}) matching a high-weight topic (${maxWeight.toFixed(2)})`,
					0.8,
					topicIds,
				);
			}

			/* ---- LOW: a positive claim that this is business/PR noise ---- */

			const businessHit = anyOf(text, BUSINESS_TERMS);
			if (businessHit) {
				// Still not LOW if the reader's own profile matches it strongly: a
				// funding round for a project they track is a different thing from a
				// generic raise, and this is a prior, not a whitelist, in both
				// directions.
				if (maxWeight >= highWeight) {
					return result(
						input,
						"NORMAL",
						"business-but-tracked",
						`business signal ("${businessHit}") but a high-weight topic matches (${maxWeight.toFixed(2)})`,
						0.5,
						topicIds,
					);
				}
				return result(
					input,
					"LOW",
					"business-noise",
					`business/PR signal ("${businessHit}") with no strong reader topic`,
					0.15,
					topicIds,
				);
			}

			/* ---- NORMAL: matches an interest at all ---- */

			if (topicIds.length > 0) {
				return result(
					input,
					"NORMAL",
					"topic-match",
					`matches ${topicIds.length} reader topic(s), max weight ${maxWeight.toFixed(2)}`,
					Math.min(0.75, 0.3 + maxWeight * 0.4),
					topicIds,
				);
			}

			if (anyOf(text, CRYPTO_INFRA_TERMS)) {
				return result(
					input,
					"NORMAL",
					"crypto-infrastructure",
					"crypto/web3 infrastructure signal without a topic match",
					0.5,
					topicIds,
				);
			}

			if (PRIMARY_SOURCE_TYPES.has(input.sourceType)) {
				return result(
					input,
					"NORMAL",
					"primary-source",
					`primary source (${input.sourceType}) with no topic match`,
					0.4,
					topicIds,
				);
			}

			/* ---- UNCERTAIN: the honest answer ---- */

			return result(
				input,
				"UNCERTAIN",
				"no-rule-matched",
				"no rule matched; deliberately not LOW, because an unrecognised technical release must never land in the drop bucket by default",
				0.3,
				topicIds,
			);
		},
	};
}
