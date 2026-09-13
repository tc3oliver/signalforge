/*
 * Development seed for the web reader.
 *
 * Writes a small but complete three-day history — runs, collections, items,
 * decisions, a story that evolves across all three days, facts, briefs, a
 * rejected draft and a signal in each lifecycle state — so every route renders
 * something real without waiting for a live pipeline run.
 *
 * It writes into its own lineage (default: "web-dev"), never into "default", so
 * running it can never contaminate a production ledger. Run with:
 *
 *   pnpm exec tsx --env-file=.env web/scripts/seed-dev.ts
 *   DI_LINEAGE=web-dev pnpm run web:start
 */
import { createSql, assertReachable } from "../../src/db/client.ts";
import { saveBrief, saveDraft } from "../../src/db/briefs.ts";
import { recordCollectionRun, upsertSourceConfig } from "../../src/db/collector-health.ts";
import { upsertFacts } from "../../src/db/facts.ts";
import { upsertNormalizedItems, upsertRawItems } from "../../src/db/items.ts";
import { saveMaterials } from "../../src/db/materials.ts";
import { finishAgentRun, recordAttempt, startAgentRun, upsertRun } from "../../src/db/runs.ts";
import { observeSignal } from "../../src/db/signals.ts";
import { upsertDecisions, upsertStoryRow } from "../../src/db/stories.ts";
import { purgeLineage } from "../../src/db/test-support.ts";
import type { CollectedItem, CollectorResult } from "../../src/collectors/types.ts";
import type { DailyBrief } from "../../src/schemas/brief.ts";
import type { ItemDecision } from "../../src/schemas/decision.ts";
import type { NormalizedItem } from "../../src/schemas/item.ts";

const LINEAGE = process.env["DI_SEED_LINEAGE"]?.trim() || "web-dev";
const DATES = ["2026-09-11", "2026-09-12", "2026-09-13"] as const;

/** Collector ids are prefixed so this seed can never collide with a real one. */
const COLLECTORS = [
	{ collectorId: "seed-rss-frontier", sourceType: "rss", enabled: true, requiredSecrets: [] },
	{ collectorId: "seed-hn-front", sourceType: "hackernews", enabled: true, requiredSecrets: [] },
	{ collectorId: "seed-coingecko", sourceType: "coingecko", enabled: true, requiredSecrets: [] },
	{
		collectorId: "seed-reddit-ml",
		sourceType: "reddit",
		enabled: false,
		requiredSecrets: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"],
	},
] as const;

interface SeedItem {
	id: string;
	collector: string;
	sourceType: NormalizedItem["sourceType"];
	sourceName: string;
	title: string;
	summary: string;
	url?: string;
	publishedAt: string;
	fetchedAt: string;
}

function at(date: string, time: string): string {
	return `${date}T${time}.000Z`;
}

