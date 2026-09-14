import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
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

	if (opts.onText) {
		restricted.session.subscribe((event) => {
			if (
				event.type === "message_update" &&
				event.assistantMessageEvent.type === "text_delta"
			) {
				opts.onText?.(event.assistantMessageEvent.delta);
			}
		});
	}

	return {
		prompt: (text) => restricted.session.prompt(text),
		getActiveToolNames: () => restricted.session.getActiveToolNames(),
		abort: () => restricted.session.abort(),
		dispose: () => restricted.dispose(),
	};
};
