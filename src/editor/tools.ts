import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DailyManifest, DailyMaterials } from "../schemas/index.ts";
import { DailyBriefInput, type DailyBrief } from "../schemas/index.ts";
import type { StoryRepository } from "../stories/repository.ts";
import { requiredMustKnowCount, requiredStoryCount, validateBrief } from "../validator/brief-validator.ts";
import { ToolRejection } from "../curator/tools.ts";
import {
	defineFindHistoryTool,
	defineStructuredFactsTool,
	ok,
	rejectFromZod,
} from "../agent-tools/shared.ts";
import { canonicalBody, defineReadBodyTool } from "../agent-tools/item-body.ts";

export interface EditorContext {
	date: string;
	manifest: DailyManifest;
	materials: DailyMaterials;
	repo: StoryRepository;
	previousBrief?: DailyBrief;
	now: () => Date;
	submitted?: DailyBrief;
	onToolCall?: (name: string, summary: Record<string, unknown>) => void;
}

const SECTIONS = [
	"MUST_KNOW",
	"AI_LLM",
	"DEVELOPER_OSS",
	"RESEARCH",
	"CRYPTO_MARKET",
	"MACRO",
	"COMPANIES",
] as const;

export function createEditorTools(ctx: EditorContext): ToolDefinition[] {
	const itemsById = new Map(ctx.manifest.items.map((i) => [i.id, i]));
	const factsById = new Map(ctx.manifest.facts.map((f) => [f.factId, f]));
	const materialById = new Map(ctx.materials.stories.map((s) => [s.storyId, s]));

	/**
	 * The editor's window onto source items is deliberately narrow: only items
	 * the curator already attached to a material story. It cannot re-scan the day.
	 */
	const allowedItemIds = new Set(ctx.materials.stories.flatMap((s) => s.sourceItemIds));

	// What the tool tells the model it wants has to agree with what the validator
	// will accept, and both follow the material count rather than a constant.
	const storyBounds = requiredStoryCount(ctx.materials.stories.length);
	const mustKnowBounds = requiredMustKnowCount(storyBounds.min);
	const storyRule =
		storyBounds.min === storyBounds.max
			? `exactly ${storyBounds.min}`
			: `${storyBounds.min}-${storyBounds.max}`;
	const mustKnowRule =
		mustKnowBounds.min === mustKnowBounds.max
			? `exactly ${mustKnowBounds.min}`
			: `${mustKnowBounds.min}-${mustKnowBounds.max}`;

	const note = (name: string, summary: Record<string, unknown>) => ctx.onToolCall?.(name, summary);

	const getMaterials = defineTool({
		name: "get_materials",
		label: "Get materials",
		description:
			"Return today's curated material set: every story the curator selected, with tier, why it was selected, change type and scores. This is your complete universe of stories — you cannot add one that is not here.",
		promptSnippet: "get_materials: the curated stories you may write about",
		parameters: Type.Object({}),
		execute: async () => {
			note("get_materials", { stories: ctx.materials.stories.length });
			return ok({
				date: ctx.materials.date,
				stories: ctx.materials.stories,
				emergingSignals: ctx.materials.emergingSignals,
				curatorNotes: ctx.materials.curatorNotes,
				previousBriefDate: ctx.previousBrief?.date ?? null,
			});
		},
	});

	const getStoryDetail = defineTool({
		name: "get_story_detail",
		label: "Story detail",
		description:
			"Return the full ledger entry for a story in the materials, including its reason, status, scores and history-derived change type.",
		promptSnippet: "get_story_detail: full ledger record for a material story",
		parameters: Type.Object({ storyIds: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }) }),
		execute: async (_id, params) => {
			const unknown = params.storyIds.filter((s) => !materialById.has(s));
			if (unknown.length > 0) {
				throw new ToolRejection(
					`These storyIds are not in today's materials: ${unknown.join(", ")}. You may only write about stories the curator selected.`,
				);
			}
			const entries = [];
			for (const storyId of params.storyIds) {
				const entry = await ctx.repo.getStory(storyId);
				entries.push({ storyId, material: materialById.get(storyId), ledger: entry ?? null });
			}
			return ok({ stories: entries });
		},
	});

	/** Body characters `get_source_items` carries per item before it points at the reader. */
	const SOURCE_BODY_CHARS = 2000;

	/*
	 * The record of a source item, and the beginning of what it says.
	 *
	 * It used to return the whole NormalizedItem, raw `content` and all. On
	 * 2026-09-19 two calls put 152,078 characters into the editor's session, one
	 * of them 107,353 -- mostly HTML markup, and all of it re-sent on every later
	 * turn of the stage. The curator had the identical bug and lost it the same
	 * morning; this is the same fix, from the same module, so the two cannot
	 * drift.
	 *
	 * The opening of an article is usually enough to write from, because the
	 * curator already decided what the story is and why. When it is not -- a
	 * number, a name, the exact words someone used -- `read_source_body` reaches
	 * the rest by searching it, which is both cheaper and more accurate than
	 * scrolling a wall of markup. Nothing the editor could previously read has
	 * become unreachable; it is reached a sentence at a time instead of all at
	 * once.
	 */
	const getSourceItems = defineTool({
		name: "get_source_items",
		label: "Source items",
		description:
			"Return the record of source items belonging to material stories: title, source, url, publication time, summary, and the opening of the body as plain prose. Only items the curator attached to a story are reachable — you cannot see the raw daily inventory. A long body is not returned whole; use read_source_body to search inside one for the passage you need to quote.",
		promptSnippet: "get_source_items: the record and opening text of a story's sources",
		parameters: Type.Object({ itemIds: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }) }),
		execute: async (_id, params) => {
			const outOfScope = params.itemIds.filter((i) => !allowedItemIds.has(i));
			if (outOfScope.length > 0) {
				throw new ToolRejection(
					`Not available: ${outOfScope.join(", ")}. You can only read source items that belong to a story in today's materials.`,
				);
			}
			let bodyChars = 0;
			const items = params.itemIds.map((id) => {
				const item = itemsById.get(id)!;
				const body = canonicalBody(item);
				bodyChars += body.length;
				const head = body.slice(0, SOURCE_BODY_CHARS);
				return {
					id: item.id,
					// The marker the system prompt names. Before this projection existed the
					// whole NormalizedItem came back and carried it; dropping it would leave
					// the prompt describing a tag no tool result ever shows.
					trust: item.trust,
					source: `${item.sourceName} (${item.sourceType})`,
					title: item.title,
					at: item.publishedAt,
					...(item.url ? { url: item.url } : {}),
					summary: item.summary,
					bodyChars: body.length,
					body: head,
					...(body.length > head.length
						? {
								truncated: true,
								note: `${body.length - head.length} more characters. Use read_source_body with a \`find\` term to reach a specific passage.`,
							}
						: {}),
				};
			});
			note("get_source_items", { count: params.itemIds.length, bodyChars });
			return ok({ items });
		},
	});

	const readSourceBody = defineReadBodyTool({
		name: "read_source_body",
		label: "Read source body",
		description:
			"Read part of one source item's body as plain prose. Give `find` to jump to a term — the reply centres on the first match and lists where the others are — or `start` to continue from an offset the tool gave you earlier. Use this to check a number or copy a quotation exactly, rather than pulling a whole article into the conversation.",
		promptSnippet: "read_source_body: search inside one source and read the passage around a match",
		lookup: (id) => (allowedItemIds.has(id) ? itemsById.get(id) : undefined),
		unknownIdMessage: (id) =>
			`Not available: ${id}. You can only read source items that belong to a story in today's materials.`,
		note,
	});

	const findHistory = defineFindHistoryTool({
		repo: ctx.repo,
		date: ctx.date,
		description:
			"Look up a story's entries on previous days so 'what changed' describes an actual delta rather than repeating today's facts.",
		promptSnippet: "find_history: what this story looked like on earlier days",
	});

	const getStructuredFacts = defineStructuredFactsTool({
		facts: ctx.manifest.facts,
		idField: "factId",
		paramName: "factIds",
		allow: allowedItemIds,
		description:
			"Return verified numeric facts. Cite these by factId in factRefs. Never write a market, macro or benchmark number that does not come from here — the renderer prints the stored value, so an invented number cannot reach the brief anyway.",
		promptSnippet: "get_structured_facts: verified numbers, cite by factId",
	});

	const submitBrief = defineTool({
		name: "submit_brief",
		label: "Submit brief",
		description:
			`Submit the finished daily brief. This is the only authoritative output — prose in your reply is discarded. Requires ${storyRule} stories (never the same storyId twice), ${mustKnowRule} flagged mustKnow, every storyId drawn from the materials, every sourceItemId belonging to that story, and every factRef valid.`,
		promptSnippet: `submit_brief: final editor output (${storyRule} stories, ${mustKnowRule} Must Know)`,
		parameters: Type.Object({
			stories: Type.Array(
				Type.Object({
					storyId: Type.String({ minLength: 1 }),
					section: Type.Union(SECTIONS.map((s) => Type.Literal(s))),
					mustKnow: Type.Boolean(),
					title: Type.String({ minLength: 1 }),
					whatHappened: Type.String({ minLength: 1 }),
					whyItMatters: Type.String({ minLength: 1 }),
					whatChanged: Type.String({ minLength: 1 }),
					impact: Type.String({ minLength: 1 }),
					confidence: Type.Union([
						Type.Literal("HIGH"),
						Type.Literal("MEDIUM"),
						Type.Literal("LOW"),
					]),
					sourceItemIds: Type.Array(Type.String(), { minItems: 1 }),
					factRefs: Type.Optional(Type.Array(Type.String())),
				}),
				/*
				 * The floor cannot live in the tool schema, because the schema is
				 * fixed and the floor is not: it is whatever the curator supplied,
				 * capped at eight. Hardcoding 8 here made a quiet day impossible to
				 * submit at all -- three different models, told by this schema that
				 * they needed eight and by the materials that there were four,
				 * each wrote all four twice, and were then rejected for duplicating.
				 * They were obeying the contract they were given.
				 *
				 * So the schema enforces only what is universally true, and the real
				 * bound is checked by validateBrief, which knows the material count
				 * and can say what is wrong in a sentence the model can act on.
				 */
				{ minItems: 1, maxItems: 15 },
			),
			emergingSignals: Type.Optional(
				Type.Array(
					Type.Object({
						label: Type.String({ minLength: 1 }),
						body: Type.String({ minLength: 1 }),
						storyIds: Type.Array(Type.String()),
					}),
				),
			),
			dailyAnalysis: Type.String({ minLength: 1 }),
			watchNext: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		}),
		execute: async (_id, params) => {
			const normalized = {
				stories: params.stories.map((s) => ({ ...s, factRefs: s.factRefs ?? [] })),
				emergingSignals: params.emergingSignals ?? [],
				dailyAnalysis: params.dailyAnalysis,
				watchNext: params.watchNext,
			};
			const parsed = DailyBriefInput.safeParse(normalized);
			if (!parsed.success) {
				throw rejectFromZod("submit_brief payload rejected", parsed.error);
			}

			const result = validateBrief(parsed.data, {
				manifest: ctx.manifest,
				materials: ctx.materials,
			});
			if (!result.ok) {
				throw new ToolRejection(
					`submit_brief rejected:\n- ${result.errors.join("\n- ")}\nNothing was saved. Fix these and call submit_brief again.`,
				);
			}

			// Belt and braces alongside the validator: an unknown factRef here would
			// crash the renderer, which is the wrong place to discover it.
			const badFacts = parsed.data.stories.flatMap((s) =>
				s.factRefs.filter((f) => !factsById.has(f)),
			);
			if (badFacts.length > 0) {
				throw new ToolRejection(`Unknown factRef(s): ${[...new Set(badFacts)].join(", ")}`);
			}

			const brief: DailyBrief = {
				date: ctx.date,
				producedAt: ctx.now().toISOString(),
				...parsed.data,
			};
			ctx.submitted = brief;
			note("submit_brief", {
				stories: brief.stories.length,
				mustKnow: brief.stories.filter((s) => s.mustKnow).length,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: `Brief accepted: ${brief.stories.length} stories, ${brief.stories.filter((s) => s.mustKnow).length} Must Know. Writing is complete — stop here.`,
					},
				],
				details: {},
				terminate: true,
			};
		},
	});

	return [
		getMaterials,
		getStoryDetail,
		getSourceItems,
		readSourceBody,
		findHistory,
		getStructuredFacts,
		submitBrief,
	];
}
