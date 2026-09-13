import { describe, expect, it } from "vitest";
import type {
	CollectedItem,
	Collector,
	CollectorContext,
	CollectorResult,
} from "../src/collectors/types.ts";
import type { RawItemRef } from "../src/db/items.ts";
import type { StructuredFact } from "../src/schemas/fact.ts";
import type { NormalizedItem } from "../src/schemas/item.ts";
import { loadConfig } from "../src/config/loader.ts";
import {
	type CollectionStore,
	type RegistryEntry,
	buildRegistry,
	itemIdFor,
	runCollection,
	toNormalizedItem,
} from "../src/pipeline/collection.ts";

const SINCE = new Date("2026-09-12T00:00:00.000Z");
const NOW = new Date("2026-09-13T06:00:00.000Z");

function collectedItem(sourceType: CollectedItem["sourceType"], externalId: string): CollectedItem {
	return {
		sourceType,
		sourceName: `${sourceType} source`,
		externalId,
		title: `Title ${externalId}`,
		summary: `Summary ${externalId}`,
		publishedAt: "2026-09-13T05:00:00.000Z",
		metadata: {},
		trust: "UNTRUSTED_EXTERNAL_CONTENT",
		raw: { externalId, body: { id: externalId }, fetchedAt: "2026-09-13T05:30:00.000Z" },
	};
}

function okResult(collectorId: string, items: CollectedItem[], cursor?: string): CollectorResult {
	return {
		collectorId,
		health: "OK",
		items,
		facts: [],
		itemsFetched: items.length,
		...(cursor === undefined ? {} : { cursor }),
		warnings: [],
		startedAt: NOW.toISOString(),
		finishedAt: NOW.toISOString(),
		latencyMs: 5,
	};
}

interface FakeCollectorOptions {
	id: string;
	sourceType?: CollectedItem["sourceType"];
	requiredSecrets?: string[];
	items?: CollectedItem[];
	cursor?: string;
	throws?: Error;
	onCollect?: (ctx: CollectorContext) => void;
}

function fakeCollector(options: FakeCollectorOptions): Collector {
	const sourceType = options.sourceType ?? "rss";
	return {
		id: options.id,
		sourceType,
		requiredSecrets: options.requiredSecrets ?? [],
		check: async () => ({ ok: true, detail: "fake" }),
		collect: async (ctx) => {
			options.onCollect?.(ctx);
			if (options.throws) throw options.throws;
			return okResult(options.id, options.items ?? [], options.cursor);
		},
	};
}

/** Mirrors the store's real constraints: UNIQUE(source_type, external_id) and cursor-on-write. */
function memoryStore(seedCursors: Record<string, string> = {}) {
	const raw = new Map<string, number>();
	const items = new Map<string, NormalizedItem>();
	const facts = new Map<string, StructuredFact>();
	const cursors = new Map<string, string | undefined>(Object.entries(seedCursors));
	const runs: Array<{ collectionRunId: string; result: CollectorResult }> = [];
	let nextRawId = 1;

	const store: CollectionStore = {
		loadCursors: async () => new Map(cursors),
		registerCollector: async () => {},
		persistRaw: async (batch): Promise<RawItemRef[]> =>
			batch.map((item) => {
				const key = `${item.sourceType}|${item.raw.externalId}`;
				const known = raw.get(key);
				if (known !== undefined) {
					return { rawItemId: known, sourceType: item.sourceType, externalId: item.raw.externalId, inserted: false };
				}
				const id = nextRawId++;
				raw.set(key, id);
				return { rawItemId: id, sourceType: item.sourceType, externalId: item.raw.externalId, inserted: true };
			}),
		persistItems: async (batch) => {
			for (const item of batch) items.set(item.id, item);
		},
		persistFacts: async (batch) => {
			for (const fact of batch) facts.set(fact.factId, fact);
		},
		recordRun: async (collectionRunId, result) => {
			runs.push({ collectionRunId, result });
			// coalesce(cursor, cursor): a run that reports no cursor leaves the
			// stored one untouched, exactly like the SQL does.
			if (result.cursor !== undefined) cursors.set(result.collectorId, result.cursor);
		},
	};
	return { store, raw, items, facts, cursors, runs };
}

const entry = (collector: Collector, sourceKey: string): RegistryEntry => ({ sourceKey, collector });

