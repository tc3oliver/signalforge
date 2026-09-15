import { z } from "zod";
import { SourceType } from "../schemas/item.ts";

/**
 * Every YAML config file gets a `.strict()` schema so a typo'd key (e.g.
 * `enbaled` instead of `enabled`) fails a test instead of silently being
 * ignored at runtime.
 */

// ---------------------------------------------------------------- interests

export const InterestTopic = z
	.object({
		id: z.string().min(1),
		label: z.string().min(1),
		weight: z.number().min(0).max(1),
		keywords: z.array(z.string().min(1)).default([]),
		aliases: z.array(z.string().min(1)).default([]),
	})
	.strict();
export type InterestTopic = z.infer<typeof InterestTopic>;

export const InterestsConfig = z
	.object({
		topics: z.array(InterestTopic).min(1),
		/*
		 * Who the brief is written for, in one sentence. Optional because the
		 * Editor has always had a reader -- it was a sentence compiled into the
		 * prompt -- and a profile that declines to describe one must not leave it
		 * with none. See DEFAULT_PERSONA in src/profile/reader-profile.ts.
		 */
		persona: z.string().min(1).optional(),
	})
	.strict();
export type InterestsConfig = z.infer<typeof InterestsConfig>;

// --------------------------------------------------------------- watchlists

const CikString = z.string().regex(/^\d{10}$/, "CIK must be a 10-digit zero-padded string");

export const WatchlistsConfig = z
	.object({
		github_repos: z.array(z.string().min(1)).default([]),
		sec_companies: z
			.array(
				z
					.object({
						ticker: z.string().min(1),
						name: z.string().min(1),
						cik: CikString.nullable().default(null),
					})
					.strict(),
			)
			.default([]),
		crypto_assets: z
			.array(
				z
					.object({
						id: z.string().min(1),
						symbol: z.string().min(1),
					})
					.strict(),
			)
			.default([]),
		fred_series: z
			.array(
				z
					.object({
						id: z.string().min(1),
						label: z.string().min(1),
					})
					.strict(),
			)
			.default([]),
		subreddits: z.array(z.string().min(1)).default([]),
		youtube_channels: z.array(z.string().min(1)).default([]),
		arxiv_categories: z.array(z.string().min(1)).default([]),
	})
	.strict();
export type WatchlistsConfig = z.infer<typeof WatchlistsConfig>;

// ------------------------------------------------------------------ sources

// SEC EDGAR's fair-access policy requires every requester to identify itself
// with a descriptive contact User-Agent (see https://www.sec.gov/os/webmaster-faq#code-support).
// It is a public, loggable string, not a credential — modeled as a typed config
// field rather than routed through secrets.ts. Reject anything that doesn't at
// least look like "Name email@example.com": a malformed UA gets the user
// rate-limited or IP-blocked by SEC rather than failing loudly here.
const SecUserAgent = z
	.string()
	.min(1)
	.regex(
		/\S+@\S+\.\S+/,
		'SEC requires a descriptive contact User-Agent containing an email address, e.g. "Your Name you@example.com"',
	);

export const CollectorSourceConfig = z
	.object({
		enabled: z.boolean(),
		baseUrl: z.string().optional(),
		rateLimitPerMinute: z.number().int().positive(),
		timeoutMs: z.number().int().positive(),
		pageSize: z.number().int().positive(),
		requiredSecrets: z.array(z.string().min(1)).default([]),
		/** SEC-only: mandatory contact User-Agent. See {@link SecUserAgent}. */
		userAgent: SecUserAgent.optional(),
	})
	.strict();
export type CollectorSourceConfig = z.infer<typeof CollectorSourceConfig>;

/** One entry per {@link SourceType} value — enforced by `.strict()` plus a superRefine below. */
export const SourcesConfig = z
	.object({
		collectors: z.record(SourceType, CollectorSourceConfig),
	})
	.strict()
	.superRefine((value, ctx) => {
		for (const sourceType of SourceType.options) {
			if (!(sourceType in value.collectors)) {
				ctx.addIssue({
					code: "custom",
					message: `Missing collector config for source type "${sourceType}"`,
					path: ["collectors", sourceType],
				});
			}
		}
		// SEC collection is not allowed to run without a valid contact UA, so an
		// enabled sec collector with no userAgent is a config error, not a
		// runtime surprise. Ship it disabled until the user supplies their own.
		const sec = value.collectors.sec;
		if (sec?.enabled && !sec.userAgent) {
			ctx.addIssue({
				code: "custom",
				message:
					'SEC collector is enabled but has no "userAgent" configured; SEC policy requires a descriptive contact User-Agent for every request',
				path: ["collectors", "sec", "userAgent"],
			});
		}
	});
export type SourcesConfig = z.infer<typeof SourcesConfig>;

// --------------------------------------------------------------- discovery

export const DiscoveryQuery = z
	.object({
		id: z.string().min(1),
		query: z.string().min(1),
		schedule: z.enum(["hourly", "daily", "weekly"]),
		maxResults: z.number().int().positive(),
		topicIds: z.array(z.string().min(1)).default([]),
	})
	.strict();
export type DiscoveryQuery = z.infer<typeof DiscoveryQuery>;

export const DiscoveryConfig = z
	.object({
		queries: z.array(DiscoveryQuery).default([]),
	})
	.strict();
export type DiscoveryConfig = z.infer<typeof DiscoveryConfig>;

// -------------------------------------------------------------------- agent

export const ModelSpecConfig = z
	.object({
		provider: z.string().min(1),
		model: z.string().min(1),
	})
	.strict();
export type ModelSpecConfig = z.infer<typeof ModelSpecConfig>;

export const StageConfig = z
	.object({
		timeoutMs: z.number().int().positive(),
		maxAttemptsPerModel: z.number().int().positive(),
		maxNudges: z.number().int().min(0),
	})
	.strict();
export type StageConfig = z.infer<typeof StageConfig>;

export const SearchWebConfig = z
	.object({
		maxQueryLength: z.number().int().positive(),
		maxResults: z.number().int().positive(),
		timeoutMs: z.number().int().positive(),
		maxCallsPerStory: z.number().int().positive(),
		maxCallsPerRun: z.number().int().positive(),
	})
	.strict();
export type SearchWebConfig = z.infer<typeof SearchWebConfig>;

export const AgentConfig = z
	.object({
		modelChain: z.array(ModelSpecConfig).min(1),
		stages: z
			.object({
				CURATOR: StageConfig,
				EDITOR: StageConfig,
			})
			.strict(),
		searchWeb: SearchWebConfig,
	})
	.strict();
export type AgentConfig = z.infer<typeof AgentConfig>;

// ---------------------------------------------------------------- combined

export const AppConfig = z
	.object({
		interests: InterestsConfig,
		watchlists: WatchlistsConfig,
		sources: SourcesConfig,
		discovery: DiscoveryConfig,
		agent: AgentConfig,
	})
	.strict();
export type AppConfig = z.infer<typeof AppConfig>;
