/**
 * Scaffolding shared by the curator's and the editor's tool sets.
 *
 * The two sets are deliberately different — the curator scans and clusters, the
 * editor writes — but four things were identical in both and had drifted into
 * two copies: the success-envelope helper, the Zod-issue rejection format, and
 * the `find_history` and `get_structured_facts` tools themselves.
 *
 * Everything the model can observe is a contract, not an implementation detail:
 * tool names and parameter schemas are matched by `assertRestricted()`, and
 * rejection strings are what teaches a model to correct itself. So the builders
 * below take the wording as a parameter rather than imposing one, and each call
 * site passes exactly the text it used before.
 */

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { z } from "zod";
import type { StructuredFact } from "../schemas/index.ts";
import type { StoryRepository } from "../stories/repository.ts";

/**
 * Tools reject by throwing. Pi turns a thrown error into a tool-error result the
 * model sees and can correct, which is exactly the behaviour we want: a rejected
 * submit_materials must teach the model what is missing, not end the run.
 */
export class ToolRejection extends Error {
	override name = "ToolRejection";
}

/** The success envelope every tool returns: pretty JSON as a single text block. */
export function ok(payload: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }], details: {} };
}

/**
 * A Zod failure rendered the way every tool renders it: `<label>: path: message; …`.
 * `label` carries the whole prefix, including its own trailing wording, so the
 * text the model sees is unchanged from when each tool built this itself.
 */
export function rejectFromZod(label: string, error: z.ZodError): ToolRejection {
	return new ToolRejection(
		`${label}: ${error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
	);
}

export interface FindHistoryToolOptions {
	repo: StoryRepository;
	/** Today; history is everything strictly before it. */
	date: string;
	description: string;
	promptSnippet: string;
	/** Called with the tool-call summary, for stages that record tool calls. */
	note?: (name: string, summary: Record<string, unknown>) => void;
}

const DEFAULT_HISTORY_LIMIT = 10;

/** `find_history`: story ledger entries from previous days. */
export function defineFindHistoryTool(opts: FindHistoryToolOptions): ToolDefinition {
	return defineTool({
		name: "find_history",
		label: "Find history",
		description: opts.description,
		promptSnippet: opts.promptSnippet,
		parameters: Type.Object({
			text: Type.Optional(Type.String()),
			storyId: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
		}),
		execute: async (_id, params) => {
			if (!params.text && !params.storyId) {
				throw new ToolRejection("Provide either text or storyId.");
			}
			const entries = await opts.repo.findHistory({
				text: params.text,
				storyId: params.storyId,
				beforeDate: opts.date,
				limit: params.limit ?? DEFAULT_HISTORY_LIMIT,
			});
			opts.note?.("find_history", {
				storyId: params.storyId,
				text: params.text,
				hits: entries.length,
			});
			return ok({ entries });
		},
	});
}

export interface StructuredFactsToolOptions {
	facts: StructuredFact[];
	description: string;
	promptSnippet: string;
	/**
	 * Which id the second parameter filters on, and what that parameter is called.
	 * The curator selects facts by the item they came from (`itemIds` ->
	 * `sourceItemId`); the editor selects the facts themselves (`factIds` ->
	 * `factId`), because by then the item list is already settled.
	 */
	idField: "sourceItemId" | "factId";
	paramName: "itemIds" | "factIds";
	/**
	 * Restrict the visible facts to those whose `sourceItemId` is in this set.
	 * The editor passes the materials' item ids, so a fact belonging to an item
	 * the curator rejected can never be cited. Omitted means every fact.
	 */
	allow?: ReadonlySet<string>;
}

/** `get_structured_facts`: today's verified numbers, cited by factId. */
export function defineStructuredFactsTool(opts: StructuredFactsToolOptions): ToolDefinition {
	const { idField, paramName, allow } = opts;
	return defineTool({
		name: "get_structured_facts",
		label: "Structured facts",
		description: opts.description,
		promptSnippet: opts.promptSnippet,
		parameters: Type.Object({
			kind: Type.Optional(
				Type.Union([Type.Literal("crypto"), Type.Literal("macro"), Type.Literal("filing")]),
			),
			[paramName]: Type.Optional(Type.Array(Type.String())),
		}),
		execute: async (_id, params) => {
			const p = params as { kind?: StructuredFact["kind"]; [key: string]: unknown };
			let facts: StructuredFact[] = allow
				? opts.facts.filter((f) => allow.has(f.sourceItemId))
				: opts.facts;
			if (p.kind) facts = facts.filter((f) => f.kind === p.kind);
			const ids = p[paramName];
			if (Array.isArray(ids) && ids.length > 0) {
				const wanted = new Set(ids as string[]);
				facts = facts.filter((f) => wanted.has(f[idField]));
			}
			return ok({ facts });
		},
	});
}