const ITEMS: SeedItem[] = [
	{
		id: "it-anthropic-ctx",
		collector: "seed-rss-frontier",
		sourceType: "rss",
		sourceName: "Frontier Model Digest",
		title: "Anthropic ships a 1M-token context window for Claude",
		summary:
			"The long-context tier moves out of preview, with pricing that scales past 200K tokens.",
		url: "https://example.invalid/anthropic-1m-context",
		publishedAt: at("2026-09-13", "04:10:00"),
		fetchedAt: at("2026-09-13", "05:40:00"),
	},
	{
		id: "it-inference-price",
		collector: "seed-rss-frontier",
		sourceType: "rss",
		sourceName: "Frontier Model Digest",
		title: "Serving costs for open-weight models fall again",
		summary: "Three providers cut per-token prices for 70B-class models in the same week.",
		url: "https://example.invalid/inference-price-war",
		publishedAt: at("2026-09-13", "03:05:00"),
		fetchedAt: at("2026-09-13", "05:41:00"),
	},
	{
		id: "it-rust-release",
		collector: "seed-hn-front",
		sourceType: "hackernews",
		sourceName: "Hacker News",
		// Deliberately hostile: this must render as literal text, never as markup.
		title: '<img src=x onerror="alert(1)"> Rust 1.94 released with stable async closures',
		summary: "Async closures stabilise; the borrow checker gets a new diagnostic for captures.",
		url: "https://example.invalid/rust-1-94",
		publishedAt: at("2026-09-13", "02:00:00"),
		fetchedAt: at("2026-09-13", "05:42:00"),
	},
	{
		id: "it-oss-license",
		collector: "seed-hn-front",
		sourceType: "hackernews",
		sourceName: "Hacker News",
		title: "Major database vendor relicenses its core engine",
		summary: "The BSL switch lands with a four-year conversion to Apache 2.0.",
		url: "https://example.invalid/relicense-day-one",
		publishedAt: at("2026-09-11", "07:30:00"),
		fetchedAt: at("2026-09-11", "05:20:00"),
	},
	{
		id: "it-oss-license-fork",
		collector: "seed-hn-front",
		sourceType: "hackernews",
		sourceName: "Hacker News",
		title: "Community fork of the relicensed engine reaches 5,000 stars",
		summary: "A foundation-backed fork forms within 48 hours of the licence change.",
		url: "https://example.invalid/relicense-fork",
		publishedAt: at("2026-09-12", "09:15:00"),
		fetchedAt: at("2026-09-12", "05:25:00"),
	},
	{
		id: "it-oss-license-reversal",
		collector: "seed-rss-frontier",
		sourceType: "rss",
		sourceName: "Frontier Model Digest",
		title: "Vendor walks back the relicensing after customer pressure",
		summary: "The engine returns to Apache 2.0 with a written commitment not to repeat the change.",
		url: "https://example.invalid/relicense-reversal",
		publishedAt: at("2026-09-13", "06:20:00"),
		fetchedAt: at("2026-09-13", "05:45:00"),
	},
	{
		id: "it-arxiv-distill",
		collector: "seed-rss-frontier",
		sourceType: "arxiv",
		sourceName: "arXiv cs.LG",
		title: "Distillation with verifier feedback closes most of the gap to the teacher",
		summary: "A 7B student reaches 94% of teacher accuracy on held-out reasoning benchmarks.",
		url: "https://example.invalid/arxiv-verifier-distillation",
		publishedAt: at("2026-09-12", "22:00:00"),
		fetchedAt: at("2026-09-13", "05:46:00"),
	},
	{
		id: "it-btc-print",
		collector: "seed-coingecko",
		sourceType: "coingecko",
		sourceName: "CoinGecko",
		title: "Bitcoin spot price snapshot",
		summary: "Daily close snapshot used as the structured fact source.",
		url: "https://example.invalid/coingecko-btc",
		publishedAt: at("2026-09-13", "00:05:00"),
		fetchedAt: at("2026-09-13", "05:30:00"),
	},
	{
		id: "it-cpi-print",
		collector: "seed-rss-frontier",
		sourceType: "fred",
		sourceName: "FRED",
		title: "US CPI year-over-year print for August",
		summary: "Headline CPI comes in below consensus for the second consecutive month.",
		url: "https://example.invalid/fred-cpi",
		publishedAt: at("2026-09-13", "01:30:00"),
		fetchedAt: at("2026-09-13", "05:31:00"),
	},
	{
		id: "it-chip-capex",
		collector: "seed-rss-frontier",
		sourceType: "rss",
		sourceName: "Frontier Model Digest",
		title: "Two hyperscalers raise datacentre capex guidance",
		summary: "Combined 2027 guidance rises by double digits, both citing inference demand.",
		url: "https://example.invalid/capex-guidance",
		publishedAt: at("2026-09-13", "04:45:00"),
		fetchedAt: at("2026-09-13", "05:47:00"),
	},
	{
		id: "it-foundry-yield",
		collector: "seed-rss-frontier",
		sourceType: "rss",
		sourceName: "Frontier Model Digest",
		title: "Leading foundry reports improved yields on its 2nm node",
		summary: "Yield improvement is credited to a revised backside power delivery step.",
		url: "https://example.invalid/foundry-yield",
		publishedAt: at("2026-09-13", "03:40:00"),
		fetchedAt: at("2026-09-13", "05:48:00"),
	},
	{
		id: "it-dupe-anthropic",
		collector: "seed-hn-front",
		sourceType: "hackernews",
		sourceName: "Hacker News",
		title: "Claude now supports one million tokens of context",
		summary: "Aggregator write-up of the same announcement.",
		url: "https://example.invalid/hn-anthropic-context",
		publishedAt: at("2026-09-13", "04:40:00"),
		fetchedAt: at("2026-09-13", "05:49:00"),
	},
	{
		id: "it-noise-gadget",
		collector: "seed-rss-frontier",
		sourceType: "rss",
		sourceName: "Frontier Model Digest",
		title: "Hands-on with a new mechanical keyboard",
		summary: "A review of switch feel and firmware quirks.",
		// Deliberately unusable: a javascript: URL must never reach an href.
		url: "javascript:alert(document.domain)",
		publishedAt: at("2026-09-13", "02:20:00"),
		fetchedAt: at("2026-09-13", "05:50:00"),
	},
	{
		id: "it-late-regulator",
		collector: "seed-rss-frontier",
		sourceType: "rss",
		sourceName: "Frontier Model Digest",
		title: "Regulator opens inquiry into frontier model training data",
		summary: "The inquiry names three labs and requests dataset provenance records.",
		url: "https://example.invalid/regulator-inquiry",
		publishedAt: at("2026-09-13", "13:10:00"),
		// After the morning run: this is what drives "New Since Morning".
		fetchedAt: at("2026-09-13", "14:05:00"),
	},
	{
		id: "it-late-outage",
		collector: "seed-hn-front",
		sourceType: "hackernews",
		sourceName: "Hacker News",
		title: "Multi-hour outage at a major inference provider",
		summary: "Status page confirms a control-plane failure affecting three regions.",
		url: "https://example.invalid/provider-outage",
		publishedAt: at("2026-09-13", "12:40:00"),
		fetchedAt: at("2026-09-13", "14:07:00"),
	},
	{
		id: "it-late-minor",
		collector: "seed-hn-front",
		sourceType: "hackernews",
		sourceName: "Hacker News",
		title: "Someone rewrote grep in a new systems language",
		summary: "Benchmarks are contested in the comments.",
		url: "https://example.invalid/grep-rewrite",
		publishedAt: at("2026-09-13", "11:00:00"),
		fetchedAt: at("2026-09-13", "14:09:00"),
	},
];

