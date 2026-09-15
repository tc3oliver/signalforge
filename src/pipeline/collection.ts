import { createHash, randomUUID } from "node:crypto";
import { scrubSecrets } from "../runtime/redact.ts";
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
import type { AppConfig, CollectorSourceConfig } from "../config/schema.ts";
import { SourceType } from "../schemas/item.ts";
import { hasSecret, resolveSecret } from "../config/secrets.ts";
import type { Sql } from "../db/client.ts";
import { listCollectorStatus, recordCollectionRun, upsertSourceConfig } from "../db/collector-health.ts";
import { upsertFacts } from "../db/facts.ts";
import { type RawItemRef, upsertNormalizedItems, upsertRawItems } from "../db/items.ts";
import { mapWithConcurrency } from "../collectors/http.ts";
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
		// Carried across the boundary, not re-derived: the collector said this came
		// from outside and the agent-visible shape has to keep saying so.
		trust: item.trust,
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
 * Most collector-specific config (watchlists, source config, non-secret
 * scalars) reaches a collector through `CollectorContext`, populated by
 * `runCollection` below. Semantic Scholar is the one exception: it has no
 * discovery feed of its own, so its worklist is injected here, at
 * construction time, from this run's arXiv results.
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
	/**
	 * True when at least one enabled collector FAILED, or when the run as a whole
	 * produced nothing. The run stays usable; the reason is in `degradedReasons`.
	 */
	degraded: boolean;
	/** True when no enabled collector produced anything at all. */
	empty: boolean;
	/**
	 * Set when the run looks broken rather than quiet. Distinguishing the two is
	 * the point: a day on which FRED printed nothing is a working day, and a day
	 * on which *every* source printed nothing is an environment problem wearing a
	 * quiet day's clothes.
	 */
	suspiciousReason?: string;
	/** Collectors that reported health but returned nothing, and are not sources that legitimately do. */
	silentCollectors: string[];
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
	/**
	 * Cursor per collector id. Defaults to reading them from the store; a
	 * caller that runs collection in more than one pass resolves them once and
	 * passes them in, so the same table is not read for every pass.
	 */
	cursors?: ReadonlyMap<string, string | undefined>;
	secrets?: SecretAccess;
	/** Defaults to the real config on disk; tests inject one so they stay hermetic. */
	appConfig?: AppConfig;
	fetchImpl?: typeof globalThis.fetch;
	concurrency?: number;
	/** Ceiling on one collector's whole run; defaults to three minutes. */
	collectorDeadlineMs?: number;
	signal?: AbortSignal;
	log?: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * A permissive stand-in for a collector whose `sourceKey` is not a real
 * `SourceType` at all — only ever a test's fake collector, never a shipped
 * one. `sourceConfig` is required on `CollectorContext`, so this keeps such a
 * fake constructible without inventing a fifth "no config" representation.
 */
const NO_SOURCE_CONFIG: CollectorSourceConfig = {
	enabled: true,
	rateLimitPerMinute: 60,
	timeoutMs: 30_000,
	pageSize: 50,
	requiredSecrets: [],
};

/**
 * Non-secret scalars a collector needs that have no dedicated schema field yet.
 * Kept narrow on purpose: anything durable belongs in a typed field instead.
 */
function sourceConfigFor(appConfig: AppConfig, sourceKey: string): CollectorSourceConfig {
	// A test registers fake collectors whose key is not a SourceType at all; they
	// simply have no configuration, which is different from having bad configuration.
	const parsed = SourceType.safeParse(sourceKey);
	return parsed.success ? appConfig.sources.collectors[parsed.data] : NO_SOURCE_CONFIG;
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
	const source = sourceConfigFor(appConfig, sourceKey) as Record<string, unknown>;
	if (name === "SEC_USER_AGENT") return source["userAgent"] as string | undefined;
	const value = source[name];
	return typeof value === "string" ? value : undefined;
}

