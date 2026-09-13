import { z } from "zod";
import { SourceType } from "../schemas/item.ts";
import type { CollectorSourceConfig, WatchlistsConfig } from "../config/schema.ts";

/**
 * Everything a collector emits is external text written by someone else. It is
 * evidence about the world, never an instruction to the agent, and it is tagged as
 * such at the boundary so no later layer has to remember to do it.
 */
export const UNTRUSTED_EXTERNAL_CONTENT = "UNTRUSTED_EXTERNAL_CONTENT" as const;

export const RawPayload = z.object({
	/** The provider's own identifier, used for idempotent upserts. */
	externalId: z.string().min(1),
	/** Verbatim provider response for this record. Never edited, never trusted. */
	body: z.unknown(),
	fetchedAt: z.string().min(1),
});
export type RawPayload = z.infer<typeof RawPayload>;

/**
 * A collector's output before the curator sees it. Normalization is mechanical:
 * field mapping and nothing else. Editorial judgement belongs to Pi, so a collector
 * may never drop an item for being uninteresting.
 */
export const CollectedItem = z.object({
	sourceType: SourceType,
	sourceName: z.string().min(1),
	externalId: z.string().min(1),
	title: z.string().min(1),
	summary: z.string(),
	body: z.string().optional(),
	url: z.string().optional(),
	author: z.string().optional(),
	publishedAt: z.string().min(1),
	/** Provider-specific fields worth keeping; must be JSON-serialisable. */
	metadata: z.record(z.string(), z.unknown()).default({}),
	trust: z.literal(UNTRUSTED_EXTERNAL_CONTENT).default(UNTRUSTED_EXTERNAL_CONTENT),
	raw: RawPayload,
});
export type CollectedItem = z.infer<typeof CollectedItem>;

/** Numeric truth a model is never allowed to invent or restate from memory. */
export const CollectedFact = z.object({
	kind: z.enum(["crypto", "macro", "filing"]),
	label: z.string().min(1),
	value: z.number(),
	unit: z.string(),
	asOf: z.string().min(1),
	externalId: z.string().min(1),
	sourceExternalId: z.string().optional(),
	metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CollectedFact = z.infer<typeof CollectedFact>;

export type CollectorHealth = "OK" | "DEGRADED" | "DISABLED" | "FAILED";

export interface CollectorResult {
	collectorId: string;
	health: CollectorHealth;
	items: CollectedItem[];
	facts: CollectedFact[];
	/** Opaque resume token persisted per collector; undefined means "no cursor". */
	cursor?: string;
	itemsFetched: number;
	/** Non-fatal problems worth surfacing in admin without failing the run. */
	warnings: string[];
	/** Set when health is FAILED or DEGRADED; safe to show in a UI. */
	error?: string;
	startedAt: string;
	finishedAt: string;
	latencyMs: number;
}

export interface CollectorContext {
	/** Inclusive lower bound for incremental collection. */
	since: Date;
	now: () => Date;
	/** Cursor this collector returned last time, if any. */
	cursor?: string;
	/** Resolves a secret by logical name; throws if absent. Never logs the value. */
	secret: (name: string) => Promise<string>;
	/** Whether a secret exists, without reading it. */
	hasSecret: (name: string) => Promise<boolean>;
	/**
	 * This collector's slice of config/watchlists.yaml. The single mechanism for
	 * "what should I track" — a collector never hardcodes a watchlist as a module
	 * constant and never reads the YAML file itself. Tests inject a fixture here
	 * so nothing ever touches the real file.
	 */
	watchlists: WatchlistsConfig;
	/**
	 * This collector's own entry from config/sources.yaml (enabled flag, baseUrl,
	 * rate limit, timeout, page size). Read-only; a collector adjusts its own
	 * behaviour from this rather than re-deriving operational settings itself.
	 */
	sourceConfig: CollectorSourceConfig;
	/**
	 * Non-secret scalar configuration not covered by a typed schema field yet
	 * (e.g. SEC's mandatory contact User-Agent, which is public and loggable,
	 * not a credential). Resolves to undefined when absent — unlike `secret`,
	 * which throws. Never redacted, since by definition it holds no credential.
	 */
	config: (name: string) => Promise<string | undefined>;
	fetch: typeof globalThis.fetch;
	signal?: AbortSignal;
	log: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface Collector {
	readonly id: string;
	readonly sourceType: z.infer<typeof SourceType>;
	/** Logical secret names this collector needs; empty for public sources. */
	readonly requiredSecrets: readonly string[];
	/** Probe configuration and credentials without doing a full collection. */
	check(ctx: CollectorContext): Promise<{ ok: boolean; detail: string }>;
	collect(ctx: CollectorContext): Promise<CollectorResult>;
}