describe("collection orchestration", () => {
	it("keeps the run usable when one collector fails", async () => {
		const store = memoryStore();
		const summary = await runCollection({
			store: store.store,
			since: SINCE,
			now: () => NOW,
			enabledSourceKeys: ["good", "bad", "other"],
			entries: [
				entry(fakeCollector({ id: "good", items: [collectedItem("rss", "a1")] }), "good"),
				entry(fakeCollector({ id: "bad", throws: new Error("provider 503") }), "bad"),
				entry(
					fakeCollector({ id: "other", sourceType: "hackernews", items: [collectedItem("hackernews", "h1")] }),
					"other",
				),
			],
		});

		expect(summary.degraded).toBe(true);
		expect(summary.empty).toBe(false);
		expect(summary.outcomes.map((o) => o.health).sort()).toEqual(["FAILED", "OK", "OK"]);
		// The failure is reported, not thrown, and the other two sources still landed.
		expect(summary.outcomes.find((o) => o.collectorId === "bad")?.error).toContain("provider 503");
		expect(store.items.size).toBe(2);
		expect(summary.itemsInserted).toBe(2);
	});

	it("reports a collector disabled for a missing credential without failing the run", async () => {
		const store = memoryStore();
		const summary = await runCollection({
			store: store.store,
			since: SINCE,
			now: () => NOW,
			enabledSourceKeys: ["needs-key", "open"],
			secrets: {
				hasSecret: async (name) => name !== "MISSING_KEY",
				secret: async () => "unused",
			},
			entries: [
				entry(fakeCollector({ id: "needs-key", requiredSecrets: ["MISSING_KEY"] }), "needs-key"),
				entry(fakeCollector({ id: "open", items: [collectedItem("rss", "a1")] }), "open"),
			],
		});

		const disabled = summary.outcomes.find((o) => o.collectorId === "needs-key")!;
		expect(disabled.health).toBe("DISABLED");
		expect(disabled.disabledReason).toContain("MISSING_KEY");
		expect(disabled.error).toBeUndefined();
		expect(summary.degraded).toBe(false);
	});

	it("honours a source disabled in configuration", async () => {
		const store = memoryStore();
		const summary = await runCollection({
			store: store.store,
			since: SINCE,
			now: () => NOW,
			enabledSourceKeys: ["on"],
			entries: [
				entry(fakeCollector({ id: "on", items: [collectedItem("rss", "a1")] }), "on"),
				entry(fakeCollector({ id: "off", items: [collectedItem("rss", "a2")] }), "off"),
			],
		});

		const off = summary.outcomes.find((o) => o.collectorId === "off")!;
		expect(off.health).toBe("DISABLED");
		expect(off.disabledReason).toContain("config/sources.yaml");
		expect(store.items.size).toBe(1);
	});

	it("advances a cursor only on success", async () => {
		const store = memoryStore({ good: "cursor-1", bad: "cursor-9" });
		const seen: Array<string | undefined> = [];

		await runCollection({
			store: store.store,
			since: SINCE,
			now: () => NOW,
			enabledSourceKeys: ["good", "bad"],
			entries: [
				entry(
					fakeCollector({
						id: "good",
						items: [collectedItem("rss", "a1")],
						cursor: "cursor-2",
						onCollect: (ctx) => seen.push(ctx.cursor),
					}),
					"good",
				),
				entry(
					fakeCollector({
						id: "bad",
						throws: new Error("boom"),
						onCollect: (ctx) => seen.push(ctx.cursor),
					}),
					"bad",
				),
			],
		});

		expect(seen.sort()).toEqual(["cursor-1", "cursor-9"]);
		expect(store.cursors.get("good")).toBe("cursor-2");
		// Unchanged, so the next run re-reads whatever this attempt missed.
		expect(store.cursors.get("bad")).toBe("cursor-9");
	});

	it("is idempotent across a re-collection of the same window", async () => {
		const store = memoryStore();
		const items = [collectedItem("rss", "a1"), collectedItem("rss", "a2")];
		const options = {
			store: store.store,
			since: SINCE,
			now: () => NOW,
			enabledSourceKeys: ["dup"],
			entries: [entry(fakeCollector({ id: "dup", items }), "dup")],
		};

		const first = await runCollection(options);
		const second = await runCollection(options);

		expect(first.itemsInserted).toBe(2);
		expect(second.itemsInserted).toBe(0);
		expect(store.raw.size).toBe(2);
		expect(store.items.size).toBe(2);
	});

	it("derives a stable item id from source and external id", () => {
		const item = collectedItem("rss", "a1");
		expect(toNormalizedItem(item).id).toBe(itemIdFor("rss", "a1"));
		expect(itemIdFor("rss", "a1")).toBe(itemIdFor("rss", "a1"));
		expect(itemIdFor("rss", "a1")).not.toBe(itemIdFor("hackernews", "a1"));
	});

	it("wires the two collector configuration gaps", () => {
		const registry = buildRegistry({ arxivIds: ["2609.00001"] });
		// GitHub takes no repos here: it reads config/watchlists.yaml itself.
		expect(registry.find((e) => e.sourceKey === "github")?.collector.id).toBe("github");
		// Semantic Scholar's worklist is injected, because it has no feed of its own.
		expect(registry.find((e) => e.sourceKey === "semantic-scholar")?.collector.id).toBe("semantic-scholar");
		expect(registry.map((e) => e.sourceKey)).toContain("arxiv");
	});

	it("bounds concurrency", async () => {
		const store = memoryStore();
		let inFlight = 0;
		let peak = 0;
		const slow = (id: string): Collector => ({
			id,
			sourceType: "rss",
			requiredSecrets: [],
			check: async () => ({ ok: true, detail: "" }),
			collect: async () => {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				await new Promise((r) => setTimeout(r, 5));
				inFlight -= 1;
				return okResult(id, []);
			},
		});
		const ids = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"];

		await runCollection({
			store: store.store,
			since: SINCE,
			now: () => NOW,
			concurrency: 3,
			enabledSourceKeys: ids,
			entries: ids.map((id) => entry(slow(id), id)),
		});

		expect(peak).toBeLessThanOrEqual(3);
	});
});