/**
 * Sources for which "nothing today" is an ordinary, correct answer, so a zero
 * count from them must never raise an alarm.
 *
 * - `fred` is incremental macro data: most configured series do not print on
 *   most days, which is the whole reason `fred.ts` separates problems from notes.
 * - `semantic-scholar` is enrichment-only; with no arXiv ids to enrich there is
 *   nothing for it to do and nothing wrong.
 * - `sec` only has filings on days companies file.
 *
 * Everything else is either high-volume or continuously published, so a healthy
 * run of it that returns nothing is worth recording. That is recorded per
 * collector rather than failing the run, because an incremental collector with a
 * cursor can legitimately return zero in a narrow window too -- the signal that
 * actually means something is the same collector doing it run after run, which
 * is what the health counters in `src/db/collector-health.ts` are for.
 */
const MAY_BE_QUIET: ReadonlySet<string> = new Set(["fred", "semantic-scholar", "sec"]);

/** Bounded pool: eleven collectors hitting eleven providers at once is a thundering herd. */
const DEFAULT_CONCURRENCY = 5;

/**
 * Hard ceiling on one collector's whole run, independent of any per-request
 * timeout. A collector that pages a slow provider can stay busy long after the
 * per-request timeout would have fired, and a collector that never settles at
 * all takes its outcome with it: the run finishes, the row is never written,
 * and the source simply is not there -- no error, no warning, nothing to see.
 * This turns that into a FAILED row that says what happened.
 */
const DEFAULT_COLLECTOR_DEADLINE_MS = 180_000;

class CollectorDeadlineError extends Error {
	constructor(collectorId: string, ms: number) {
		super(`collector "${collectorId}" did not finish within ${Math.round(ms / 1000)}s`);
		this.name = "CollectorDeadlineError";
	}
}

/**
 * Races a collector against its deadline. The loser is abandoned rather than
 * cancelled -- a collector has no obligation to honour an abort -- but it can no
 * longer stop the run from recording what happened.
 */
