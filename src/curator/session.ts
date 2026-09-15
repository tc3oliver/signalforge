import type { DailyManifest, DailyMaterials } from "../schemas/index.ts";
import type { StoryRepository } from "../stories/repository.ts";
import type { AgentDriverFactory } from "../runtime/agent-driver.ts";
import type { ModelSpec } from "../runtime/model-config.ts";
import { InvalidAgentOutputError, ToolLoopError } from "../runtime/error-classifier.ts";
import { loadProjectSkills } from "../runtime/pi-runtime.ts";
import { withTurnTimeout } from "../runtime/turn-timeout.ts";
import {
	createSkillReferenceTool,
	loadSkillBundle,
	renderSkillSection,
} from "../runtime/skill-access.ts";
import { createCuratorTools, type CuratorContext } from "./tools.ts";
import { renderReaderProfile, type ReaderProfile } from "../profile/reader-profile.ts";
import {
	buildCuratorNudgePrompt,
	buildCuratorResumePrompt,
	buildCuratorSystemPrompt,
	buildCuratorTaskPrompt,
} from "./prompt.ts";

export interface CuratorStageOptions {
	date: string;
	manifest: DailyManifest;
	repo: StoryRepository;
	spec: ModelSpec;
	skillsRoot: string;
	cwd: string;
	driverFactory: AgentDriverFactory;
	/**
	 * The reader's standing interests, as priors on relevance. Optional: a run
	 * without a config gets the prompt it always got, rather than a profile block
	 * asserting the reader cares about nothing.
	 */
	readerProfile?: ReaderProfile;
	/** "FRESH" starts the task from the top; the others carry context into a new session. */
	mode: "FRESH" | "CORRECTIVE" | "RESUME";
	/** Rejection text from a previous attempt, fed back so the retry is informed. */
	lastError?: string;
	now?: () => Date;
	maxNudges?: number;
	/** Bound on a single model turn; see runtime/turn-timeout.ts. */
	timeoutMs?: number;
	onEvent?: (event: Record<string, unknown>) => void;
	onText?: (delta: string) => void;
	/**
	 * Test-only fault injection checkpoint (see `runtime/fault-injection.ts`).
	 * Throws a synthetic, classifier-real error once the recorded decisions reach
	 * the configured threshold; a no-op when fault injection is off.
	 */
	checkFault?: (processedItems: number) => void;
}

export interface CuratorStageResult {
	materials: DailyMaterials;
	toolCalls: number;
	activeToolNames: string[];
}

/**
 * Drives one curator attempt on one model. Fallback across models happens a level
 * up in runStageWithFallback — this function either produces accepted materials or
 * throws a classified error.
 */
