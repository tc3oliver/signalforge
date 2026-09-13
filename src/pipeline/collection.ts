import { createHash, randomUUID } from "node:crypto";
import type {
	CollectedFact,
	CollectedItem,
	Collector,
	CollectorContext,
	CollectorHealth,
	CollectorResult,
} from "../collectors/types.ts";
import { ArxivCollector } from "../collectors/arxiv.ts";
import { coingeckoCollector } from "../collectors/coingecko.ts";
import { fredCollector } from "../collectors/fred.ts";
import { GitHubCollector } from "../collectors/github.ts";
import { HackerNewsCollector } from "../collectors/hackernews.ts";
import { minifluxCollector } from "../collectors/miniflux.ts";
import { redditCollector } from "../collectors/reddit.ts";
import { secCollector } from "../collectors/sec.ts";
import { SemanticScholarCollector } from "../collectors/semantic-scholar.ts";
import { youtubeCollector } from "../collectors/youtube.ts";
import { loadConfig, resolveEnabledSources } from "../config/loader.ts";
import type { AppConfig } from "../config/schema.ts";
import { SourceType } from "../schemas/item.ts";
import { hasSecret, resolveSecret } from "../config/secrets.ts";
import type { Sql } from "../db/client.ts";
import { listCollectorStatus, recordCollectionRun, upsertSourceConfig } from "../db/collector-health.ts";
import { upsertFacts } from "../db/facts.ts";
import { type RawItemRef, upsertNormalizedItems, upsertRawItems } from "../db/items.ts";
import type { StructuredFact } from "../schemas/fact.ts";
import type { NormalizedItem } from "../schemas/item.ts";

/**
 * Stable, deterministic surrogate key for a provider record. Re-collecting the
 * same record must produce the same item id, or the normalized table would grow
 * a duplicate row for every re-run; a hash keeps the id bounded in length no
 * matter how long the provider's own identifier is.
 */
export function itemIdFor(sourceType: string, externalId: string): string {
	const digest = createHash("sha1").update(`${sourceType}::${externalId}`).digest("hex");
	return `${sourceType}-${digest.slice(0, 16)}`;
}

export function factIdFor(kind: string, externalId: string): string {
	const digest = createHash("sha1").update(`${kind}::${externalId}`).digest("hex");
	return `fct-${kind}-${digest.slice(0, 16)}`;
}

/** Mechanical projection of a collector item onto the only shape an agent ever sees. */
export function toNormalizedItem(item: CollectedItem): NormalizedItem {
	return {
		id: itemIdFor(item.sourceType, item.externalId),
		sourceType: item.sourceType,
		sourceName: item.sourceName,
		title: item.title,
		summary: item.summary,
		...(item.body === undefined ? {} : { content: item.body }),
		...(item.url === undefined ? {} : { url: item.url }),
		publishedAt: item.publishedAt,
		metadata: item.metadata,
	};
}

export function toStructuredFact(fact: CollectedFact, sourceType: string): StructuredFact {
	return {
		factId: factIdFor(fact.kind, fact.externalId),
		kind: fact.kind,
		label: fact.label,
		value: fact.value,
		unit: fact.unit,
		asOf: fact.asOf,
		// A fact always points at the item whose payload carried it. When the
		// collector did not name one, the fact's own external id is the record.
		sourceItemId: itemIdFor(sourceType, fact.sourceExternalId ?? fact.externalId),
	};
}

/* -------------------------------------------------------------------------- */
/* Store seam                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The persistence surface collection needs. The production implementation is a
 * thin adapter over `src/db/*` (there is exactly one DB access layer); the seam
 * exists so the orchestration rules — failure isolation, cursor gating,
 * idempotency — are testable without a running Postgres.
 */