interface SeedStory {
	storyId: string;
	title: string;
	section: DailyBrief["stories"][number]["section"];
	mustKnow: boolean;
	changeType: string;
	status: "OPEN" | "RESOLVED" | "DORMANT";
	itemIds: string[];
	primaryIds: string[];
	factRefs: string[];
	reason: string;
	importance: number;
	novelty: number;
	confidence: number;
	whatHappened: string;
	whyItMatters: string;
	whatChanged: string;
	impact: string;
	briefConfidence: "HIGH" | "MEDIUM" | "LOW";
}

const DAY3_STORIES: SeedStory[] = [
	{
		storyId: "st-context-window",
		title: "Anthropic ships a 1M-token context window",
		section: "MUST_KNOW",
		mustKnow: true,
		changeType: "NEW",
		status: "OPEN",
		itemIds: ["it-anthropic-ctx", "it-dupe-anthropic"],
		primaryIds: ["it-anthropic-ctx"],
		factRefs: [],
		reason: "第一手公告，且改變長脈絡工作流的成本結構。",
		importance: 0.92,
		novelty: 0.81,
		confidence: 0.88,
		whatHappened: "Anthropic 將 100 萬 token 脈絡視窗移出預覽，並公布超過 20 萬 token 後的計價級距。",
		whyItMatters: "整份程式庫或整年度文件可以一次送入模型，原本需要檢索流程的工作改為直接讀取。",
		whatChanged: "從預覽轉為正式可用，並首次揭露長脈絡的價格曲線。",
		impact: "以檢索為主的產品必須重新評估其架構前提。",
		briefConfidence: "HIGH",
	},
	{
		storyId: "st-inference-price",
		title: "Open-weight serving prices fall again",
		section: "AI_LLM",
		mustKnow: false,
		changeType: "UPDATE",
		status: "OPEN",
		itemIds: ["it-inference-price"],
		primaryIds: ["it-inference-price"],
		factRefs: [],
		reason: "同一週三家供應商同步降價，屬於延續性的價格趨勢。",
		importance: 0.64,
		novelty: 0.45,
		confidence: 0.72,
		whatHappened: "三家供應商在同一週調降 70B 級模型的每 token 價格。",
		whyItMatters: "推論成本是自架與 API 之間的主要取捨點。",
		whatChanged: "降價幅度首次同時出現在三家主要供應商。",
		impact: "自架推論的成本優勢持續縮小。",
		briefConfidence: "MEDIUM",
	},
	{
		storyId: "st-distillation",
		title: "Verifier-feedback distillation closes the teacher gap",
		section: "RESEARCH",
		mustKnow: false,
		changeType: "NEW",
		status: "OPEN",
		itemIds: ["it-arxiv-distill"],
		primaryIds: ["it-arxiv-distill"],
		factRefs: [],
		reason: "方法簡單且結果可複現，對小模型部署有直接影響。",
		importance: 0.58,
		novelty: 0.77,
		confidence: 0.6,
		whatHappened: "一篇論文報告 7B 學生模型在保留推理基準上達到教師模型 94% 的準確率。",
		whyItMatters: "若能複現，邊緣部署的能力天花板會被抬高。",
		whatChanged: "驗證器回饋取代了單純的輸出模仿。",
		impact: "小模型的適用範圍擴大，但仍待第三方複現。",
		briefConfidence: "LOW",
	},
	{
		storyId: "st-oss-license",
		title: "Database vendor reverses its relicensing",
		section: "DEVELOPER_OSS",
		mustKnow: true,
		changeType: "REVERSAL",
		status: "RESOLVED",
		itemIds: ["it-oss-license", "it-oss-license-fork", "it-oss-license-reversal"],
		primaryIds: ["it-oss-license-reversal"],
		factRefs: [],
		reason: "三天前開始的授權爭議以完全回退收場，屬於明確的反轉。",
		importance: 0.86,
		novelty: 0.7,
		confidence: 0.9,
		whatHappened: "廠商在客戶壓力下撤回 BSL 授權變更，核心引擎回到 Apache 2.0。",
		whyItMatters: "這是近年少數由使用者壓力直接逆轉的授權決定。",
		whatChanged: "從 9/11 的授權變更、9/12 的社群分叉，到今天完全回退。",
		impact: "分叉的動能可能因此消散，但治理承諾成為新的觀察點。",
		briefConfidence: "HIGH",
	},
	{
		storyId: "st-btc-level",
		title: "Bitcoin holds its range into the CPI print",
		section: "CRYPTO_MARKET",
		mustKnow: false,
		changeType: "NO_MATERIAL_CHANGE",
		status: "OPEN",
		itemIds: ["it-btc-print"],
		primaryIds: ["it-btc-print"],
		factRefs: ["fact-btc-usd"],
		reason: "價格本身無重大變化，但作為總經敘事的參照點仍需記錄。",
		importance: 0.42,
		novelty: 0.2,
		confidence: 0.95,
		whatHappened: "比特幣在 CPI 公布前維持區間震盪。",
		whyItMatters: "作為風險資產的定價參照，其靜止本身即是訊號。",
		whatChanged: "波動度較前一週下降。",
		impact: "短線方向仍取決於總經數據。",
		briefConfidence: "HIGH",
	},
	{
		storyId: "st-cpi-print",
		title: "CPI undershoots consensus for a second month",
		section: "MACRO",
		mustKnow: false,
		changeType: "CONFIRMATION",
		status: "OPEN",
		itemIds: ["it-cpi-print"],
		primaryIds: ["it-cpi-print"],
		factRefs: ["fact-cpi-yoy"],
		reason: "連續第二個月低於市場預期，確認了既有的通膨降溫路徑。",
		importance: 0.78,
		novelty: 0.35,
		confidence: 0.93,
		whatHappened: "八月整體 CPI 年增率低於市場共識。",
		whyItMatters: "連續兩個月的低於預期會改變利率路徑的定價。",
		whatChanged: "由單月意外轉為可辨識的趨勢。",
		impact: "利率敏感的資產重新定價。",
		briefConfidence: "HIGH",
	},
	{
		storyId: "st-capex",
		title: "Hyperscalers raise datacentre capex guidance",
		section: "COMPANIES",
		mustKnow: false,
		changeType: "ESCALATION",
		status: "OPEN",
		itemIds: ["it-chip-capex"],
		primaryIds: ["it-chip-capex"],
		factRefs: ["fact-capex-delta"],
		reason: "兩家同時上修且理由一致，屬於強度升高而非單一事件。",
		importance: 0.8,
		novelty: 0.55,
		confidence: 0.84,
		whatHappened: "兩家超大規模業者同步上修 2027 年資本支出指引。",
		whyItMatters: "資本支出指引是推論需求最難造假的前瞻指標。",
		whatChanged: "上修幅度為雙位數，且兩家給出相同理由。",
		impact: "供應鏈的訂單能見度延長。",
		briefConfidence: "HIGH",
	},
	{
		storyId: "st-foundry-yield",
		title: "Foundry reports better 2nm yields",
		section: "COMPANIES",
		mustKnow: false,
		changeType: "UPDATE",
		status: "OPEN",
		itemIds: ["it-foundry-yield"],
		primaryIds: ["it-foundry-yield"],
		factRefs: [],
		reason: "良率改善屬於既有製程進度的延續更新。",
		importance: 0.52,
		novelty: 0.4,
		confidence: 0.66,
		whatHappened: "領先晶圓代工廠回報 2nm 節點良率改善。",
		whyItMatters: "良率決定先進節點的實際可得產能。",
		whatChanged: "改善歸因於背面供電步驟的調整。",
		impact: "2027 年的產能規劃風險下降。",
		briefConfidence: "MEDIUM",
	},
	{
		storyId: "st-rust-release",
		title: "Rust 1.94 stabilises async closures",
		section: "DEVELOPER_OSS",
		mustKnow: false,
		changeType: "NEW",
		status: "OPEN",
		itemIds: ["it-rust-release"],
		primaryIds: ["it-rust-release"],
		factRefs: [],
		reason: "語言層級的穩定化，影響既有 async 程式碼的寫法。",
		importance: 0.5,
		novelty: 0.62,
		confidence: 0.9,
		whatHappened: "Rust 1.94 將 async closures 穩定化。",
		whyItMatters: "非同步程式碼長期缺少的組合能力補齊。",
		whatChanged: "從 nightly 進入穩定版。",
		impact: "既有的 workaround 可逐步移除。",
		briefConfidence: "HIGH",
	},
];

