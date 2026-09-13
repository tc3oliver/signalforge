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

export const Stage = z.enum(["CURATOR", "EDITOR"]);
export type Stage = z.infer<typeof Stage>;

export const AttemptStatus = z.enum(["SUCCESS", "FAILED"]);

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
	})
	.strict();
export type RunState = z.infer<typeof RunState>;