/**
 * The config fields on CollectorContext are optional, and every collector treats
 * an absent watchlist as an empty one. That combination compiles perfectly while
 * collecting nothing and reporting success, so the wiring itself needs a test --
 * type-checking it proves nothing.
 */
describe("collector configuration reaches the collector", () => {
	it("hands each collector its watchlists and its own source config", async () => {
		const seen: Array<{
			watchlists?: unknown;
			sourceConfig?: unknown;
			userAgent?: string | undefined;
		}> = [];

		const probe = {
			id: "sec",
			sourceType: "sec" as const,
			requiredSecrets: [] as const,
			check: async () => ({ ok: true, detail: "probe" }),
			collect: async (ctx: CollectorContext) => {
				seen.push({
					watchlists: ctx.watchlists,
					sourceConfig: ctx.sourceConfig,
					userAgent: await ctx.config?.("SEC_USER_AGENT"),
				});
				return okResult("sec", []);
			},
		};

		const appConfig = loadConfig();
		await runCollection({
			store: memoryStore().store,
			since: new Date("2026-09-12T00:00:00.000Z"),
			entries: [{ sourceKey: "sec", collector: probe }],
			enabledSourceKeys: ["sec"],
			appConfig,
			secrets: { secret: async () => "", hasSecret: async () => false },
		});

		expect(seen).toHaveLength(1);
		const got = seen[0]!;
		// The real watchlist file, not an empty object standing in for it.
		expect(got.watchlists).toBe(appConfig.watchlists);
		expect(got.sourceConfig).toBe(appConfig.sources.collectors.sec);
		expect(got.userAgent).toBe(appConfig.sources.collectors.sec.userAgent);
	});

	it("gives a collector whose key is not a real source type no configuration", async () => {
		let sourceConfig: unknown = "untouched";
		const probe = {
			id: "fake",
			sourceType: "web" as const,
			requiredSecrets: [] as const,
			check: async () => ({ ok: true, detail: "probe" }),
			collect: async (ctx: CollectorContext) => {
				sourceConfig = ctx.sourceConfig;
				return okResult("fake", []);
			},
		};

		await runCollection({
			store: memoryStore().store,
			since: new Date("2026-09-12T00:00:00.000Z"),
			entries: [{ sourceKey: "not-a-source-type", collector: probe }],
			enabledSourceKeys: ["not-a-source-type"],
			appConfig: loadConfig(),
			secrets: { secret: async () => "", hasSecret: async () => false },
		});

		expect(sourceConfig).toBeUndefined();
	});
});
