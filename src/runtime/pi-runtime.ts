import { homedir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	createExtensionRuntime,
	loadSkillsFromDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ResourceLoader,
	type Skill,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ModelSpec } from "./model-config.ts";
import { modelKey } from "./model-config.ts";

/**
 * The global interactive Pi lives in ~/.pi/agent. We reuse exactly one thing from
 * it — auth.json, so the existing OAuth logins work — and nothing else. Settings,
 * resources, tools and skills are all supplied by this project, in memory, so a
 * Phase 1 run can neither read the user's interactive configuration nor write to it.
 */
const GLOBAL_AGENT_DIR = join(homedir(), ".pi", "agent");
const GLOBAL_AUTH_PATH = join(GLOBAL_AGENT_DIR, "auth.json");
const GLOBAL_MODELS_PATH = join(GLOBAL_AGENT_DIR, "models.json");
const GLOBAL_MODELS_STORE_PATH = join(GLOBAL_AGENT_DIR, "models-store.json");

export class RestrictedRuntimeError extends Error {
	override name = "RestrictedRuntimeError";
}

export class ModelResolutionError extends Error {
	override name = "ModelResolutionError";
}

let sharedRuntime: ModelRuntime | undefined;

/**
 * One ModelRuntime per process. `refreshOnCreate: false` and `allowModelNetwork: false`
 * keep it from rewriting the global catalog files it reads.
 */
export async function getModelRuntime(): Promise<ModelRuntime> {
	if (!sharedRuntime) {
		sharedRuntime = await ModelRuntime.create({
			authPath: GLOBAL_AUTH_PATH,
			modelsPath: GLOBAL_MODELS_PATH,
			modelsStorePath: GLOBAL_MODELS_STORE_PATH,
			allowModelNetwork: false,
			refreshOnCreate: true,
		});
	}
	return sharedRuntime;
}

/** pi-ai is a transitive dependency, so the Model type is taken from the runtime API rather than imported. */
export type ResolvedModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export async function resolveModel(spec: ModelSpec): Promise<ResolvedModel> {
	const runtime = await getModelRuntime();
	const model = runtime.getModel(spec.provider, spec.model);
	if (!model) {
		throw new ModelResolutionError(
			`Model ${modelKey(spec)} is not registered in this Pi installation`,
		);
	}
	return model;
}

/** Load the project's own skill directory as a real Pi skill, not as prompt text. */
export function loadProjectSkills(skillsRoot: string): Skill[] {
	const { skills, diagnostics } = loadSkillsFromDir({
		dir: skillsRoot,
		source: "daily-intelligence",
	});
	if (diagnostics.length > 0) {
		throw new RestrictedRuntimeError(
			`Skill directory ${skillsRoot} produced diagnostics: ${diagnostics
				.map((d) => JSON.stringify(d))
				.join("; ")}`,
		);
	}
	if (skills.length === 0) {
		throw new RestrictedRuntimeError(`No skill found under ${skillsRoot}`);
	}
	return skills;
}

/**
 * A ResourceLoader that discovers nothing. Every global discovery path
 * (~/.pi/agent/extensions, <cwd>/.pi, AGENTS.md walking, settings `packages`)
 * is replaced by an explicit, empty answer — so pi-web-access and pi-usage
 * cannot load into a Phase 1 worker even though they are installed globally.
 */
function createSealedResourceLoader(opts: {
	skills: Skill[];
	systemPrompt: string;
}): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: opts.skills, diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => opts.systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

export interface RestrictedSessionOptions {
	spec: ModelSpec;
	systemPrompt: string;
	customTools: ToolDefinition[];
	skillsRoot: string;
	/** Sandbox cwd. Nothing reads it — there are no filesystem tools — but the SDK wants one. */
	cwd: string;
	thinkingLevel?: "off" | "low" | "medium" | "high";
}

export interface RestrictedSession {
	session: AgentSession;
	activeToolNames: string[];
	dispose(): void;
}

/**
 * Build an isolated session whose only capabilities are the custom tools passed in.
 *
 * The assertion at the end is the point of this function: if a future Pi version
 * changes a default and a builtin or a global extension tool leaks in, the run
 * fails loudly here rather than silently giving the agent bash.
 */
export async function createRestrictedSession(
	opts: RestrictedSessionOptions,
): Promise<RestrictedSession> {
	const model = await resolveModel(opts.spec);
	const modelRuntime = await getModelRuntime();
	const skills = loadProjectSkills(opts.skillsRoot);

	const expected = opts.customTools.map((t) => t.name).sort();
	if (new Set(expected).size !== expected.length) {
		throw new RestrictedRuntimeError(`Duplicate custom tool names: ${expected.join(", ")}`);
	}

	const resourceLoader = createSealedResourceLoader({
		skills,
		systemPrompt: opts.systemPrompt,
	});

	// In-memory settings: the global settings.json (models, packages, retry, theme)
	// is never read and never written. Agent-level retry is off because this project
	// owns retry and fallback in runStageWithFallback.
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true },
		retry: { enabled: false },
	});

	const { session, extensionsResult } = await createAgentSession({
		cwd: opts.cwd,
		agentDir: opts.cwd,
		model,
		thinkingLevel: opts.thinkingLevel ?? "medium",
		modelRuntime,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(opts.cwd),
		noTools: "all",
		customTools: opts.customTools,
		tools: expected,
	});

	assertRestricted(session, extensionsResult.extensions.length, expected);

	return {
		session,
		activeToolNames: session.getActiveToolNames().sort(),
		dispose: () => session.dispose(),
	};
}

/** Exported so a test can drive it without building a real session. */
export function assertRestricted(
	session: Pick<AgentSession, "getActiveToolNames" | "getAllTools" | "dispose">,
	extensionCount: number,
	expectedToolNames: string[],
): void {
	const fail = (msg: string): never => {
		session.dispose();
		throw new RestrictedRuntimeError(msg);
	};

	if (extensionCount !== 0) {
		fail(`Restricted runtime loaded ${extensionCount} extension(s); expected none`);
	}

	const active = session.getActiveToolNames().sort();
	const expected = [...expectedToolNames].sort();
	const unexpected = active.filter((n) => !expected.includes(n));
	const missing = expected.filter((n) => !active.includes(n));

	if (unexpected.length > 0) {
		fail(`Restricted runtime exposed unexpected tool(s): ${unexpected.join(", ")}`);
	}
	if (missing.length > 0) {
		fail(`Restricted runtime is missing custom tool(s): ${missing.join(", ")}`);
	}

	// Belt and braces: no builtin may even be *registered*, let alone active.
	const BUILTINS = ["bash", "powershell", "read", "write", "edit", "grep", "find", "ls"];
	const registered = session.getAllTools().map((t) => t.name);
	const leakedBuiltins = registered.filter((n) => BUILTINS.includes(n));
	if (leakedBuiltins.length > 0) {
		fail(`Restricted runtime registered builtin tool(s): ${leakedBuiltins.join(", ")}`);
	}
}