/** Earlier days for the story that evolves across the whole window. */
const EARLIER_STORIES: Record<string, SeedStory[]> = {
	"2026-09-11": [
		{
			...DAY3_STORIES[3]!,
			title: "Database vendor relicenses its core engine",
			changeType: "NEW",
			status: "OPEN",
			itemIds: ["it-oss-license"],
			primaryIds: ["it-oss-license"],
			reason: "核心引擎改採 BSL，影響所有下游散布者。",
			importance: 0.74,
			novelty: 0.9,
			confidence: 0.8,
			whatHappened: "廠商宣布核心引擎改採 BSL，四年後轉為 Apache 2.0。",
			whatChanged: "授權首次由開源轉為來源可得。",
			impact: "下游散布者必須重新檢視合規性。",
		},
		{
			...DAY3_STORIES[5]!,
			storyId: "st-rates-path",
			title: "Rate path pricing shifts after the July print",
			section: "MACRO",
			mustKnow: true,
			changeType: "NEW",
			itemIds: ["it-cpi-print"],
			primaryIds: ["it-cpi-print"],
			factRefs: [],
			reason: "市場對利率路徑的定價出現明顯位移。",
			whatHappened: "七月數據公布後，市場對降息時點的定價前移。",
			whatChanged: "定價位移的幅度超過前三個月的區間。",
		},
	],
	"2026-09-12": [
		{
			...DAY3_STORIES[3]!,
			title: "Community fork of the relicensed engine forms",
			changeType: "ESCALATION",
			status: "OPEN",
			itemIds: ["it-oss-license", "it-oss-license-fork"],
			primaryIds: ["it-oss-license-fork"],
			reason: "基金會支持的分叉在 48 小時內成形，爭議升級。",
			importance: 0.81,
			novelty: 0.66,
			confidence: 0.85,
			whatHappened: "基金會支持的分叉在授權變更後 48 小時內成形並取得 5,000 星。",
			whatChanged: "由單方公告升級為社群層級的分裂。",
			impact: "生態系面臨實質分流風險。",
		},
		{
			...DAY3_STORIES[1]!,
			storyId: "st-inference-price",
			changeType: "NEW",
			reason: "首次觀察到跨供應商的同步降價。",
			importance: 0.6,
		},
	],
};

