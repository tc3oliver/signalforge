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

	const tools = [...createCuratorTools(ctx), createSkillReferenceTool(bundle)];

	const systemPrompt = buildCuratorSystemPrompt({
		date: opts.date,
		totalItems: opts.manifest.items.length,
		skillSection: renderSkillSection(bundle),
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
			if (current.size === lastProgress) {
				stalls += 1;
				if (stalls >= 2) {
					throw new ToolLoopError(
						`Curator made no progress across ${stalls + 1} turns at ${current.size}/${opts.manifest.items.length} items decided`,
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

			await withTurnTimeout(driver, "curator", opts.timeoutMs, () =>
				driver.prompt(
					buildCuratorNudgePrompt({
					unseenItems: opts.manifest.items.length - current.size,
						totalItems: opts.manifest.items.length,
						storyCount: storyList.length,
					}),
				),
			);
			if (faultError) throw faultError;
		}

		if (!ctx.submitted) {
			const current = await opts.repo.processedItemIds(opts.date);
			throw new InvalidAgentOutputError(
				`Curator did not call submit_materials after ${maxNudges} nudges (${current.size}/${opts.manifest.items.length} items decided)`,
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
