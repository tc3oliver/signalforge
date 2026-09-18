import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TokenUsage } from "../schemas/run.ts";
import type { ModelSpec } from "./model-config.ts";
import { createRestrictedSession } from "./pi-runtime.ts";

/**
 * The seam between the stage drivers and Pi. Integration tests substitute a fake
 * that exercises the tools directly, so the whole orchestration — retries,
 * fallback, validation, resume — is testable without spending a token.
 */
export interface AgentDriver {
	prompt(text: string): Promise<void>;
	getActiveToolNames(): string[];
	/**
	 * Stops the turn in flight. Optional because the fake driver in the tests
	 * resolves synchronously and has nothing to stop; a real one must implement
	 * it or a stalled turn cannot be bounded.
	 */
	abort?(): Promise<void>;
	/**
	 * Provider-reported token usage accumulated over this driver's life, or
	 * undefined when nothing has reported any. Optional: the fake driver in the
	 * tests contacts no provider and has nothing to report, and "not told" must
	 * stay distinguishable from zero.
	 */
	getUsage?(): TokenUsage | undefined;
	dispose(): void;
}

export interface AgentDriverOptions {
	spec: ModelSpec;
	systemPrompt: string;
	customTools: ToolDefinition[];
	skillsRoot: string;
	cwd: string;
	thinkingLevel?: "off" | "low" | "medium" | "high";
	/** Invoked for each assistant text delta; used to mirror model output into the run log. */
	onText?: (delta: string) => void;
}

export type AgentDriverFactory = (opts: AgentDriverOptions) => Promise<AgentDriver>;

export const createPiAgentDriver: AgentDriverFactory = async (opts) => {
	const restricted = await createRestrictedSession({
		spec: opts.spec,
		systemPrompt: opts.systemPrompt,
		customTools: opts.customTools,
		skillsRoot: opts.skillsRoot,
		cwd: opts.cwd,
		thinkingLevel: opts.thinkingLevel,
	});

	/*
	 * Usage is read from the provider's own statement on every completed
	 * assistant message. The Pi SDK's `AssistantMessage.usage` (pi-ai `Usage`:
	 * input, output, cacheRead, cacheWrite, totalTokens) is what the provider
	 * returned for that request -- not `ContextUsage`, which is an estimate of
	 * context-window occupancy and is not used here. Summed per driver, so one
	 * attempt's figure covers every model turn of its session.
	 */
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reportedBy: 0 };
	restricted.session.subscribe((event) => {
		if (
			event.type === "message_update" &&
			event.assistantMessageEvent.type === "text_delta"
		) {
			opts.onText?.(event.assistantMessageEvent.delta);
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const u = event.message.usage;
			if (!u) return;
			usage.input += u.input;
			usage.output += u.output;
			usage.cacheRead += u.cacheRead;
			usage.cacheWrite += u.cacheWrite;
			usage.totalTokens += u.totalTokens;
			usage.reportedBy += 1;
		}
	});

	return {
		prompt: (text) => restricted.session.prompt(text),
		getActiveToolNames: () => restricted.session.getActiveToolNames(),
		abort: () => restricted.session.abort(),
		getUsage: () => (usage.reportedBy > 0 ? { ...usage } : undefined),
		dispose: () => restricted.dispose(),
	};
};