export async function runCuratorStage(opts: CuratorStageOptions): Promise<CuratorStageResult> {
	const now = opts.now ?? (() => new Date());
	const maxNudges = opts.maxNudges ?? 6;

	const skills = loadProjectSkills(opts.skillsRoot);
	const bundle = loadSkillBundle(skills[0]!);

	let toolCalls = 0;
	// An injected failure has to survive being thrown from inside a tool: Pi hands
	// a thrown tool error back to the model as a correctable result, so the first
	// throw is remembered here and re-thrown at every later boundary. The model
	// can then make no further progress, the turn ends, and the attempt fails with
	// the injected error -- exactly as a real provider outage would end it.
	let faultError: Error | undefined;
	const ctx: CuratorContext = {
		date: opts.date,
		manifest: opts.manifest,
		repo: opts.repo,
		now,
		...(opts.readerProfile
			? { topicIds: new Set(opts.readerProfile.topics.map((t) => t.id)) }
			: {}),
		onToolCall: (name, summary) => {
			toolCalls += 1;
			opts.onEvent?.({ kind: "tool_call", stage: "CURATOR", tool: name, ...summary });
		},
		...(opts.checkFault
			? {
					onToolBoundary: async () => {
						if (faultError) throw faultError;
						try {
							opts.checkFault?.((await opts.repo.processedItemIds(opts.date)).size);
						} catch (err) {
							faultError = err instanceof Error ? err : new Error(String(err));
							throw faultError;
						}
					},
				}
			: {}),
	};

	// A submit_materials rejection reaches the model once, as a tool-error result.
	// Capturing it here is what lets the next nudge — and the eventual failure —
	// say what was actually wrong instead of "you have not submitted yet".
	// `lastError` is cleared once fed back; `lastRejection` is kept for the error.
	let lastError: string | undefined;
	let lastRejection: string | undefined;
	let rejectedSubmissions = 0;

	const curatorTools = createCuratorTools(ctx).map((tool) => {
		if (tool.name !== "submit_materials") return tool;
		const inner = tool.execute.bind(tool);
		return {
			...tool,
			execute: async (...args: Parameters<typeof inner>) => {
				try {
					return await inner(...args);
				} catch (err) {
					rejectedSubmissions += 1;
					lastError = err instanceof Error ? err.message : String(err);
					lastRejection = lastError;
					opts.onEvent?.({ kind: "submit_rejected", stage: "CURATOR", error: lastError });
					throw err;
				}
			},
		};
	});

	const tools = [...curatorTools, createSkillReferenceTool(bundle)];

	const systemPrompt = buildCuratorSystemPrompt({
		date: opts.date,
		totalItems: opts.manifest.items.length,
		skillSection: renderSkillSection(bundle),
		...(opts.readerProfile ? { readerProfile: renderReaderProfile(opts.readerProfile) } : {}),
	});

	const driver = await opts.driverFactory({
		spec: opts.spec,
		systemPrompt,
		customTools: tools,
		skillsRoot: opts.skillsRoot,
		cwd: opts.cwd,
		onText: opts.onText,
	});

	try {
		const processed = await opts.repo.processedItemIds(opts.date);
		const stories = await opts.repo.listStories(opts.date);

		// A resume picks up durable state rather than replaying the day; a half-dead
		// conversation is never migrated to another model.
		const opening =
			opts.mode === "RESUME" && processed.size > 0
				? buildCuratorResumePrompt({
						date: opts.date,
						unseenItems: opts.manifest.items.length - processed.size,
						totalItems: opts.manifest.items.length,
						storyCount: stories.length,
					})
				: opts.mode === "CORRECTIVE" && opts.lastError
					? `${buildCuratorTaskPrompt({
							date: opts.date,
							totalItems: opts.manifest.items.length,
							skillSection: "",
						})}\n\nA previous attempt failed with:\n${opts.lastError}\nAvoid repeating that mistake.`
					: buildCuratorTaskPrompt({
							date: opts.date,
							totalItems: opts.manifest.items.length,
							skillSection: "",
						});

		await withTurnTimeout(driver, "curator", opts.timeoutMs, () => driver.prompt(opening));
		if (faultError) throw faultError;
		opts.checkFault?.((await opts.repo.processedItemIds(opts.date)).size);

		let nudges = 0;
		let lastProgress = -1;
		let stalls = 0;

		while (!ctx.submitted && nudges < maxNudges) {
			const current = await opts.repo.processedItemIds(opts.date);
			const storyList = await opts.repo.listStories(opts.date);
			if (faultError) throw faultError;
			opts.checkFault?.(current.size);

			// No new decisions since the last turn means the model is circling rather
			// than working. Two of those is a tool loop, not a slow start.
			//
			// Only while coverage is incomplete, though: once every item has a
			// decision this number is pinned at totalItems by definition, so a model
			// iterating on a rejected payload would look stalled forever. That
			// failure is a submission-shape failure, and the router has to be told
			// so — a resume prompt would send it back to `list_unseen_items` when
			// there is nothing unseen.
			if (current.size === lastProgress) {
				stalls += 1;
				if (stalls >= 2) {
					if (current.size < opts.manifest.items.length) {
						throw new ToolLoopError(
							`Curator made no progress across ${stalls + 1} turns at ${current.size}/${opts.manifest.items.length} items decided`,
						);
					}
					throw new InvalidAgentOutputError(
						`Curator scanned all ${opts.manifest.items.length} items but did not produce accepted materials across ${stalls + 1} turns (${rejectedSubmissions} rejected submissions)` +
							(lastRejection
								? `. Last rejection: ${lastRejection}`
								: ". It never called submit_materials."),
					);
				}
			} else {
				stalls = 0;
			}
			lastProgress = current.size;

			nudges += 1;
			opts.onEvent?.({
				kind: "nudge",
				stage: "CURATOR",
				attempt: nudges,
				processed: current.size,
				total: opts.manifest.items.length,
			});

			// Consumed before the turn: the submit_materials wrapper sets `lastError`
			// from inside it, so clearing afterwards would erase a rejection raised
			// during this nudge before the next prompt could carry it.
			const feedback = lastError;
			lastError = undefined;
			await withTurnTimeout(driver, "curator", opts.timeoutMs, () =>
				driver.prompt(
					buildCuratorNudgePrompt({
						unseenItems: opts.manifest.items.length - current.size,
						totalItems: opts.manifest.items.length,
						storyCount: storyList.length,
						lastError: feedback,
					}),
				),
			);
			if (faultError) throw faultError;
		}

		if (!ctx.submitted) {
			const current = await opts.repo.processedItemIds(opts.date);
			throw new InvalidAgentOutputError(
				`Curator did not produce accepted materials after ${maxNudges} nudges (${current.size}/${opts.manifest.items.length} items decided, ${rejectedSubmissions} rejected submissions)` +
					(lastRejection
						? `. Last rejection: ${lastRejection}`
						: ". It never called submit_materials."),
			);
		}

		return {
			materials: ctx.submitted,
			toolCalls,
			activeToolNames: driver.getActiveToolNames(),
		};
	} finally {
		driver.dispose();
	}
}