export interface CollectionStore {
	/** Cursor last persisted for each collector id. */
	loadCursors(): Promise<Map<string, string | undefined>>;
	registerCollector(config: {
		collectorId: string;
		sourceType: string;
		enabled: boolean;
		requiredSecrets: readonly string[];
	}): Promise<void>;
	/** Append-only raw payloads; returns one ref per stored record. */
	persistRaw(items: readonly CollectedItem[], collectionRunId: string): Promise<RawItemRef[]>;
	persistItems(items: readonly NormalizedItem[], rawIds: ReadonlyMap<string, number>): Promise<void>;
	persistFacts(facts: readonly StructuredFact[]): Promise<void>;
	/** One collection_runs row; also advances the cursor when `result.cursor` is set. */
	recordRun(collectionRunId: string, result: CollectorResult, runId?: string): Promise<void>;
}

export function createPostgresCollectionStore(sql: Sql, lineage: string): CollectionStore {
	return {
		async loadCursors() {
			const rows = await listCollectorStatus(sql);
			return new Map(rows.map((r) => [r.collectorId, r.cursor]));
		},
		async registerCollector(config) {
			await upsertSourceConfig(sql, {
				collectorId: config.collectorId,
				sourceType: config.sourceType,
				enabled: config.enabled,
				requiredSecrets: config.requiredSecrets,
			});
		},
		async persistRaw(items, collectionRunId) {
			return upsertRawItems(sql, items, collectionRunId);
		},
		async persistItems(items, rawIds) {
			await upsertNormalizedItems(
				sql,
				lineage,
				items.map((item) => {
					const rawItemId = rawIds.get(item.id);
					return rawItemId === undefined ? item : { ...item, rawItemId };
				}),
			);
		},
		async persistFacts(facts) {
			await upsertFacts(sql, lineage, facts);
		},
		async recordRun(collectionRunId, result, runId) {
			await recordCollectionRun(sql, collectionRunId, result, runId);
		},
	};
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

export interface RegistryEntry {
	/** The key under `collectors:` in config/sources.yaml. */
	/** A real SourceType for shipped collectors; tests register fakes that simply have no config. */
	sourceKey: string;
	collector: Collector;
}

export interface RegistryOptions {
	/**
	 * arXiv ids this run already collected. Semantic Scholar has no discovery
	 * feed of its own — its worklist is whatever arXiv just produced — so the
	 * registry has to be built AFTER the arXiv collector has run, or with the
	 * ids of recently persisted arXiv items.
	 */
	arxivIds?: readonly string[];
}

/**
 * `CollectorContext` carries no collector-specific configuration, so a collector
 * that needs config either reads it itself (GitHubCollector reads
 * config/watchlists.yaml) or takes it through its constructor here.
 */
export function buildRegistry(options: RegistryOptions = {}): RegistryEntry[] {
	return [
		{ sourceKey: "rss", collector: minifluxCollector },
		{ sourceKey: "github", collector: new GitHubCollector() },
		{ sourceKey: "hackernews", collector: new HackerNewsCollector() },
		{ sourceKey: "arxiv", collector: new ArxivCollector() },
		{
			sourceKey: "semantic-scholar",
			collector: new SemanticScholarCollector({ arxivIds: [...(options.arxivIds ?? [])] }),
		},
		{ sourceKey: "coingecko", collector: coingeckoCollector },
		{ sourceKey: "fred", collector: fredCollector },
		{ sourceKey: "sec", collector: secCollector },
		{ sourceKey: "reddit", collector: redditCollector },
		{ sourceKey: "youtube", collector: youtubeCollector },
	];
}

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

export interface CollectorOutcome {
	collectorId: string;
	sourceType: string;
	health: CollectorHealth;
	itemsFetched: number;
	itemsInserted: number;
	factsInserted: number;
	warnings: string[];
	error?: string;
	/** Human-readable explanation for a DISABLED collector; never a secret value. */
	disabledReason?: string;
	cursorAdvanced: boolean;
	collectionRunId: string;
	latencyMs: number;
}

export interface CollectionSummary {
	startedAt: string;
	finishedAt: string;
	/** True when at least one enabled collector FAILED; the run stays usable. */
	degraded: boolean;
	/** True when no enabled collector produced anything at all. */
	empty: boolean;
	outcomes: CollectorOutcome[];
	itemsInserted: number;
	/** External ids of arXiv items this run collected; the Semantic Scholar worklist. */
	arxivExternalIds: string[];
}

export interface SecretAccess {
	secret: (name: string) => Promise<string>;
	hasSecret: (name: string) => Promise<boolean>;
}

export interface CollectionOptions {
	store: CollectionStore;
	since: Date;
	now?: () => Date;
	/** The daily run this collection belongs to, when there is one. */
	runId?: string;
	/** Defaults to the registry; tests pass fakes. */
	entries?: readonly RegistryEntry[];
	/** Defaults to `config/sources.yaml`. */
	enabledSourceKeys?: readonly string[];
	secrets?: SecretAccess;
	/** Defaults to the real config on disk; tests inject one so they stay hermetic. */
	appConfig?: AppConfig;
	fetchImpl?: typeof globalThis.fetch;
	concurrency?: number;
	signal?: AbortSignal;
	log?: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * Non-secret scalars a collector needs that have no dedicated schema field yet.
 * Kept narrow on purpose: anything durable belongs in a typed field instead.
 */
function sourceConfigFor(appConfig: AppConfig, sourceKey: string) {
	// A test registers fake collectors whose key is not a SourceType at all; they
	// simply have no configuration, which is different from having bad configuration.
	const parsed = SourceType.safeParse(sourceKey);
	return parsed.success ? appConfig.sources.collectors[parsed.data] : undefined;
}

/**
 * Non-secret scalars a collector needs that have no dedicated schema field yet.
 * Kept narrow on purpose: anything durable belongs in a typed field instead.
 */
function collectorScalar(
	appConfig: AppConfig,
	sourceKey: string,
	name: string,
): string | undefined {
	const source = sourceConfigFor(appConfig, sourceKey) as
		| (Record<string, unknown> & { userAgent?: string })
		| undefined;
	if (name === "SEC_USER_AGENT") return source?.userAgent;
	const value = source?.[name];
	return typeof value === "string" ? value : undefined;
}

/** Bounded pool: eleven collectors hitting eleven providers at once is a thundering herd. */
const DEFAULT_CONCURRENCY = 5;

async function pool<T>(
	tasks: readonly (() => Promise<T>)[],
	concurrency: number,
): Promise<T[]> {
	const results: T[] = new Array(tasks.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
		for (;;) {
			const index = next++;
			const task = tasks[index];
			if (!task) return;
			results[index] = await task();
		}
	});
	await Promise.all(workers);
	return results;
}

function disabledResult(
	collectorId: string,
	reason: string,
	at: string,
): CollectorResult {
	return {
		collectorId,
		health: "DISABLED",
		items: [],
		facts: [],
		itemsFetched: 0,
		warnings: [reason],
		startedAt: at,
		finishedAt: at,
		latencyMs: 0,
	};
}

/**
 * Runs every enabled collector, isolating failures. One provider being down,
 * rate-limited or broken degrades the day; it never fails it, because the other
 * ten sources are still a publishable brief.
 */
export async function runCollection(options: CollectionOptions): Promise<CollectionSummary> {
	const now = options.now ?? (() => new Date());
	const log = options.log ?? (() => {});
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const secrets: SecretAccess = options.secrets ?? {
		secret: (name) => resolveSecret(name),
		hasSecret: (name) => hasSecret(name),
	};
	const startedAt = now().toISOString();

	const appConfig = options.appConfig ?? loadConfig();
	const entries = options.entries ?? buildRegistry();
	const enabledKeys = new Set(
		options.enabledSourceKeys ?? resolveEnabledSources(appConfig),
	);
	const cursors = await options.store.loadCursors();
	/** arXiv ids seen this run; the Semantic Scholar enrichment worklist. */
	const arxivExternalIds: string[] = [];

	const outcomes = await pool(
		entries.map((entry) => async (): Promise<CollectorOutcome> => {
			const { collector } = entry;
			const collectionRunId = randomUUID();
			const enabled = enabledKeys.has(entry.sourceKey);
			await options.store.registerCollector({
				collectorId: collector.id,
				sourceType: collector.sourceType,
				enabled,
				requiredSecrets: collector.requiredSecrets,
			});

			const base = {
				collectorId: collector.id,
				sourceType: collector.sourceType,
				collectionRunId,
			};

			if (!enabled) {
				const reason = `disabled for source "${entry.sourceKey}" in config/sources.yaml`;
				const at = now().toISOString();
				await options.store.recordRun(collectionRunId, disabledResult(collector.id, reason, at), options.runId);
				return {
					...base,
					health: "DISABLED",
					itemsFetched: 0,
					itemsInserted: 0,
					factsInserted: 0,
					warnings: [reason],
					disabledReason: reason,
					cursorAdvanced: false,
					latencyMs: 0,
				};
			}

			// A missing credential is an operational fact, not a run failure: the
			// source is simply not available today and says so.
			const missing: string[] = [];
			for (const name of collector.requiredSecrets) {
				if (!(await secrets.hasSecret(name))) missing.push(name);
			}
			if (missing.length > 0) {
				const reason = `missing required secret(s): ${missing.join(", ")}`;
				const at = now().toISOString();
				await options.store.recordRun(collectionRunId, disabledResult(collector.id, reason, at), options.runId);
				return {
					...base,
					health: "DISABLED",
					itemsFetched: 0,
					itemsInserted: 0,
					factsInserted: 0,
					warnings: [reason],
					disabledReason: reason,
					cursorAdvanced: false,
					latencyMs: 0,
				};
			}

			const cursor = cursors.get(collector.id);
			const ctx: CollectorContext = {
				since: options.since,
				now,
				...(cursor === undefined ? {} : { cursor }),
				secret: secrets.secret,
				hasSecret: secrets.hasSecret,
				// A collector with no watchlist silently collects nothing and reports
				// success, which is the worst failure shape there is -- so the curated
				// lists are handed over here rather than read by each collector.
				watchlists: appConfig.watchlists,
				...(sourceConfigFor(appConfig, entry.sourceKey)
					? { sourceConfig: sourceConfigFor(appConfig, entry.sourceKey)! }
					: {}),
				config: async (name) => collectorScalar(appConfig, entry.sourceKey, name),
				fetch: fetchImpl,
				...(options.signal ? { signal: options.signal } : {}),
				log: (msg, fields) => log(msg, { collector: collector.id, ...fields }),
			};

			const attemptStartedAt = now();
			let result: CollectorResult;
			try {
				result = await collector.collect(ctx);
			} catch (err) {
				const finishedAt = now();
				const message = err instanceof Error ? err.message : String(err);
				const failed: CollectorResult = {
					collectorId: collector.id,
					health: "FAILED",
					items: [],
					facts: [],
					itemsFetched: 0,
					warnings: [],
					error: message,
					startedAt: attemptStartedAt.toISOString(),
					finishedAt: finishedAt.toISOString(),
					latencyMs: finishedAt.getTime() - attemptStartedAt.getTime(),
				};
				// No cursor is passed on, so the next run re-reads from the last good
				// position rather than skipping whatever this attempt missed.
				await options.store.recordRun(collectionRunId, { ...failed, cursor: undefined }, options.runId);
				log("collector failed", { collector: collector.id, error: message });
				return {
					...base,
					health: "FAILED",
					itemsFetched: 0,
					itemsInserted: 0,
					factsInserted: 0,
					warnings: [],
					error: message,
					cursorAdvanced: false,
					latencyMs: failed.latencyMs,
				};
			}

			if (result.health === "FAILED") {
				await options.store.recordRun(collectionRunId, { ...result, cursor: undefined }, options.runId);
				return {
					...base,
					health: "FAILED",
					itemsFetched: result.itemsFetched,
					itemsInserted: 0,
					factsInserted: 0,
					warnings: result.warnings,
					...(result.error === undefined ? {} : { error: result.error }),
					cursorAdvanced: false,
					latencyMs: result.latencyMs,
				};
			}

			// The collection_runs row has to exist before raw items can reference it,
			// but it is written WITHOUT the cursor first: the cursor is only
			// advanced once the data it describes is durably stored, so a crash
			// half way through persistence re-reads the same window next time.
			await options.store.recordRun(collectionRunId, { ...result, cursor: undefined }, options.runId);

			let inserted = 0;
			let factsInserted = 0;
			try {
				const refs = await options.store.persistRaw(result.items, collectionRunId);
				inserted = refs.filter((r) => r.inserted).length;
				const normalized = result.items.map(toNormalizedItem);
				const rawIds = new Map(refs.map((r) => [itemIdFor(r.sourceType, r.externalId), r.rawItemId]));
				await options.store.persistItems(normalized, rawIds);
				for (const item of result.items) {
					if (item.sourceType === "arxiv") arxivExternalIds.push(item.externalId);
				}

				// A fact whose source item was not collected would be a dangling
				// reference in the manifest, so only facts we can anchor are kept.
				const knownItemIds = new Set(normalized.map((i) => i.id));
				const facts = result.facts
					.map((f) => toStructuredFact(f, collector.sourceType))
					.filter((f) => knownItemIds.has(f.sourceItemId));
				await options.store.persistFacts(facts);
				factsInserted = facts.length;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				log("collector persistence failed", { collector: collector.id, error: message });
				return {
					...base,
					health: "FAILED",
					itemsFetched: result.itemsFetched,
					itemsInserted: 0,
					factsInserted: 0,
					warnings: result.warnings,
					error: message,
					cursorAdvanced: false,
					latencyMs: result.latencyMs,
				};
			}

			// Everything landed: now the cursor may move.
			if (result.cursor !== undefined) {
				await options.store.recordRun(collectionRunId, result, options.runId);
			}

			return {
				...base,
				health: result.health,
				itemsFetched: result.itemsFetched,
				itemsInserted: inserted,
				factsInserted,
				warnings: result.warnings,
				...(result.error === undefined ? {} : { error: result.error }),
				cursorAdvanced: result.cursor !== undefined,
				latencyMs: result.latencyMs,
			};
		}),
		options.concurrency ?? DEFAULT_CONCURRENCY,
	);

	const degraded = outcomes.some((o) => o.health === "FAILED");
	const active = outcomes.filter((o) => o.health !== "DISABLED");

	return {
		startedAt,
		finishedAt: now().toISOString(),
		degraded,
		empty: active.length === 0 || active.every((o) => o.itemsFetched === 0),
		outcomes,
		itemsInserted: outcomes.reduce((sum, o) => sum + o.itemsInserted, 0),
		arxivExternalIds,
	};
}

/**
 * Production entry point: arXiv runs first so its external ids can seed the
 * Semantic Scholar worklist, then the rest of the registry runs as one pool.
 */
export async function runCollectionForDay(
	options: Omit<CollectionOptions, "entries"> & { entries?: readonly RegistryEntry[] },
): Promise<CollectionSummary> {
	if (options.entries) return runCollection(options);

	const arxivEntry = buildRegistry().find((e) => e.sourceKey === "arxiv")!;
	const first = await runCollection({ ...options, entries: [arxivEntry] });
	const arxivIds = first.arxivExternalIds;

	const rest = await runCollection({
		...options,
		entries: buildRegistry({ arxivIds }).filter((e) => e.sourceKey !== "arxiv"),
	});

	return {
		startedAt: first.startedAt,
		finishedAt: rest.finishedAt,
		degraded: first.degraded || rest.degraded,
		empty: first.empty && rest.empty,
		outcomes: [...first.outcomes, ...rest.outcomes],
		itemsInserted: first.itemsInserted + rest.itemsInserted,
		arxivExternalIds: arxivIds,
	};
}
