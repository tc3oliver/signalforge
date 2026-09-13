import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DailyManifest, NormalizedItem, StructuredFact } from "../schemas/index.ts";
import {
	DailyMaterialsInput,
	ItemDecisionInput,
	StoryUpsertInput,
	type DailyMaterials,
	type ItemDecision,
} from "../schemas/index.ts";
import type { ResearchRouter } from "../research/router.ts";
import { toCollectedItem } from "../research/types.ts";
import type { StoryRepository } from "../stories/repository.ts";
import { validateMaterials } from "../validator/materials-validator.ts";

/**
 * Tools reject by throwing. Pi turns a thrown error into a tool-error result the
 * model sees and can correct, which is exactly the behaviour we want: a rejected
 * submit_materials must teach the model what is missing, not end the run.
 */
export class ToolRejection extends Error {
	override name = "ToolRejection";
}

function ok(payload: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }], details: {} };
}

/** Only the fields a broad scan needs. Full content costs a get_item_detail. */
function toSummaryView(item: NormalizedItem) {
	return {
		id: item.id,
		sourceType: item.sourceType,
		sourceName: item.sourceName,
		title: item.title,
		summary: item.summary,
		publishedAt: item.publishedAt,
		metadata: item.metadata,
	};
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9一-鿿.+#-]+/)
		.filter((t) => t.length > 1);
}

export interface CuratorContext {
	date: string;
	manifest: DailyManifest;
	repo: StoryRepository;
	now: () => Date;
	/** Set by submit_materials on success; the session driver reads it afterwards. */
	submitted?: DailyMaterials;
	onToolCall?: (name: string, summary: Record<string, unknown>) => void;
}

const MAX_PAGE = 50;

/* -------------------------------------------------------------------------- */
/* Optional web research                                                       */
/* -------------------------------------------------------------------------- */

export interface CuratorResearchConfig {
	router: ResearchRouter;
	/** Ceiling from config/agent.yaml `searchWeb.maxResults`. */
	maxResults: number;
}

/*
 * `search_web` is the one tool that reaches the network, so it is NOT part of
 * the default tool set: a synthetic, eval, gold or offline-fixture run must get
 * exactly the eleven offline tools, and `createRestrictedSession` asserts the
 * active tool set exactly. Production configures a router for the duration of a
 * run; everything else leaves this unset and never sees the tool.
 *
 * It is module state rather than a `CuratorContext` field because the curator
 * session builder (src/curator/session.ts) constructs the context itself.
 */
let researchConfig: CuratorResearchConfig | undefined;

/** Enables `search_web` for sessions created while the config is set. Pass undefined to disable. */
export function configureCuratorResearch(config?: CuratorResearchConfig): void {
	researchConfig = config;
}

export function curatorResearchEnabled(): boolean {
	return researchConfig !== undefined;
}

