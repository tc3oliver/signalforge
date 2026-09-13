import { z } from "zod";
import { CollectedItem, UNTRUSTED_EXTERNAL_CONTENT } from "../collectors/types.ts";
import type { FailureClass } from "../schemas/run.ts";

/** The two providers this layer knows how to speak to, in fallback order. */
export const ResearchProviderName = z.enum(["tavily", "exa"]);
export type ResearchProviderName = z.infer<typeof ResearchProviderName>;

/**
 * One search hit, normalized across providers but still carrying the
 * verbatim provider payload so nothing is lost on the way to the curator.
 */
export const ResearchResult = z.object({
	provider: ResearchProviderName,
	query: z.string().min(1),
	title: z.string().min(1),
	url: z.string().min(1),
	snippet: z.string(),
	publishedAt: z.string().optional(),
	/** When this record was retrieved from the provider, not when it was published. */
	retrievedAt: z.string().min(1),
	/** Verbatim provider payload for this single record. Never edited, never trusted. */
	raw: z.unknown(),
});
export type ResearchResult = z.infer<typeof ResearchResult>;

export interface ResearchSearchOptions {
	maxResults?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
}

/**
 * Secret access shaped to match `CollectorContext.secret`/`hasSecret` so this
 * layer stays decoupled from whoever owns `src/config/secrets.ts`.
 */
export interface SecretResolver {
	/** Resolves a secret by logical name; throws if absent. Never logs the value. */
	secret: (name: string) => Promise<string>;
	/** Whether a secret exists, without reading it. */
	hasSecret: (name: string) => Promise<boolean>;
}

/** A single provider backend: search plus a cheap credential/health probe. */
export interface ResearchProvider {
	readonly name: ResearchProviderName;
	search(query: string, opts: ResearchSearchOptions): Promise<ResearchResult[]>;
	check(): Promise<{ ok: boolean; detail: string }>;
}

/** Thrown by a provider when its secret cannot be resolved before any HTTP call is made. */
export class ProviderCredentialError extends Error {
	override readonly name = "ProviderCredentialError";
	constructor(provider: ResearchProviderName, options?: { cause?: unknown }) {
		// Phrased to hit the existing AUTH heuristics in classifyMessage
		// (see src/runtime/error-classifier.ts) rather than inventing a new
		// failure vocabulary.
		super(`${provider}: unauthorized - invalid api key or credential resolution failed`, options);
	}
}

/** Thrown when a provider's response body cannot be parsed as the shape it promises. */
export class ProviderResponseError extends Error {
	override readonly name = "ProviderResponseError";
	constructor(provider: ResearchProviderName, detail: string, options?: { cause?: unknown }) {
		super(`${provider}: malformed response - ${detail}`, options);
	}
}

/** Why a research run did not use its primary provider, or used none at all. */
export type DegradedReason =
	| "TAVILY_CREDENTIAL_MISSING"
	| "TAVILY_AUTH_FAILED"
	| "TAVILY_RATE_LIMITED"
	| "TAVILY_TIMEOUT"
	| "TAVILY_MALFORMED_RESPONSE"
	| "TAVILY_UNAVAILABLE"
	| "BOTH_UNAVAILABLE";

export interface ProviderAttempt {
	provider: ResearchProviderName;
	outcome: "SUCCESS" | "FAILURE";
	failureClass?: FailureClass;
	/** Machine-readable, admin-safe reason distinct from the generic failureClass bucket. */
	reason?: string;
	durationMs: number;
}

/** Structured outcome the caller records; research never throws to escape this shape. */
export type ResearchOutcome =
	| {
			status: "OK";
			results: ResearchResult[];
			degraded: boolean;
			degradedReason?: DegradedReason;
			providerUsed: ResearchProviderName;
			attempts: ProviderAttempt[];
	  }
	| {
			status: "DEGRADED_EMPTY";
			degradedReason: "BOTH_UNAVAILABLE";
			attempts: ProviderAttempt[];
	  }
	| {
			status: "REFUSED";
			reason: "QUERY_TOO_LONG" | "TOO_MANY_RESULTS_REQUESTED" | "STORY_CALL_BUDGET_EXCEEDED" | "RUN_CALL_BUDGET_EXCEEDED";
			message: string;
	  };

export interface ResearchBudgets {
	/** Maximum characters allowed in a query string. */
	maxQueryLength: number;
	/** Maximum results a single search() call may request. */
	maxResults: number;
	/** Per-request timeout, in ms, passed through to the HTTP layer. */
	perRequestTimeoutMs: number;
	/** Maximum provider calls (including fallback) attributable to one story. */
	maxCallsPerStory: number;
	/** Maximum provider calls (including fallback) across the whole run. */
	maxCallsPerRun: number;
}

/** Converts a research result into the shape the curator treats uniformly with collector output. */
export function toCollectedItem(result: ResearchResult): CollectedItem {
	return CollectedItem.parse({
		sourceType: "web",
		sourceName: result.provider,
		externalId: result.url,
		title: result.title,
		summary: result.snippet,
		url: result.url,
		publishedAt: result.publishedAt ?? result.retrievedAt,
		metadata: {
			query: result.query,
			provider: result.provider,
			retrievedAt: result.retrievedAt,
		},
		trust: UNTRUSTED_EXTERNAL_CONTENT,
		raw: {
			externalId: result.url,
			body: result.raw,
			fetchedAt: result.retrievedAt,
		},
	});
}