async function main(): Promise<void> {
	const sql = createSql();
	await assertReachable(sql);
	console.log(`[seed] lineage=${LINEAGE}`);
	// Idempotent: a re-run replaces the seed rather than layering onto it.
	await purgeLineage(sql, LINEAGE);

	for (const collector of COLLECTORS) {
		await upsertSourceConfig(sql, {
			collectorId: collector.collectorId,
			sourceType: collector.sourceType,
			enabled: collector.enabled,
			requiredSecrets: [...collector.requiredSecrets],
			config: { window: "24h", seeded: true },
		});
	}

	const collected: CollectedItem[] = ITEMS.map((item) => ({
		sourceType: item.sourceType,
		sourceName: item.sourceName,
		externalId: `seed:${item.id}`,
		title: item.title,
		summary: item.summary,
		...(item.url === undefined ? {} : { url: item.url }),
		publishedAt: item.publishedAt,
		metadata: {},
		trust: "UNTRUSTED_EXTERNAL_CONTENT" as const,
		raw: { externalId: `seed:${item.id}`, body: { seeded: true }, fetchedAt: item.fetchedAt },
	}));

	for (const [index, date] of DATES.entries()) {
		const runId = `seed-run-${date}`;
		const createdAt = at(date, "06:00:00");
		// The run row must exist before any collection run can reference it.
		await upsertRun(
			sql,
			{
				runId,
				date,
				status: "COMPLETED",
				createdAt,
				updatedAt: at(date, "06:11:00"),
				totalItems: ITEMS.length,
				processedItems: ITEMS.length,
				storyCount: index === 2 ? DAY3_STORIES.length : 2,
			},
			LINEAGE,
		);

		const collectorRuns: CollectorResult[] = COLLECTORS.filter((c) => c.enabled).map(
			(collector, position) => {
				// One collector fails on the middle day so the health views have a
				// real error to display rather than an invented one.
				const failed = index === 1 && collector.collectorId === "seed-hn-front";
				const items = collected.filter(
					(item) =>
						ITEMS.find((seed) => `seed:${seed.id}` === item.raw.externalId)?.collector ===
						collector.collectorId,
				);
				return {
					collectorId: collector.collectorId,
					health: failed ? "FAILED" : position === 2 ? "DEGRADED" : "OK",
					items: failed ? [] : items,
					facts: [],
					itemsFetched: failed ? 0 : items.length,
					warnings: position === 2 ? ["provider returned a partial page"] : [],
					...(failed ? { error: "upstream returned HTTP 503 after 3 retries" } : {}),
					startedAt: at(date, `05:${20 + position * 2}:00`),
					finishedAt: at(date, `05:${21 + position * 2}:30`),
					latencyMs: 900 + position * 640,
				};
			},
		);

		let rawRefs: Awaited<ReturnType<typeof upsertRawItems>> = [];
		for (const [position, result] of collectorRuns.entries()) {
			const collectionRunId = `seed-collect-${date}-${position}`;
			await recordCollectionRun(sql, collectionRunId, result, runId);
			if (result.items.length > 0) {
				rawRefs = rawRefs.concat(await upsertRawItems(sql, result.items, collectionRunId));
			}
		}
		const rawIdByExternal = new Map(rawRefs.map((ref) => [ref.externalId, ref.rawItemId] as const));

		const normalized = ITEMS.map((item) => {
			const rawItemId = rawIdByExternal.get(`seed:${item.id}`);
			return {
				id: item.id,
				sourceType: item.sourceType,
				sourceName: item.sourceName,
				title: item.title,
				summary: item.summary,
				...(item.url === undefined ? {} : { url: item.url }),
				publishedAt: item.publishedAt,
				metadata: {},
				...(rawItemId === undefined ? {} : { rawItemId }),
			};
		});
		await upsertNormalizedItems(sql, LINEAGE, normalized);

		await startAgentRun(sql, runId, "CURATOR", at(date, "06:00:10"));
		await finishAgentRun(sql, runId, "CURATOR", {
			status: "SUCCESS",
			finishedAt: at(date, "06:05:40"),
			durationMs: 330_000,
			provider: "anthropic",
			model: "claude-opus-4-6",
		});
		await recordAttempt(sql, runId, {
			attemptId: `${runId}-curator-1`,
			stage: "CURATOR",
			provider: "anthropic",
			model: "claude-opus-4-6",
			startedAt: at(date, "06:00:10"),
			finishedAt: at(date, "06:05:40"),
			durationMs: 330_000,
			status: "SUCCESS",
		});

		await startAgentRun(sql, runId, "EDITOR", at(date, "06:06:00"));
		if (index === 1) {
			// A real fallback: the primary editor model times out, the secondary
			// succeeds. This is what the admin view has to be able to show.
			await recordAttempt(sql, runId, {
				attemptId: `${runId}-editor-1`,
				stage: "EDITOR",
				provider: "anthropic",
				model: "claude-opus-4-6",
				startedAt: at(date, "06:06:00"),
				finishedAt: at(date, "06:08:00"),
				durationMs: 120_000,
				status: "FAILED",
				failureClass: "TIMEOUT",
				fallbackReason: "primary model exceeded the stage deadline",
			});
		}
		await recordAttempt(sql, runId, {
			attemptId: `${runId}-editor-2`,
			stage: "EDITOR",
			provider: "anthropic",
			model: index === 1 ? "claude-sonnet-4-6" : "claude-opus-4-6",
			startedAt: at(date, index === 1 ? "06:08:10" : "06:06:00"),
			finishedAt: at(date, "06:10:30"),
			durationMs: index === 1 ? 140_000 : 270_000,
			status: "SUCCESS",
		});
		await finishAgentRun(sql, runId, "EDITOR", {
			status: "SUCCESS",
			finishedAt: at(date, "06:10:30"),
			durationMs: index === 1 ? 140_000 : 270_000,
			provider: "anthropic",
			model: index === 1 ? "claude-sonnet-4-6" : "claude-opus-4-6",
		});

		const stories = index === 2 ? DAY3_STORIES : (EARLIER_STORIES[date] ?? []);
		for (const story of stories) {
			await upsertStoryRow(
				sql,
				LINEAGE,
				date,
				{
					storyId: story.storyId,
					canonicalTitle: story.title,
					sourceItemIds: story.itemIds,
					primarySourceIds: story.primaryIds,
					status: story.status,
					changeType: story.changeType as never,
					relevance: Math.min(1, story.importance + 0.05),
					novelty: story.novelty,
					importance: story.importance,
					confidence: story.confidence,
					reason: story.reason,
					factRefs: story.factRefs,
				},
				at(date, "06:03:00"),
			);
			for (const itemId of story.itemIds) {
				await sql`
					insert into story_items (lineage, story_id, date, item_id, role)
					values (${LINEAGE}, ${story.storyId}, ${date}, ${itemId},
						${story.primaryIds.includes(itemId) ? "PRIMARY" : "SUPPORTING"})
					on conflict do nothing
				`;
			}
		}

		const claimed = new Set(stories.flatMap((story) => story.itemIds));
		// Items fetched after the run was created were never presented to the
		// curator, so they get no decision row — which is exactly what makes them
		// show up under "New Since Morning".
		const scanned = ITEMS.filter((item) => item.fetchedAt < createdAt);
		const decisions: ItemDecision[] = scanned.map((item) => {
			if (item.id === "it-dupe-anthropic") {
				return {
					itemId: item.id,
					disposition: "DUPLICATE" as const,
					storyId: "st-context-window",
					reason: "與 it-anthropic-ctx 為同一事件的轉載，已併入既有故事。",
					decidedAt: at(date, "06:02:00"),
				};
			}
			if (claimed.has(item.id)) {
				return {
					itemId: item.id,
					disposition: "CANDIDATE" as const,
					storyId: stories.find((story) => story.itemIds.includes(item.id))!.storyId,
					reason: "符合興趣輪廓且具備第一手來源。",
					decidedAt: at(date, "06:02:00"),
				};
			}
			return {
				itemId: item.id,
				disposition: "IRRELEVANT" as const,
				reason:
					item.id === "it-noise-gadget"
						? "消費性硬體評測不在此輪廓的範圍內。"
						: "與今日的追蹤主題無實質關聯。",
				decidedAt: at(date, "06:02:00"),
			};
		});
		await upsertDecisions(sql, LINEAGE, date, decisions, runId);

		if (index === 2) {
			await upsertFacts(sql, LINEAGE, [
				{
					factId: "fact-btc-usd",
					kind: "crypto",
					label: "BTC spot",
					value: 71482.35,
					unit: " USD",
					asOf: at(date, "00:05:00"),
					sourceItemId: "it-btc-print",
					previousValue: 70910.12,
					changePct: 0.81,
				},
				{
					factId: "fact-cpi-yoy",
					kind: "macro",
					label: "US CPI YoY",
					value: 2.4,
					unit: "%",
					asOf: at(date, "01:30:00"),
					sourceItemId: "it-cpi-print",
					previousValue: 2.7,
					changePct: -11.11,
				},
				{
					factId: "fact-capex-delta",
					kind: "filing",
					label: "Combined 2027 capex guidance change",
					value: 18.5,
					unit: "%",
					asOf: at(date, "04:45:00"),
					sourceItemId: "it-chip-capex",
				},
			]);

			await saveMaterials(
				sql,
				LINEAGE,
				{
					date,
					producedAt: at(date, "06:05:40"),
					curatorNotes: "授權反轉與脈絡視窗為今日兩條主線；總經數據確認既有趨勢。",
					emergingSignals: [
						{
							label: "Licence reversals under customer pressure",
							rationale: "第二次觀察到廠商在社群壓力下回退授權變更。",
							storyIds: ["st-oss-license"],
						},
					],
					stories: DAY3_STORIES.map((story) => ({
						storyId: story.storyId,
						tier: story.importance > 0.75 ? "A" : story.importance > 0.5 ? "B" : "C",
						canonicalTitle: story.title,
						whySelected: story.reason,
						changeType: story.changeType as never,
						importance: story.importance,
						novelty: story.novelty,
						confidence: story.confidence,
						sourceItemIds: story.itemIds,
						primarySourceIds: story.primaryIds,
						factRefs: story.factRefs,
					})),
				},
				runId,
			);
		}

		const briefStories = (index === 2 ? DAY3_STORIES : stories).map((story) => ({
			storyId: story.storyId,
			section: story.section,
			mustKnow: story.mustKnow,
			title: story.title,
			whatHappened: story.whatHappened,
			whyItMatters: story.whyItMatters,
			whatChanged: story.whatChanged,
			impact: story.impact,
			confidence: story.briefConfidence,
			sourceItemIds: story.itemIds,
			factRefs: story.factRefs,
		}));

		const brief: DailyBrief = {
			date,
			producedAt: at(date, "06:10:30"),
			stories: briefStories,
			emergingSignals:
				index === 2
					? [
							{
								label: "Licence reversals under customer pressure",
								body: "兩個月內第二起：廠商在集中客戶施壓下撤回授權變更。若第三起出現，這會成為可預期的行為模式而非個案。",
								storyIds: ["st-oss-license"],
							},
						]
					: [],
			dailyAnalysis:
				index === 2
					? "今日的兩條主線指向同一件事：能力與授權的門檻同時在鬆動。百萬 token 脈絡把原本需要工程投入的檢索流程變成可選項，而授權反轉顯示集中客戶對基礎設施廠商仍有實質否決權。總經數據連續第二個月低於預期，使資本支出上修的可信度提高——這三者若同時成立，2027 年的推論供給會比目前的共識更寬鬆。"
					: "授權爭議仍在升溫，其餘主題無重大變化。",
			watchNext:
				index === 2
					? [
							"分叉專案在授權回退後是否仍維持開發動能",
							"第三家供應商是否跟進降價",
							"驗證器蒸餾結果的第三方複現",
						]
					: ["授權爭議是否出現社群分叉"],
		};
		await saveBrief(sql, LINEAGE, brief, runId);

		if (index === 1) {
			// A rejected draft, so /admin/runs has a real validation failure.
			await saveDraft(sql, LINEAGE, date, { stories: [] }, {
				producedAt: at(date, "06:07:50"),
				runId,
				validationStatus: "FAILED",
				validationErrors: [
					{ path: "stories", message: "expected at least 8 stories, received 5" },
					{ path: "stories.2.factRefs.0", message: 'unknown factRef "fact-unknown-cpi"' },
				],
			});
		}
		await saveDraft(sql, LINEAGE, date, brief, {
			producedAt: at(date, "06:10:20"),
			runId,
			validationStatus: "PASSED",
			validationErrors: [],
		});
	}

	const signals = [
		{
			signalId: "sig-licence-reversal",
			label: "Licence reversals under customer pressure",
			rationale: "第二次觀察到廠商在集中客戶壓力下撤回授權變更。",
			state: "strengthening" as const,
			confidence: 0.62,
			storyIds: ["st-oss-license"],
			firstDate: DATES[0],
			lastDate: DATES[2],
		},
		{
			signalId: "sig-long-context",
			label: "Long context displaces retrieval plumbing",
			rationale: "脈絡視窗擴張的速度快於檢索基礎設施的攤提週期。",
			state: "confirmed" as const,
			confidence: 0.81,
			storyIds: ["st-context-window", "st-inference-price"],
			firstDate: DATES[0],
			lastDate: DATES[2],
		},
		{
			signalId: "sig-capex-inference",
			label: "Capex guidance tracks inference demand",
			rationale: "資本支出上修的理由由訓練轉向推論。",
			state: "emerging" as const,
			confidence: 0.44,
			storyIds: ["st-capex", "st-foundry-yield"],
			firstDate: DATES[2],
			lastDate: DATES[2],
		},
		{
			signalId: "sig-selfhost-economics",
			label: "Self-hosting economics erode",
			rationale: "降價幅度連續三週超過自架成本的下降速度。",
			state: "fading" as const,
			confidence: 0.3,
			storyIds: ["st-inference-price"],
			firstDate: DATES[0],
			lastDate: DATES[1],
		},
	];
	for (const signal of signals) {
		await observeSignal(sql, LINEAGE, {
			signalId: signal.signalId,
			label: signal.label,
			rationale: signal.rationale,
			state: signal.state,
			confidence: signal.confidence,
			storyIds: signal.storyIds,
			observedAt: at(signal.firstDate!, "06:05:00"),
		});
		await observeSignal(sql, LINEAGE, {
			signalId: signal.signalId,
			label: signal.label,
			rationale: signal.rationale,
			state: signal.state,
			confidence: signal.confidence,
			storyIds: signal.storyIds,
			observedAt: at(signal.lastDate!, "06:05:00"),
		});
	}

	console.log(
		`[seed] done: ${DATES.length} briefs, ${ITEMS.length} items, ${signals.length} signals`,
	);
	await sql.end({ timeout: 5 });
}

main().catch((error: unknown) => {
	console.error("[seed] failed", error);
	process.exit(1);
});