async function withDeadline<T>(
	collectorId: string,
	ms: number,
	work: () => Promise<T>,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new CollectorDeadlineError(collectorId, ms)), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
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
	const cursors = options.cursors ?? (await options.store.loadCursors());
	/** arXiv ids seen this run; the Semantic Scholar enrichment worklist. */
	const arxivExternalIds: string[] = [];

	const outcomes = await mapWithConcurrency(
		entries,
		options.concurrency ?? DEFAULT_CONCURRENCY,
		async (entry): Promise<CollectorOutcome> => {
			const { collector } = entry;
			const collectionRunId = randomUUID();
			const enabled = enabledKeys.has(entry.sourceKey);

			const base = {
				collectorId: collector.id,
				sourceType: collector.sourceType,
				collectionRunId,
			};

			/**
			 * This collector could not do its job. Every store failure below turns
			 * into one of these rather than a rejection, because the pool does not
			 * catch and a rejecting task takes the other ten collectors with it.
			 */
			const failure = (message: string, over: Partial<CollectorOutcome> = {}): CollectorOutcome => ({
				...base,
				health: "FAILED",
				itemsFetched: 0,
				itemsInserted: 0,
				factsInserted: 0,
				warnings: [],
				error: message,
				cursorAdvanced: false,
				latencyMs: 0,
				...over,
			});

			/*
			 * Writing the collection_runs row is a database call like any other, and
			 * it used to sit outside every try in this task. One Postgres hiccup
			 * while a collector was being recorded therefore rejected the whole
			 * pool: ten working collectors became a failed run, with whatever the
			 * in-flight ones had already persisted left behind. Returns the message
			 * instead of throwing so each call site can decide what the outcome is.
			 */
			const record = async (result: CollectorResult): Promise<string | undefined> => {
				try {
					await options.store.recordRun(collectionRunId, result, options.runId);
					return undefined;
				} catch (err) {
					const message = scrubSecrets(err instanceof Error ? err.message : String(err));
					log("collector run record failed", { collector: collector.id, error: message });
					return message;
				}
			};

			/*
			 * Registration is the first await, so a throw here produced no row at
			 * all -- the source simply was not in the run, which is the one failure
			 * shape this pipeline must never have.
			 */
			try {
				await options.store.registerCollector({
					collectorId: collector.id,
					sourceType: collector.sourceType,
					enabled,
					requiredSecrets: collector.requiredSecrets,
				});
			} catch (err) {
				const message = scrubSecrets(err instanceof Error ? err.message : String(err));
				log("collector registration failed", { collector: collector.id, error: message });
				return failure(message);
			}

			if (!enabled) {
				const reason = `disabled for source "${entry.sourceKey}" in config/sources.yaml`;
				const at = now().toISOString();
				const recordError = await record(disabledResult(collector.id, reason, at));
				/*
				 * A bookkeeping write that fails does not change the collector's
				 * verdict: this source is switched off, and reporting FAILED instead
				 * would name a deliberately disabled collector as unavailable in the
				 * run's degraded reason, and make the "every enabled collector
				 * returned zero items" check count a source that never ran.
				 */
				return {
					...base,
					health: "DISABLED",
					itemsFetched: 0,
					itemsInserted: 0,
					factsInserted: 0,
					warnings: recordError === undefined ? [reason] : [reason, `run row not written: ${recordError}`],
					disabledReason: reason,
					cursorAdvanced: false,
					latencyMs: 0,
				};
			}

			// A missing credential is an operational fact, not a run failure: the
			// source is simply not available today and says so.
			const missing: string[] = [];
			try {
				for (const name of collector.requiredSecrets) {
					if (!(await secrets.hasSecret(name))) missing.push(name);
				}
			} catch (err) {
				// The resolver itself broke (a locked Keychain, a missing file). The
				// name is safe to log; the value is never read here.
				const message = scrubSecrets(err instanceof Error ? err.message : String(err));
				log("secret lookup failed", { collector: collector.id, error: message });
				return failure(message);
			}
			if (missing.length > 0) {
				const reason = `missing required secret(s): ${missing.join(", ")}`;
				const at = now().toISOString();
				const recordError = await record(disabledResult(collector.id, reason, at));
				/*
				 * A bookkeeping write that fails does not change the collector's
				 * verdict: this source is switched off, and reporting FAILED instead
				 * would name a deliberately disabled collector as unavailable in the
				 * run's degraded reason, and make the "every enabled collector
				 * returned zero items" check count a source that never ran.
				 */
				return {
					...base,
					health: "DISABLED",
					itemsFetched: 0,
					itemsInserted: 0,
					factsInserted: 0,
					warnings: recordError === undefined ? [reason] : [reason, `run row not written: ${recordError}`],
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
				sourceConfig: sourceConfigFor(appConfig, entry.sourceKey),
				config: async (name) => collectorScalar(appConfig, entry.sourceKey, name),
				fetch: fetchImpl,
				...(options.signal ? { signal: options.signal } : {}),
				log: (msg, fields) => log(msg, { collector: collector.id, ...fields }),
			};

			const attemptStartedAt = now();
			let result: CollectorResult;
			try {
				result = await withDeadline(
					collector.id,
					options.collectorDeadlineMs ?? DEFAULT_COLLECTOR_DEADLINE_MS,
					() => collector.collect(ctx),
				);
			} catch (err) {
				const finishedAt = now();
				const message = scrubSecrets(err instanceof Error ? err.message : String(err));
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
				const recordError = await record({ ...failed, cursor: undefined });
				log("collector failed", { collector: collector.id, error: message });
				return failure(
					recordError === undefined
						? message
						: message + '; and its run row could not be written: ' + recordError,
					{ latencyMs: failed.latencyMs },
				);
			}

			if (result.health === "FAILED") {
				const recordError = await record({ ...result, cursor: undefined });
				/*
				 * Both failures matter and they are not interchangeable. The
				 * collector's own error is what an operator acts on; the bookkeeping
				 * failure explains why the run row does not say so. Reporting only
				 * the second would lose the 401 that actually stopped the collector.
				 */
				const collectorError = result.error ?? "collector reported FAILED";
				return failure(
					recordError === undefined
						? collectorError
						: `${collectorError}; and its run row could not be written: ${recordError}`,
					{
						itemsFetched: result.itemsFetched,
						warnings: result.warnings,
						latencyMs: result.latencyMs,
					},
				);
			}

			// The collection_runs row has to exist before raw items can reference it,
			// but it is written WITHOUT the cursor first: the cursor is only
			// advanced once the data it describes is durably stored, so a crash
			// half way through persistence re-reads the same window next time.
			const openError = await record({ ...result, cursor: undefined });
			// Nothing may be persisted without that row: raw_items references it.
			if (openError) {
				return failure(openError, { itemsFetched: result.itemsFetched, latencyMs: result.latencyMs });
			}

			let inserted = 0;
			let factsInserted = 0;
			/** Problems found while storing, which belong on this run's row. */
			const persistWarnings: string[] = [];
			try {
				const refs = await options.store.persistRaw(result.items, collectionRunId);
				inserted = refs.filter((r) => r.inserted).length;
				const normalized = result.items.map(toNormalizedItem);
				const rawIds = new Map(refs.map((r) => [itemIdFor(r.sourceType, r.externalId), r.rawItemId]));
				await options.store.persistItems(normalized, rawIds);
				for (const item of result.items) {
					if (item.sourceType === "arxiv") arxivExternalIds.push(item.externalId);
				}

				/*
				 * A fact that NAMES a source item must resolve to one: a citation
				 * that goes nowhere would reach the manifest and the agent would be
				 * shown provenance it cannot follow.
				 *
				 * A fact that names none is not dangling. `toStructuredFact` derives
				 * its id from the fact's own external id, so the reading is its own
				 * record -- which is the normal shape for an observation nobody
				 * wrote an article about. Membership-testing those too is what
				 * silently emptied the entire numeric layer: `sec` is the only
				 * collector that sets `sourceExternalId`, so every CoinGecko and FRED
				 * fact failed a test it was never meant to take, on every run, with
				 * no warning and no row.
				 */
				const knownItemIds = new Set(normalized.map((i) => i.id));
				const facts: StructuredFact[] = [];
				for (const fact of result.facts) {
					const converted = toStructuredFact(fact, collector.sourceType);
					if (fact.sourceExternalId !== undefined && !knownItemIds.has(converted.sourceItemId)) {
						// Named an item that did not arrive: worth saying out loud
						// rather than dropping in silence, which is the bug above.
						persistWarnings.push(
							`fact ${fact.externalId} names source item ${fact.sourceExternalId}, which was not collected; fact dropped`,
						);
						continue;
					}
					facts.push(converted);
				}
				await options.store.persistFacts(facts);
				factsInserted = facts.length;
			} catch (err) {
				const message = scrubSecrets(err instanceof Error ? err.message : String(err));
				log("collector persistence failed", { collector: collector.id, error: message });
				return failure(message, {
					itemsFetched: result.itemsFetched,
					warnings: result.warnings,
					latencyMs: result.latencyMs,
				});
			}

			// Everything landed: now the cursor may move.
			let cursorAdvanced = false;
			if (result.cursor !== undefined) {
				const cursorError = await record(result);
				if (cursorError) {
					// The data is durable and the cursor is not, so the next run re-reads
					// this window. That is the safe direction, but it is still a failure
					// of this collector's run and has to be visible as one.
					return failure(cursorError, {
						itemsFetched: result.itemsFetched,
						itemsInserted: inserted,
						factsInserted,
						warnings: [...result.warnings, ...persistWarnings],
						latencyMs: result.latencyMs,
					});
				}
				cursorAdvanced = true;
			}

			return {
				...base,
				health: result.health,
				itemsFetched: result.itemsFetched,
				itemsInserted: inserted,
				factsInserted,
				warnings: [...result.warnings, ...persistWarnings],
				...(result.error === undefined ? {} : { error: result.error }),
				cursorAdvanced,
				latencyMs: result.latencyMs,
			};
		},
	);

	const active = outcomes.filter((o) => o.health !== "DISABLED");
	const empty = active.length === 0 || active.every((o) => o.itemsFetched === 0);

	const silentCollectors = active
		.filter(
			(o) =>
				(o.health === "OK" || o.health === "DEGRADED") &&
				o.itemsFetched === 0 &&
				!MAY_BE_QUIET.has(o.sourceType),
		)
		.map((o) => o.collectorId)
		.sort();

	/*
	 * Emptiness used to count as a problem only when something had also FAILED,
	 * which inverted the logic: the ways a pipeline goes quietly blind -- a token
	 * that now returns 200 with an empty array, every request answered 304, a
	 * watermark stuck in the future -- all produce collectors that succeed and
	 * return nothing. Those are exactly the runs the old condition waved through.
	 */
	const suspiciousReason =
		active.length === 0
			? "no collector was enabled for this run"
			: empty
				? `every enabled collector returned zero items (${active.map((o) => o.collectorId).join(", ")})`
				: undefined;

	const degraded = outcomes.some((o) => o.health === "FAILED") || suspiciousReason !== undefined;

	return {
		startedAt,
		finishedAt: now().toISOString(),
		degraded,
		empty,
		...(suspiciousReason === undefined ? {} : { suspiciousReason }),
		silentCollectors,
		outcomes,
		itemsInserted: outcomes.reduce((sum, o) => sum + o.itemsInserted, 0),
		arxivExternalIds,
	};
}