export function createCuratorTools(ctx: CuratorContext): ToolDefinition[] {
	const itemsById = new Map(ctx.manifest.items.map((i) => [i.id, i]));
	const factsById = new Map(ctx.manifest.facts.map((f) => [f.factId, f]));
	const orderedIds = ctx.manifest.items.map((i) => i.id);

	const note = (name: string, summary: Record<string, unknown>) => ctx.onToolCall?.(name, summary);

	const unseenIds = async (): Promise<string[]> => {
		const processed = await ctx.repo.processedItemIds(ctx.date);
		return orderedIds.filter((id) => !processed.has(id));
	};

	const getDailyInventory = defineTool({
		name: "get_daily_inventory",
		label: "Daily inventory",
		description:
			"Return counts for today's feed: total items, items per source, how many have a recorded decision, how many are still unseen, and how many stories exist so far. Call this first and again whenever you want to check progress.",
		promptSnippet: "get_daily_inventory: counts of today's items and scan progress",
		parameters: Type.Object({}),
		execute: async () => {
			const processed = await ctx.repo.processedItemIds(ctx.date);
			const stories = await ctx.repo.listStories(ctx.date);
			const itemsBySource: Record<string, number> = {};
			for (const item of ctx.manifest.items) {
				itemsBySource[item.sourceType] = (itemsBySource[item.sourceType] ?? 0) + 1;
			}
			const payload = {
				date: ctx.date,
				totalItems: ctx.manifest.items.length,
				itemsBySource,
				processedItems: processed.size,
				unseenItems: ctx.manifest.items.length - processed.size,
				storyCount: stories.length,
			};
			note("get_daily_inventory", payload);
			return ok(payload);
		},
	});

	const listUnseenItems = defineTool({
		name: "list_unseen_items",
		label: "List unseen items",
		description:
			"Page through items that have no recorded decision yet, in publication order. Returns scan-level fields only (no full content). Use the returned nextCursor to continue. Decide and record every item in a page before requesting the next one.",
		promptSnippet: "list_unseen_items: page undecided items (max 50)",
		parameters: Type.Object({
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE })),
			cursor: Type.Optional(Type.String()),
		}),
		execute: async (_id, params) => {
			const limit = Math.min(params.limit ?? MAX_PAGE, MAX_PAGE);
			const unseen = await unseenIds();
			let start = 0;
			if (params.cursor) {
				const idx = unseen.indexOf(params.cursor);
				if (idx === -1) {
					throw new ToolRejection(
						`cursor "${params.cursor}" is not an unseen item id. Omit cursor to restart from the first unseen item.`,
					);
				}
				start = idx;
			}
			const page = unseen.slice(start, start + limit);
			const nextCursor = unseen[start + limit];
			const payload = {
				items: page.map((id) => toSummaryView(itemsById.get(id)!)),
				returned: page.length,
				remainingAfterPage: Math.max(0, unseen.length - (start + page.length)),
				nextCursor: nextCursor ?? null,
			};
			note("list_unseen_items", { returned: page.length, remaining: payload.remainingAfterPage });
			return ok(payload);
		},
	});

	const getItemDetail = defineTool({
		name: "get_item_detail",
		label: "Item detail",
		description:
			"Return the full record for specific items, including body content and url. Spend this only on items that a title and summary cannot settle.",
		promptSnippet: "get_item_detail: full content for specific item ids",
		parameters: Type.Object({
			itemIds: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
		}),
		execute: async (_id, params) => {
			const unknown = params.itemIds.filter((id) => !itemsById.has(id));
			if (unknown.length > 0) {
				throw new ToolRejection(
					`Unknown item id(s): ${unknown.join(", ")}. Item ids come from list_unseen_items or search_items — never construct one.`,
				);
			}
			note("get_item_detail", { count: params.itemIds.length });
			return ok({ items: params.itemIds.map((id) => itemsById.get(id)!) });
		},
	});

	const searchItems = defineTool({
		name: "search_items",
		label: "Search items",
		description:
			"Lexical search over today's item titles and summaries. Use it to find the other coverage of an event you are looking at, so one event becomes one story rather than five.",
		promptSnippet: "search_items: find sibling coverage of the same event",
		parameters: Type.Object({
			query: Type.String({ minLength: 2 }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE })),
		}),
		execute: async (_id, params) => {
			const terms = tokenize(params.query);
			if (terms.length === 0) {
				throw new ToolRejection(`Query "${params.query}" produced no searchable terms.`);
			}
			const scored = ctx.manifest.items
				.map((item) => {
					const hay = tokenize(`${item.title} ${item.summary}`);
					const set = new Set(hay);
					const hits = terms.filter((t) => set.has(t)).length;
					return { item, score: hits / terms.length };
				})
				.filter((r) => r.score > 0)
				.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id))
				.slice(0, params.limit ?? 20);
			note("search_items", { query: params.query, hits: scored.length });
			return ok({
				results: scored.map((r) => ({ ...toSummaryView(r.item), score: Number(r.score.toFixed(3)) })),
			});
		},
	});

	const findHistory = defineTool({
		name: "find_history",
		label: "Find history",
		description:
			"Search story ledger entries from PREVIOUS days. Call this before you decide a changeType — it is the only way to know whether today adds anything to what was already known.",
		promptSnippet: "find_history: look up this story on earlier days",
		parameters: Type.Object({
			text: Type.Optional(Type.String()),
			storyId: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
		}),
		execute: async (_id, params) => {
			if (!params.text && !params.storyId) {
				throw new ToolRejection("Provide either text or storyId.");
			}
			const results = await ctx.repo.findHistory({
				text: params.text,
				storyId: params.storyId,
				beforeDate: ctx.date,
				limit: params.limit ?? 10,
			});
			note("find_history", { storyId: params.storyId, text: params.text, hits: results.length });
			return ok({ entries: results });
		},
	});

	const getStory = defineTool({
		name: "get_story",
		label: "Get story",
		description: "Return today's ledger entry for a storyId, or null if you have not created it yet.",
		promptSnippet: "get_story: read a story you already created today",
		parameters: Type.Object({ storyId: Type.String({ minLength: 1 }) }),
		execute: async (_id, params) => {
			const story = await ctx.repo.getStory(params.storyId);
			return ok({ story: story ?? null });
		},
	});

	const listTodayStories = defineTool({
		name: "list_today_stories",
		label: "List today's stories",
		description:
			"List every story that already exists for today, with its source items and current judgement. Call this when you resume work another session started — it is the only way to recover story ids you did not create yourself, and re-using an existing storyId in upsert_story merges into it instead of creating a duplicate.",
		promptSnippet: "list_today_stories: recover stories created earlier today",
		parameters: Type.Object({}),
		execute: async () => {
			const stories = await ctx.repo.listStories(ctx.date);
			note("list_today_stories", { count: stories.length });
			return ok({
				stories: stories.map((s) => ({
					storyId: s.storyId,
					canonicalTitle: s.canonicalTitle,
					changeType: s.changeType,
					status: s.status,
					importance: s.importance,
					novelty: s.novelty,
					confidence: s.confidence,
					sourceItemIds: s.sourceItemIds,
					primarySourceIds: s.primarySourceIds,
					reason: s.reason,
				})),
			});
		},
	});

	const upsertStory = defineTool({
		name: "upsert_story",
		label: "Upsert story",
		description:
			"Create or update a story for today. Re-calling with the same storyId merges source items and overwrites the judgement fields. Use a stable slug for storyId so the same real-world event keeps its id across days.",
		promptSnippet: "upsert_story: create or merge a story cluster",
		parameters: Type.Object({
			storyId: Type.String({ minLength: 1 }),
			canonicalTitle: Type.String({ minLength: 1 }),
			sourceItemIds: Type.Array(Type.String(), { minItems: 1 }),
			primarySourceIds: Type.Array(Type.String(), { minItems: 1 }),
			status: Type.Union([
				Type.Literal("OPEN"),
				Type.Literal("RESOLVED"),
				Type.Literal("DORMANT"),
			]),
			changeType: Type.Union([
				Type.Literal("NEW"),
				Type.Literal("UPDATE"),
				Type.Literal("ESCALATION"),
				Type.Literal("RESOLUTION"),
				Type.Literal("REVERSAL"),
				Type.Literal("CONFIRMATION"),
				Type.Literal("RUMOR"),
				Type.Literal("NO_MATERIAL_CHANGE"),
			]),
			relevance: Type.Number({ minimum: 0, maximum: 1 }),
			novelty: Type.Number({ minimum: 0, maximum: 1 }),
			importance: Type.Number({ minimum: 0, maximum: 1 }),
			confidence: Type.Number({ minimum: 0, maximum: 1 }),
			reason: Type.String({ minLength: 1 }),
			factRefs: Type.Optional(Type.Array(Type.String())),
		}),
		execute: async (_id, params) => {
			const parsed = StoryUpsertInput.safeParse({ ...params, factRefs: params.factRefs ?? [] });
			if (!parsed.success) {
				throw new ToolRejection(
					`upsert_story payload rejected: ${parsed.error.issues
						.map((i) => `${i.path.join(".")}: ${i.message}`)
						.join("; ")}`,
				);
			}
			const input = parsed.data;

			const unknownItems = input.sourceItemIds.filter((i) => !itemsById.has(i));
			if (unknownItems.length > 0) {
				throw new ToolRejection(
					`sourceItemIds contains id(s) not in today's manifest: ${unknownItems.join(", ")}. Use ids returned by tools only.`,
				);
			}
			const notInSource = input.primarySourceIds.filter((i) => !input.sourceItemIds.includes(i));
			if (notInSource.length > 0) {
				throw new ToolRejection(
					`primarySourceIds must be a subset of sourceItemIds; these are missing from sourceItemIds: ${notInSource.join(", ")}`,
				);
			}
			const unknownFacts = input.factRefs.filter((f) => !factsById.has(f));
			if (unknownFacts.length > 0) {
				throw new ToolRejection(
					`factRefs contains unknown fact id(s): ${unknownFacts.join(", ")}. Call get_structured_facts to see the valid ids.`,
				);
			}

			const entry = await ctx.repo.upsertStory(ctx.date, input, ctx.now());
			note("upsert_story", { storyId: entry.storyId, changeType: entry.changeType });
			return ok({ story: entry });
		},
	});

	const recordItemDecisions = defineTool({
		name: "record_item_decisions",
		label: "Record item decisions",
		description:
			"Record a disposition for each item in the batch you just reviewed. THIS is what marks an item processed — an item without a recorded decision counts as unscanned no matter what you wrote in your reply. Use CANDIDATE with a storyId for anything that feeds a story, DUPLICATE for redundant coverage already attached to a story, IRRELEVANT for noise.",
		promptSnippet: "record_item_decisions: mark items processed (required for every item)",
		parameters: Type.Object({
			decisions: Type.Array(
				Type.Object({
					itemId: Type.String({ minLength: 1 }),
					disposition: Type.Union([
						Type.Literal("IRRELEVANT"),
						Type.Literal("DUPLICATE"),
						Type.Literal("CANDIDATE"),
					]),
					storyId: Type.Optional(Type.String({ minLength: 1 })),
					reason: Type.String({ minLength: 1 }),
				}),
				{ minItems: 1, maxItems: MAX_PAGE },
			),
		}),
		execute: async (_id, params) => {
			const parsedList: ItemDecision[] = [];
			const stamp = ctx.now().toISOString();
			for (const raw of params.decisions) {
				const parsed = ItemDecisionInput.safeParse(raw);
				if (!parsed.success) {
					throw new ToolRejection(
						`decision for "${raw.itemId}" rejected: ${parsed.error.issues
							.map((i) => `${i.path.join(".")}: ${i.message}`)
							.join("; ")}`,
					);
				}
				if (!itemsById.has(parsed.data.itemId)) {
					throw new ToolRejection(
						`Unknown item id "${parsed.data.itemId}". Nothing was recorded — resend the batch with ids from list_unseen_items.`,
					);
				}
				parsedList.push({ ...parsed.data, decidedAt: stamp });
			}

			const dupes = parsedList
				.map((d) => d.itemId)
				.filter((id, i, arr) => arr.indexOf(id) !== i);
			if (dupes.length > 0) {
				throw new ToolRejection(`Duplicate itemId(s) in one batch: ${[...new Set(dupes)].join(", ")}`);
			}

			// A CANDIDATE or DUPLICATE that names a storyId must name one that exists,
			// otherwise the clustering recorded here is a dangling reference.
			for (const d of parsedList) {
				if (d.storyId && !(await ctx.repo.getStory(d.storyId))) {
					throw new ToolRejection(
						`storyId "${d.storyId}" does not exist yet. Call upsert_story for it first, then resend this batch.`,
					);
				}
			}

			await ctx.repo.recordDecisions(ctx.date, parsedList);
			const processed = await ctx.repo.processedItemIds(ctx.date);
			const payload = {
				recorded: parsedList.length,
				processedItems: processed.size,
				totalItems: ctx.manifest.items.length,
				unseenItems: ctx.manifest.items.length - processed.size,
			};
			note("record_item_decisions", payload);
			return ok(payload);
		},
	});

	const getStructuredFacts = defineTool({
		name: "get_structured_facts",
		label: "Structured facts",
		description:
			"Return today's verified numeric facts (crypto, macro, company filings). Reference these by factId instead of writing numbers yourself — a number you type is not verifiable, a factId is.",
		promptSnippet: "get_structured_facts: verified numbers you may cite by factId",
		parameters: Type.Object({
			kind: Type.Optional(
				Type.Union([Type.Literal("crypto"), Type.Literal("macro"), Type.Literal("filing")]),
			),
			itemIds: Type.Optional(Type.Array(Type.String())),
		}),
		execute: async (_id, params) => {
			let facts: StructuredFact[] = ctx.manifest.facts;
			if (params.kind) facts = facts.filter((f) => f.kind === params.kind);
			if (params.itemIds && params.itemIds.length > 0) {
				const wanted = new Set(params.itemIds);
				facts = facts.filter((f) => wanted.has(f.sourceItemId));
			}
			return ok({ facts });
		},
	});

	const submitMaterials = defineTool({
		name: "submit_materials",
		label: "Submit materials",
		description:
			"Submit the curated material set. This is the only way to finish. It is rejected unless every item in today's manifest has a recorded decision and every id you reference exists. Read a rejection carefully and fix the specific problem it names.",
		promptSnippet: "submit_materials: final curator output (requires 100% scan coverage)",
		parameters: Type.Object({
			stories: Type.Array(
				Type.Object({
					storyId: Type.String({ minLength: 1 }),
					tier: Type.Union([Type.Literal("A"), Type.Literal("B"), Type.Literal("C")]),
					canonicalTitle: Type.String({ minLength: 1 }),
					whySelected: Type.String({ minLength: 1 }),
					changeType: Type.Union([
						Type.Literal("NEW"),
						Type.Literal("UPDATE"),
						Type.Literal("ESCALATION"),
						Type.Literal("RESOLUTION"),
						Type.Literal("REVERSAL"),
						Type.Literal("CONFIRMATION"),
						Type.Literal("RUMOR"),
						Type.Literal("NO_MATERIAL_CHANGE"),
					]),
					importance: Type.Number({ minimum: 0, maximum: 1 }),
					novelty: Type.Number({ minimum: 0, maximum: 1 }),
					confidence: Type.Number({ minimum: 0, maximum: 1 }),
					sourceItemIds: Type.Array(Type.String(), { minItems: 1 }),
					primarySourceIds: Type.Array(Type.String(), { minItems: 1 }),
					factRefs: Type.Optional(Type.Array(Type.String())),
				}),
				{ minItems: 1 },
			),
			emergingSignals: Type.Optional(
				Type.Array(
					Type.Object({
						label: Type.String({ minLength: 1 }),
						rationale: Type.String({ minLength: 1 }),
						storyIds: Type.Array(Type.String()),
					}),
				),
			),
			curatorNotes: Type.Optional(Type.String()),
		}),
		execute: async (_id, params) => {
			const normalized = {
				stories: params.stories.map((s) => ({ ...s, factRefs: s.factRefs ?? [] })),
				emergingSignals: params.emergingSignals ?? [],
				curatorNotes: params.curatorNotes ?? "",
			};
			const parsed = DailyMaterialsInput.safeParse(normalized);
			if (!parsed.success) {
				throw new ToolRejection(
					`submit_materials payload rejected: ${parsed.error.issues
						.map((i) => `${i.path.join(".")}: ${i.message}`)
						.join("; ")}`,
				);
			}

			const processed = await ctx.repo.processedItemIds(ctx.date);
			const knownStoryIds = new Set((await ctx.repo.listStories(ctx.date)).map((s) => s.storyId));
			const result = validateMaterials(parsed.data, {
				manifest: ctx.manifest,
				knownStoryIds,
				totalItems: ctx.manifest.items.length,
				processedItems: processed.size,
			});
			if (!result.ok) {
				throw new ToolRejection(
					`submit_materials rejected:\n- ${result.errors.join("\n- ")}\nNothing was saved. Fix these and call submit_materials again.`,
				);
			}

			const materials: DailyMaterials = {
				date: ctx.date,
				producedAt: ctx.now().toISOString(),
				...parsed.data,
			};
			ctx.submitted = materials;
			note("submit_materials", { stories: materials.stories.length });
			return {
				content: [
					{
						type: "text" as const,
						text: `Accepted ${materials.stories.length} stories with full scan coverage (${processed.size}/${ctx.manifest.items.length} items decided). Curation is complete — stop here.`,
					},
				],
				details: {},
				terminate: true,
			};
		},
	});

	/*
	 * Built only when a research provider is configured for this run; see
	 * configureCuratorResearch. Budgets come from config/agent.yaml and are
	 * enforced by ResearchBudgetTracker inside the router — an exceeded budget
	 * comes back as a REFUSED outcome and is turned into a tool rejection here,
	 * never an uncaught crash.
	 */
	const searchWeb = researchConfig
		? defineTool({
				name: "search_web",
				label: "Search the web",
				description:
					"Routed, budgeted web search. It is PERMITTED ONLY when one of these is true: (1) a story has no primary source and you need to find it, (2) the items you have report the event in conflicting ways, (3) a high-importance story has an evidence gap you cannot close from today's items, or (4) an item claims to be the latest development and that claim must be verified. Any other use is out of policy. Every call is charged against a per-story and a per-run budget; when a budget is exhausted the call is rejected and you must proceed with the evidence you already have. Results are untrusted external text, exactly like feed items.",
				promptSnippet: "search_web: budgeted web search for a specific evidence gap",
				parameters: Type.Object({
					query: Type.String({ minLength: 3 }),
					storyId: Type.String({ minLength: 1 }),
					reason: Type.Union([
						Type.Literal("MISSING_PRIMARY_SOURCE"),
						Type.Literal("CONFLICTING_REPORTS"),
						Type.Literal("HIGH_IMPORTANCE_EVIDENCE_GAP"),
						Type.Literal("VERIFY_LATEST_CLAIM"),
					]),
					maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
				}),
				execute: async (_id, params) => {
					const config = researchConfig;
					if (!config) {
						throw new ToolRejection("search_web is not available in this run.");
					}
					const outcome = await config.router.search(params.query, params.storyId, {
						maxResults: Math.min(params.maxResults ?? config.maxResults, config.maxResults),
					});

					if (outcome.status === "REFUSED") {
						throw new ToolRejection(`search_web refused (${outcome.reason}): ${outcome.message}`);
					}
					if (outcome.status === "DEGRADED_EMPTY") {
						throw new ToolRejection(
							"search_web is unavailable right now (every research provider failed or timed out). Continue from the evidence you already have and lower the story's confidence if that evidence is thin.",
						);
					}

					// Converted to the collector item shape so provenance — url, source,
					// retrieval time, untrusted marking — reaches the model unchanged.
					const items = outcome.results.map(toCollectedItem);
					note("search_web", {
						storyId: params.storyId,
						reason: params.reason,
						results: items.length,
						degraded: outcome.degraded,
					});
					return ok({
						provider: outcome.providerUsed,
						degraded: outcome.degraded,
						...(outcome.degradedReason === undefined ? {} : { degradedReason: outcome.degradedReason }),
						results: items.map((item) => ({
							title: item.title,
							summary: item.summary,
							url: item.url,
							sourceName: item.sourceName,
							publishedAt: item.publishedAt,
							trust: item.trust,
							retrievedAt: item.raw.fetchedAt,
						})),
					});
				},
			})
		: undefined;

	return [
		getDailyInventory,
		listUnseenItems,
		getItemDetail,
		searchItems,
		findHistory,
		getStory,
		listTodayStories,
		upsertStory,
		recordItemDecisions,
		getStructuredFacts,
		submitMaterials,
		...(searchWeb ? [searchWeb] : []),
	];
}
