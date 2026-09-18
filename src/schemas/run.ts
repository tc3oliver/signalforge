import { z } from "zod";

export const RunStatus = z.enum([
	"CREATED",
	"COLLECTING",
	"COLLECTED",
	"CURATING",
	"MATERIALS_READY",
	"WRITING",
	"DRAFT_READY",
	"VALIDATING",
	"PUBLISHED",
	// Kept for back-compat with rows/readers written before PUBLISHED existed.
	"COMPLETED",
	"COLLECTION_FAILED",
	"CURATION_FAILED",
	"EDITOR_FAILED",
	"VALIDATION_FAILED",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const FailureClass = z.enum([
	"NETWORK",
	"TIMEOUT",
	"RATE_LIMIT",
	"QUOTA",
	"BILLING",
	"SERVER_ERROR",
	"MODEL_UNAVAILABLE",
	"AUTH",
	"CONTEXT_OVERFLOW",
	"INVALID_AGENT_OUTPUT",
	"TOOL_LOOP",
	"USER_ABORT",
	"PROGRAMMER_ERROR",
	"UNKNOWN",
]);
export type FailureClass = z.infer<typeof FailureClass>;

/*
 * SCREENER is the cheap model screening pass (src/screening/). It is a stage
 * for telemetry purposes -- wall clock and token usage attributable beside the
 * Curator and Editor -- and not a stage of the model chain: it never falls back
 * across providers, because a measurement that retries across three providers
 * is measuring the retry.
 */
export const Stage = z.enum(["SCREENER", "CURATOR", "EDITOR"]);
export type Stage = z.infer<typeof Stage>;

/*
 * YIELDED is not a failure and must never be counted as one.
 *
 * It records a turn that stopped because it reached its work-unit ceiling with
 * items still undecided, having committed real decisions along the way. Before
 * it existed those turns were written down as FAILED/TIMEOUT, which is how the
 * 2026-09-16 run burned three models in 28 minutes while every one of them was
 * working correctly. A reader counting failures, or a report counting
 * fallbacks, has to be able to tell the two apart from the row alone.
 */
export const AttemptStatus = z.enum(["SUCCESS", "FAILED", "YIELDED"]);

/**
 * Provider-reported token usage, summed over the responses in one attempt.
 *
 * Absent -- not zero -- when nothing reported it. The Pi SDK delivers the
 * provider's own `Usage` on every assistant `message_end`; the screener reads
 * the `usage` block of each chat-completions response. Both are the provider's
 * statement, never an estimate of context occupancy. `reportedBy` counts the
 * responses that contributed, so a partial sum is visibly partial.
 */
export const TokenUsage = z
	.object({
		input: z.number().int().nonnegative(),
		output: z.number().int().nonnegative(),
		cacheRead: z.number().int().nonnegative(),
		cacheWrite: z.number().int().nonnegative(),
		totalTokens: z.number().int().nonnegative(),
		reportedBy: z.number().int().positive(),
	})
	.strict();
export type TokenUsage = z.infer<typeof TokenUsage>;

export const AgentAttempt = z
	.object({
		attemptId: z.string(),
		stage: Stage,
		provider: z.string(),
		model: z.string(),
		startedAt: z.string(),
		finishedAt: z.string(),
		durationMs: z.number(),
		status: AttemptStatus,
		failureClass: FailureClass.optional(),
		fallbackReason: z.string().optional(),
		/** Sanitized error metadata — never credentials, never raw headers. */
		errorMeta: z.record(z.string(), z.unknown()).optional(),
		/** See {@link TokenUsage}. Absent when the provider reported nothing. */
		tokenUsage: TokenUsage.optional(),
		/**
		 * Present only when this failure was a test-only synthetic fault (see
		 * `src/runtime/fault-injection.ts`), never a real provider error. A report
		 * must treat an attempt carrying this field as a manufactured fallback, not
		 * evidence of a spontaneous one.
		 */
		faultInjected: z
			.object({
				stage: Stage,
				model: z.string(),
				failureClass: FailureClass,
				afterProcessedItems: z.number(),
				firedAtProcessedItems: z.number(),
			})
			.strict()
			.optional(),
	})
	.strict();
export type AgentAttempt = z.infer<typeof AgentAttempt>;

export const RunState = z
	.object({
		runId: z.string(),
		date: z.string(),
		status: RunStatus,
		createdAt: z.string(),
		updatedAt: z.string(),
		totalItems: z.number(),
		processedItems: z.number(),
		storyCount: z.number(),
		failureReason: z.string().optional(),
		/**
		 * Orthogonal to `status`: non-null means the run is DEGRADED (e.g. one
		 * collector failed) *and* says why, independent of whether it still
		 * reached PUBLISHED. Null/absent means healthy.
		 */
		degradedReason: z.string().optional(),
		/**
		 * The run whose durable state this one continues, when it continues one.
		 *
		 * A recovery run reuses the decisions, ledger and topic attributions the
		 * named run already committed for the same (lineage, date), and leaves that
		 * run's own final status alone. The alternative -- re-running the failed id
		 * back to PUBLISHED -- is allowed by the state machine and silently deletes
		 * the record that the day ever failed.
		 */
		resumedFromRunId: z.string().optional(),
	})
	.strict();
export type RunState = z.infer<typeof RunState>;