/**
 * Production entry point: arXiv runs first so its external ids can seed the
 * Semantic Scholar worklist, then the rest of the registry runs as one pool.
 */
/**
 * An enabled source with no collector behind it is the one gap a collection run
 * cannot otherwise see: it produces no row, no warning and no item, so the run
 * looks complete while a whole source is silently missing. This names it as a
 * DISABLED outcome instead, with the reason a reader needs.
 */
export function unimplementedOutcomes(
	enabledSourceKeys: readonly string[],
	entries: readonly RegistryEntry[],
): CollectorOutcome[] {
	const registered = new Set(entries.map((e) => e.sourceKey));
	return [...new Set(enabledSourceKeys)]
		.filter((key) => !registered.has(key))
		.sort()
		.map((sourceKey) => {
			const reason = `enabled in config/sources.yaml but no collector is registered for source "${sourceKey}"`;
			return {
				collectorId: sourceKey,
				sourceType: sourceKey,
				health: "DISABLED" as const,
				itemsFetched: 0,
				itemsInserted: 0,
				factsInserted: 0,
				warnings: [reason],
				disabledReason: reason,
				cursorAdvanced: false,
				collectionRunId: "",
				latencyMs: 0,
			};
		});
}

export async function runCollectionForDay(
	options: Omit<CollectionOptions, "entries"> & { entries?: readonly RegistryEntry[] },
): Promise<CollectionSummary> {
	if (options.entries) return runCollection(options);

	/*
	 * One resolution for both passes. The config file was read from disk up to
	 * three times and the cursor table queried twice for what is one run, and
	 * the two passes disagreeing about either would be a genuinely confusing
	 * failure -- the second half of a run built against a different config than
	 * the first.
	 */
	const appConfig = options.appConfig ?? loadConfig();
	const enabledSourceKeys = options.enabledSourceKeys ?? resolveEnabledSources(appConfig);
	const cursors = options.cursors ?? (await options.store.loadCursors());
	const registry = buildRegistry();
	const shared = { ...options, appConfig, enabledSourceKeys, cursors };

	const arxivEntry = registry.find((e) => e.sourceKey === "arxiv")!;
	const first = await runCollection({ ...shared, entries: [arxivEntry] });
	const arxivIds = first.arxivExternalIds;

	const rest = await runCollection({
		...shared,
		entries: buildRegistry({ arxivIds }).filter((e) => e.sourceKey !== "arxiv"),
	});

	const missing = unimplementedOutcomes(enabledSourceKeys, registry);

	// The two passes are halves of one run, so emptiness is only real when both
	// halves are empty -- and the suspicion that follows from it has to be
	// recomputed here rather than inherited from a half that was empty alone.
	const empty = first.empty && rest.empty;
	const suspiciousReason = empty
		? (first.suspiciousReason ?? rest.suspiciousReason ?? "every enabled collector returned zero items")
		: undefined;

	return {
		startedAt: first.startedAt,
		finishedAt: rest.finishedAt,
		degraded: first.outcomes.concat(rest.outcomes).some((o) => o.health === "FAILED") || empty,
		empty,
		...(suspiciousReason === undefined ? {} : { suspiciousReason }),
		silentCollectors: [...new Set([...first.silentCollectors, ...rest.silentCollectors])].sort(),
		outcomes: [...first.outcomes, ...rest.outcomes, ...missing],
		itemsInserted: first.itemsInserted + rest.itemsInserted,
		arxivExternalIds: arxivIds,
	};
}
