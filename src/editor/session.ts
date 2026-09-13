import type { DailyBrief, DailyManifest, DailyMaterials } from "../schemas/index.ts";
import type { StoryRepository } from "../stories/repository.ts";
import type { AgentDriverFactory } from "../runtime/agent-driver.ts";
import type { ModelSpec } from "../runtime/model-config.ts";
import { InvalidAgentOutputError } from "../runtime/error-classifier.ts";
import { loadProjectSkills } from "../runtime/pi-runtime.ts";
import {
	createSkillReferenceTool,
	loadSkillBundle,
	renderSkillSection,
} from "../runtime/skill-access.ts";
import { createEditorTools, type EditorContext } from "./tools.ts";
import {
	buildEditorNudgePrompt,
	buildEditorSystemPrompt,
	buildEditorTaskPrompt,
} from "./prompt.ts";

export interface EditorStageOptions {
	date: string;
	manifest: DailyManifest;
	materials: DailyMaterials;
	repo: StoryRepository;
	previousBrief?: DailyBrief;
	spec: ModelSpec;
	skillsRoot: string;
	cwd: string;
	driverFactory: AgentDriverFactory;
	mode: "FRESH" | "CORRECTIVE" | "RESUME";
	lastError?: string;
	now?: () => Date;
	maxNudges?: number;
	onEvent?: (event: Record<string, unknown>) => void;
	onText?: (delta: string) => void;
}

export interface EditorStageResult {
	brief: DailyBrief;
	toolCalls: number;
	/** Rejected submit_brief attempts before the accepted one, for the retry metric. */
	rejectedSubmissions: number;
	activeToolNames: string[];
}

/**
 * The editor always runs in a fresh session built from the materials, so an
 * editor failure never needs conversation surgery — restarting from materials is
 * cheap and loses nothing durable.
 */
export async function runEditorStage(opts: EditorStageOptions): Promise<EditorStageResult> {
	const now = opts.now ?? (() => new Date());
	const maxNudges = opts.maxNudges ?? 4;

	const skills = loadProjectSkills(opts.skillsRoot);
	const bundle = loadSkillBundle(skills[0]!);

	let toolCalls = 0;
	let rejectedSubmissions = 0;
	let lastError: string | undefined = opts.lastError;

	const ctx: EditorContext = {
		date: opts.date,
		manifest: opts.manifest,
		materials: opts.materials,
		repo: opts.repo,
		previousBrief: opts.previousBrief,
		now,
		onToolCall: (name, summary) => {
			toolCalls += 1;
			opts.onEvent?.({ kind: "tool_call", stage: "EDITOR", tool: name, ...summary });
		},
	};

	const tools = createEditorTools(ctx).map((tool) => {
		if (tool.name !== "submit_brief") return tool;
		// Count rejections so the evaluation can report how often structured output
		// needed a corrective round-trip, and carry the message into the next nudge.
		const inner = tool.execute.bind(tool);
		return {
			...tool,
			execute: async (...args: Parameters<typeof inner>) => {
				try {
					return await inner(...args);
				} catch (err) {
					rejectedSubmissions += 1;
					lastError = err instanceof Error ? err.message : String(err);
					opts.onEvent?.({ kind: "submit_rejected", stage: "EDITOR", error: lastError });
					throw err;
				}
			},
		};
	});

	const promptCtx = {
		date: opts.date,
		materialCount: opts.materials.stories.length,
		tierACount: opts.materials.stories.filter((s) => s.tier === "A").length,
		skillSection: renderSkillSection(bundle),
		hasPreviousBrief: Boolean(opts.previousBrief),
	};

	const driver = await opts.driverFactory({
		spec: opts.spec,
		systemPrompt: buildEditorSystemPrompt(promptCtx),
		customTools: [...tools, createSkillReferenceTool(bundle)],
		skillsRoot: opts.skillsRoot,
		cwd: opts.cwd,
		onText: opts.onText,
	});

	try {
		const opening =
			opts.mode !== "FRESH" && opts.lastError
				? `${buildEditorTaskPrompt(promptCtx)}\n\nA previous attempt failed with:\n${opts.lastError}\nAvoid repeating that mistake.`
				: buildEditorTaskPrompt(promptCtx);

		await driver.prompt(opening);

		let nudges = 0;
		while (!ctx.submitted && nudges < maxNudges) {
			nudges += 1;
			opts.onEvent?.({ kind: "nudge", stage: "EDITOR", attempt: nudges });
			await driver.prompt(buildEditorNudgePrompt({ lastError }));
			lastError = undefined;
		}

		if (!ctx.submitted) {
			throw new InvalidAgentOutputError(
				`Editor did not produce an accepted brief after ${maxNudges} nudges (${rejectedSubmissions} rejected submissions)`,
			);
		}

		return {
			brief: ctx.submitted,
			toolCalls,
			rejectedSubmissions,
			activeToolNames: driver.getActiveToolNames(),
		};
	} finally {
		driver.dispose();
	}
}
