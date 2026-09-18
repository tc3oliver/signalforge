import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DailyManifest, NormalizedItem, StoryLedgerEntry } from "../schemas/index.ts";
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
import type { TurnBudget } from "../runtime/progress-yield.ts";
import { screeningHint } from "../screening/stage.ts";
import { accountManifest, validateMaterials } from "../validator/materials-validator.ts";
import {
	defineFindHistoryTool,
	defineStructuredFactsTool,
	ok,
	rejectFromZod,
	ToolRejection,
} from "../agent-tools/shared.ts";

// Re-exported: `ToolRejection` has always been imported from here by the editor
// tools and by tests, and moving where it is declared should not move where it
// is imported from.
export { ToolRejection };

/**
 * The broad-scan projection of an item. Deliberately small.
 *
 * Every field here is re-sent on every later model turn of the session that
 * received it -- each search, history lookup, upsert and decision batch carries
 * the whole accumulated context back to the provider -- so a field in the scan
 * view is paid for twenty-odd times per page, not once. Measured on
 * 2026-09-18: the previous view (full summary, full metadata, pretty-printed)
 * was ~278 tokens per item; this one is ~105. The full record is one
 * `get_item_detail` away for the items that a title and summary cannot settle.
 *
 * `metadata` is not passed through. It is arbitrary per-source JSON, and the
 * one or two keys per source that help a scan decision are projected by hand
 * below.
 */
const SCAN_SUMMARY_CHARS = 400;

function toScanView(item: NormalizedItem) {
	const summary =
		item.summary.length > SCAN_SUMMARY_CHARS
			? `${item.summary.slice(0, SCAN_SUMMARY_CHARS)}…`
			: item.summary;
	const hint = screeningHint(item);
	return {
		id: item.id,
		source: `${item.sourceName} (${item.sourceType})`,
		title: item.title,
		summary,
		at: item.publishedAt.slice(0, 10),
		...(hint ? { hint } : {}),
	};
}

/** How a story is echoed back after a write: enough to cite it, nothing the model just sent. */
function toStoryReceipt(entry: StoryLedgerEntry) {
	return {
		storyId: entry.storyId,
		changeType: entry.changeType,
		sourceItems: entry.sourceItemIds.length,
	};
}

/*
 * Why a batch entry was refused, as a stable family rather than the sentence.
 *
 * The 2026-09-18 routed replay had 96 of 322 batch entries rejected and the
 * trace recorded only the count, so the cause could not be told from the run:
 * a rejected entry costs a whole extra model turn, and at ~19k tokens of
 * re-sent context per turn that is the single most expensive kind of mistake
 * the Curator can make. The family is what lets a rise in one cause be
 * attributed without replaying the day.
 */
export function upsertRejectionKind(message: string): string {
	if (message.includes("no earlier ledger entry matches")) return "CHANGE_TYPE_WITHOUT_HISTORY";
	if (message.includes("not in today's manifest")) return "UNKNOWN_ITEM_ID";
	if (message.includes("primarySourceIds must be a subset")) return "PRIMARY_NOT_IN_SOURCES";
	if (message.includes("unknown fact id")) return "UNKNOWN_FACT_REF";
	if (message.includes("not in the reader profile")) return "UNKNOWN_TOPIC_ID";
	if (message.includes("payload rejected")) return "SCHEMA";
	return "OTHER";
}

/** A prior-day ledger entry as history evidence: what it was, not every score. */
function toHistoryView(entry: StoryLedgerEntry) {
	return {
		storyId: entry.storyId,
		date: entry.date,
		canonicalTitle: entry.canonicalTitle,
		changeType: entry.changeType,
		status: entry.status,
		importance: entry.importance,
		reason: entry.reason.length > 200 ? `${entry.reason.slice(0, 200)}…` : entry.reason,
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
	/**
	 * The reader's interest topic ids, for validating `upsert_story.topicIds`.
	 * Absent when the run has no profile, in which case the field is accepted as
	 * given rather than rejected -- a run without a profile should behave as it
	 * always did, not refuse work.
	 */
	topicIds?: ReadonlySet<string>;
	/**
	 * How many decisions this turn may still record before it should stop.
	 *
	 * The ceiling is enforced by `list_unseen_items` refusing to hand out more
	 * work, not by `record_item_decisions` refusing to accept it: a model that
	 * has already read a page must always be able to commit its judgement of it.
	 * Refusing the write would throw away work the model has already paid for and
	 * leave the page to be re-read by the next turn.
	 *
	 * Absent for any caller that does not want bounded turns -- eval, gold and
	 * fixture runs, which scan small manifests in one turn and whose output must
	 * not change shape because a budget was introduced.
	 */
	turnBudget?: TurnBudget;
	/**
	 * Items the screener withheld from the default broad scan (routed DROP
	 * verdicts from the trusted screener version). Absent or empty outside route
	 * mode, in which case every tool behaves exactly as it always has.
	 *
	 * Withheld is not erased: these items stay in the manifest, `search_items`
	 * and `get_item_detail` still see them, `upsert_story` still accepts them as
	 * sources, and `record_item_decisions` still records them. Only
	 * `list_unseen_items` skips them, and only until the Curator decides one --
	 * which is a rescue, and supersedes the screener's verdict.
	 */
	screenedOutItemIds?: ReadonlySet<string>;
	/** Set by submit_materials on success; the session driver reads it afterwards. */
	submitted?: DailyMaterials;
	onToolCall?: (name: string, summary: Record<string, unknown>) => void;
	/**
	 * Called before every tool runs. Test-only fault injection uses it to end an
	 * attempt between two tool calls -- the one boundary where the durable state
	 * (decisions, stories) is known to be consistent, and the boundary a real
	 * provider error actually lands on, since every tool call is preceded by a
	 * model request. Throwing here is how the injected failure escapes: a tool
	 * that throws would otherwise be reported back to the model as a correctable
	 * tool error, and the model would simply carry on.
	 *
	 * Undefined in every non-fault-injection run, which is all production runs.
	 */
	onToolBoundary?: () => Promise<void>;
}

const MAX_PAGE = 50;

/* -------------------------------------------------------------------------- */
/* Optional web research                                                       */
/* -------------------------------------------------------------------------- */

export interface CuratorResearchConfig {
	router: ResearchRouter;
	/** Ceiling from config/agent.yaml `searchWeb.maxResults`. */
	maxResults: number;
	/**
	 * Called once per search_web outcome that was degraded (Tavily failed over
	 * to Exa, or both providers were unavailable), with a human-readable reason
	 * a run can surface as `daily_runs.degraded_reason`. Never called for a
	 * clean Tavily success.
	 */
	onDegraded?: (reason: string) => void;
}

/*
 * `search_web` is the one tool that reaches the network, so it is NOT part of
 * the default tool set: a synthetic, eval, gold or offline-fixture run must get
 * exactly the twelve offline tools, and `createRestrictedSession` asserts the
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

export function createCuratorTools(ctx: CuratorContext): ToolDefinition[] {
	const itemsById = new Map(ctx.manifest.items.map((i) => [i.id, i]));
	const factsById = new Map(ctx.manifest.facts.map((f) => [f.factId, f]));
	const orderedIds = ctx.manifest.items.map((i) => i.id);

	const note = (name: string, summary: Record<string, unknown>) => ctx.onToolCall?.(name, summary);

	const screenedOut = ctx.screenedOutItemIds ?? new Set<string>();
	/** Everything the Curator is asked to judge and has not judged yet. */
	const unseenIds = async (): Promise<string[]> => {
		const processed = await ctx.repo.processedItemIds(ctx.date);
		return orderedIds.filter((id) => !processed.has(id) && !screenedOut.has(id));
	};
	const accounting = async () =>
		accountManifest({
			manifest: ctx.manifest,
			knownStoryIds: new Set(),
			processedItemIds: await ctx.repo.processedItemIds(ctx.date),
			screenedOutItemIds: screenedOut,
		});

	const getDailyInventory = defineTool({
		name: "get_daily_inventory",
		label: "Daily inventory",
		description:
			"Return counts for today's feed: total items, items per source, how many were set aside by the screener, how many are offered to you, how many have a recorded decision, how many are still unseen, and how many stories exist so far. Call this first and again whenever you want to check progress.",
		promptSnippet: "get_daily_inventory: counts of today's items and scan progress",
		parameters: Type.Object({}),
		execute: async () => {
			const stories = await ctx.repo.listStories(ctx.date);
			const itemsBySource: Record<string, number> = {};
			for (const item of ctx.manifest.items) {
				itemsBySource[item.sourceType] = (itemsBySource[item.sourceType] ?? 0) + 1;
			}
			const account = await accounting();
			const payload = {
				date: ctx.date,
				totalItems: account.total,
				itemsBySource,
				// Set aside by the cheap screener; not offered by list_unseen_items,
				// still reachable through search_items, still yours to rescue.
				screenedOutItems: account.screenedOut,
				offeredItems: account.sentToCurator,
				processedItems: account.curatorDecided,
				rescuedItems: account.rescued,
				unseenItems: account.unaccountedItemIds.length,
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
			"Page through the items offered to you that have no recorded decision yet, in publication order. Returns scan-level fields only (no full content). Items the screener set aside are not offered here (search_items still finds them). Use the returned nextCursor to continue. Decide and record every item in a page before requesting the next one.",
		promptSnippet: "list_unseen_items: page undecided items (max 50)",
		parameters: Type.Object({
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE })),
			cursor: Type.Optional(Type.String()),
		}),
		execute: async (_id, params) => {
			/*
			 * The work-unit ceiling. Returning an empty page rather than throwing is
			 * deliberate: a ToolRejection reads to the model as "you did something
			 * wrong, try differently", and it would try differently -- calling
			 * search_items, or re-listing with a cursor -- burning the rest of the
			 * turn. An empty page with `turnComplete` says the opposite, and the
			 * session yields on it whether or not the model takes the hint.
			 */
			if (ctx.turnBudget?.exhausted) {
				const unseenNow = await unseenIds();
				const payload = {
					items: [],
					returned: 0,
					remainingAfterPage: unseenNow.length,
					nextCursor: null,
					turnComplete: true,
					note:
						`This turn's work unit is complete (${ctx.turnBudget.spent} decisions recorded). ` +
						`${unseenNow.length} item(s) remain and will be offered to the next turn, which ` +
						`resumes from this exact state. Stop now: do not call submit_materials, and do ` +
						`not look for other work. Simply end your reply.`,
				};
				note("list_unseen_items", { returned: 0, remaining: unseenNow.length, turnComplete: true });
				return ok(payload);
			}

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
				items: page.map((id) => toScanView(itemsById.get(id)!)),
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
			"Lexical search over ALL of today's items (including any the screener set aside) by title and summary. Use it to find the other coverage of an event you are looking at, so one event becomes one story rather than five. Returns scan-level fields only.",
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
				.slice(0, params.limit ?? 10);
			note("search_items", { query: params.query, hits: scored.length });
			return ok({
				results: scored.map((r) => ({
					...toScanView(r.item),
					score: Number(r.score.toFixed(3)),
					// Flagged rather than hidden. A sibling the screener set aside is
					// exactly what this search exists to recover; the flag says it needs
					// a decision from you before it can be cited.
					...(screenedOut.has(r.item.id) ? { screenedOut: true } : {}),
				})),
			});
		},
	});

	const findHistory = defineFindHistoryTool({
		repo: ctx.repo,
		date: ctx.date,
		description:
			"Search story ledger entries from PREVIOUS days. upsert_story and upsert_stories run this check for you and report any hits; call it directly when you need to read prior entries before deciding whether today's coverage is the same story.",
		promptSnippet: "find_history: look up this story on earlier days",
		note,
		project: toHistoryView,
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
			"List every story that already exists for today: id, title, changeType and source-item count. Call this when you resume work another session started — it is the only way to recover story ids you did not create yourself, and re-using an existing storyId in upsert_story merges into it instead of creating a duplicate. Use get_story for the full entry of one story.",
		promptSnippet: "list_today_stories: recover stories created earlier today",
		parameters: Type.Object({}),
		execute: async () => {
			const stories = await ctx.repo.listStories(ctx.date);
			note("list_today_stories", { count: stories.length });
			// Compact by design: this is called at the start of every resumed work
			// unit and a day can hold 200 stories, so every field here is paid for
			// once per unit for the rest of the day.
			return ok({
				stories: stories.map((s) => ({
					storyId: s.storyId,
					title: s.canonicalTitle,
					changeType: s.changeType,
					sourceItems: s.sourceItemIds.length,
				})),
			});
		},
	});

	/*
	 * The story payload schema, shared by the single and the batch tool so the two
	 * cannot drift. TypeBox rather than Zod here because Pi reads it as the
	 * parameter schema; the Zod StoryUpsertInput validates the same shape below.
	 */
	const storyPayload = Type.Object({
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
		topicIds: Type.Optional(Type.Array(Type.String())),
	});

	/** How many prior-day entries a history check returns to the model. */
	const HISTORY_HINT_LIMIT = 3;

	/**
	 * Validates and writes one story, and checks its history in the same call.
	 *
	 * The history check used to be a separate mandatory tool call before every
	 * upsert: on 2026-09-18 that was 241 find_history calls beside 214 upserts,
	 * sixteen of the ~25 model turns in every work unit, each one re-sending the
	 * whole page. The lookup itself costs nothing -- it is a ledger query -- so
	 * it is done here, and its result travels back with the receipt:
	 *
	 *   - NEW with prior-day hits: the write goes through (the story is real)
	 *     and the hits are returned, so the model can re-upsert with the right
	 *     changeType in the same breath as its next story. It is not rejected,
	 *     because a token-overlap hit is a strong hint and not a proof, and a
	 *     rejection would force a round trip to say "no, really, NEW".
	 *   - non-NEW with no hits at all: rejected. A continuation of nothing is a
	 *     contradiction the model cannot have evidence for.
	 *
	 * find_history stays available for the case where the model wants to read
	 * the prior entries before it writes anything.
	 */
	const upsertOne = async (
		raw: Record<string, unknown>,
	): Promise<{ receipt: ReturnType<typeof toStoryReceipt>; history?: ReturnType<typeof toHistoryView>[]; note?: string }> => {
		const parsed = StoryUpsertInput.safeParse({
			...raw,
			factRefs: (raw["factRefs"] as unknown[] | undefined) ?? [],
			topicIds: (raw["topicIds"] as unknown[] | undefined) ?? [],
		});
		if (!parsed.success) {
			throw rejectFromZod("upsert_story payload rejected", parsed.error);
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

		/*
		 * Same shape as the factRefs check above, and for the same reason: a
		 * topic id the model invented would record a prior that never existed,
		 * and the whole point of storing them is that the prior can be audited
		 * afterwards. Named ids only, from the profile in the system prompt.
		 */
		if (ctx.topicIds) {
			const unknownTopics = input.topicIds.filter((t) => !ctx.topicIds!.has(t));
			if (unknownTopics.length > 0) {
				throw new ToolRejection(
					`topicIds contains id(s) that are not in the reader profile: ${unknownTopics.join(", ")}. ` +
						`Valid ids: ${[...ctx.topicIds].sort().join(", ")}. An empty list is fine — a story that matches no listed topic still belongs in the ledger.`,
				);
			}
		}

		// By id first (the same slug on an earlier day is the same story by
		// definition), then by title tokens.
		let history = await ctx.repo.findHistory({
			storyId: input.storyId,
			beforeDate: ctx.date,
			limit: HISTORY_HINT_LIMIT,
		});
		if (history.length === 0) {
			history = await ctx.repo.findHistory({
				text: input.canonicalTitle,
				beforeDate: ctx.date,
				limit: HISTORY_HINT_LIMIT,
			});
		}
		if (input.changeType !== "NEW" && history.length === 0) {
			throw new ToolRejection(
				`story "${input.storyId}" is ${input.changeType} but no earlier ledger entry matches its id or title. ` +
					`A story with no history can only be NEW; express low importance through the scores, not the changeType. ` +
					`If you know the earlier storyId, re-use it exactly.`,
			);
		}

		const entry = await ctx.repo.upsertStory(ctx.date, input, ctx.now());
		const rescuing = input.sourceItemIds.filter((id) => screenedOut.has(id));
		note("upsert_story", {
			storyId: entry.storyId,
			changeType: entry.changeType,
			historyHits: history.length,
			...(rescuing.length > 0 ? { rescuedSources: rescuing.length } : {}),
		});

		const notes: string[] = [];
		if (input.changeType === "NEW" && history.length > 0) {
			notes.push(
				`History exists for this story (${history.map((h) => `${h.storyId}@${h.date}`).join(", ")}). ` +
					`If today's coverage continues one of them, re-upsert with that storyId and a non-NEW changeType.`,
			);
		}
		if (rescuing.length > 0) {
			notes.push(
				`${rescuing.length} source(s) (${rescuing.join(", ")}) were set aside by the screener. ` +
					`Record a decision for each with record_item_decisions (CANDIDATE or DUPLICATE, storyId ${entry.storyId}) -- submit_materials rejects a cited source with no decision.`,
			);
		}
		return {
			receipt: toStoryReceipt(entry),
			...(history.length > 0 ? { history: history.map(toHistoryView) } : {}),
			...(notes.length > 0 ? { note: notes.join(" ") } : {}),
		};
	};

	const upsertStory = defineTool({
		name: "upsert_story",
		label: "Upsert story",
		description:
			"Create or update ONE story for today. Prefer upsert_stories for a page's worth of stories at once. Re-calling with the same storyId merges source items and overwrites the judgement fields. Use a stable slug for storyId so the same real-world event keeps its id across days. History from previous days is checked for you and returned; a non-NEW changeType with no history is rejected.",
		promptSnippet: "upsert_story: create or merge one story cluster (history checked for you)",
		parameters: storyPayload,
		execute: async (_id, params) => {
			const result = await upsertOne(params as Record<string, unknown>);
			return ok({ story: result.receipt, ...(result.history ? { history: result.history } : {}), ...(result.note ? { note: result.note } : {}) });
		},
	});

	/*
	 * The batch form. One model turn instead of one per story. Applied in
	 * order and independently: a story that fails validation is reported at its
	 * index and the others are still written, because an upsert is idempotent
	 * and re-sending the good ones would only cost tokens. The model is told
	 * exactly which failed and why, and resends those alone.
	 */
const upsertStories = defineTool({
		name: "upsert_stories",
		label: "Upsert stories",
		description:
			"Create or update SEVERAL stories for today in one call -- use this for a page's clusters instead of one upsert_story per cluster. Each entry has exactly the upsert_story shape and semantics, including the automatic history check. Entries are applied independently: the response lists each accepted story with its history hits, and each rejected entry with the reason; fix and resend only the rejected ones.",
		promptSnippet: "upsert_stories: create or merge up to 20 story clusters in one call",
		parameters: Type.Object({
			stories: Type.Array(storyPayload, { minItems: 1, maxItems: 20 }),
		}),
		execute: async (_id, params) => {
			const accepted: Array<Record<string, unknown>> = [];
			const rejected: Array<{ index: number; storyId: string; error: string }> = [];
			for (const [index, story] of params.stories.entries()) {
				try {
					const result = await upsertOne(story as Record<string, unknown>);
					accepted.push({
						...result.receipt,
						...(result.history ? { history: result.history } : {}),
						...(result.note ? { note: result.note } : {}),
					});
				} catch (err) {
					if (!(err instanceof ToolRejection)) throw err;
					rejected.push({ index, storyId: String(story.storyId ?? ""), error: err.message });
				}
			}
			const rejectedBy: Record<string, number> = {};
			for (const r of rejected) {
				const kind = upsertRejectionKind(r.error);
				rejectedBy[kind] = (rejectedBy[kind] ?? 0) + 1;
			}
			note("upsert_stories", {
				accepted: accepted.length,
				rejected: rejected.length,
				...(rejected.length > 0 ? { rejectedBy } : {}),
			});
			if (accepted.length === 0) {
				throw new ToolRejection(
					`upsert_stories rejected every entry:\n- ${rejected.map((r) => `[${r.index}] ${r.storyId}: ${r.error}`).join("\n- ")}`,
				);
			}
			return ok({
				accepted,
				...(rejected.length > 0
					? {
							rejected,
							note: `${rejected.length} entry/ies were not written. Fix the named problem and resend only those.`,
						}
					: {}),
			});
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
					throw rejectFromZod(`decision for "${raw.itemId}" rejected`, parsed.error);
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
			//
			// Resolved against today's stories once for the whole batch. getStory
			// searches every date, so it stays the authority for the rare id created
			// on an earlier day; it just no longer runs fifty times for the fifty
			// ids the curator almost always created minutes ago. Rejection order and
			// wording are unchanged.
			const namedStoryIds = parsedList.map((d) => d.storyId).filter((id): id is string => !!id);
			if (namedStoryIds.length > 0) {
				const today = new Set((await ctx.repo.listStories(ctx.date)).map((s) => s.storyId));
				for (const d of parsedList) {
					if (!d.storyId || today.has(d.storyId)) continue;
					if (!(await ctx.repo.getStory(d.storyId))) {
						throw new ToolRejection(
							`storyId "${d.storyId}" does not exist yet. Call upsert_story for it first, then resend this batch.`,
						);
					}
				}
			}

			await ctx.repo.recordDecisions(ctx.date, parsedList);
			// Spent after the write, so a rejected batch never costs the turn budget.
			// Rescues are not charged: the budget bounds the broad scan, and a rescue
			// is the Curator following a story past what the scan offered.
			const rescuedNow = parsedList.filter((d) => screenedOut.has(d.itemId)).length;
			ctx.turnBudget?.spend(parsedList.length - rescuedNow);
			const account = await accounting();
			const payload = {
				recorded: parsedList.length,
				...(rescuedNow > 0 ? { rescued: rescuedNow } : {}),
				processedItems: account.curatorDecided,
				totalItems: account.sentToCurator,
				unseenItems: account.unaccountedItemIds.length,
			};
			note("record_item_decisions", payload);
			return ok(payload);
		},
	});

	const getStructuredFacts = defineStructuredFactsTool({
		facts: ctx.manifest.facts,
		idField: "sourceItemId",
		paramName: "itemIds",
		description:
			"Return today's verified numeric facts (crypto, macro, company filings). Reference these by factId instead of writing numbers yourself — a number you type is not verifiable, a factId is.",
		promptSnippet: "get_structured_facts: verified numbers you may cite by factId",
	});

	const submitMaterials = defineTool({
		name: "submit_materials",
		label: "Submit materials",
		description:
			"Submit the curated material set. This is the only way to finish. It is rejected unless every item offered to you has a recorded decision, every item a story cites has a recorded decision, and every id you reference exists. Read a rejection carefully and fix the specific problem it names.",
		promptSnippet: "submit_materials: final curator output (requires every offered item decided)",
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
				throw rejectFromZod("submit_materials payload rejected", parsed.error);
			}

			const processed = await ctx.repo.processedItemIds(ctx.date);
			const knownStoryIds = new Set((await ctx.repo.listStories(ctx.date)).map((s) => s.storyId));
			const validationCtx = {
				manifest: ctx.manifest,
				knownStoryIds,
				processedItemIds: processed,
				screenedOutItemIds: screenedOut,
			};
			const result = validateMaterials(parsed.data, validationCtx);
			if (!result.ok) {
				throw new ToolRejection(
					`submit_materials rejected:\n- ${result.errors.join("\n- ")}\nNothing was saved. Fix these and call submit_materials again.`,
				);
			}

			// Recomputed from the same context the gate used, so the success line
			// can only report accounting that was actually verified.
			const account = accountManifest(validationCtx);
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
						text:
							`Accepted ${materials.stories.length} stories with every manifest item accounted for ` +
							`(${account.curatorDecided} decided by you` +
							(account.screenedOut > 0
								? `, ${account.screenedOut} set aside by the screener, ${account.rescued} of those rescued`
								: "") +
							`; ${account.total} total). Curation is complete — stop here.`,
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
						config.onDegraded?.(`Web search unavailable: ${outcome.degradedReason}`);
						throw new ToolRejection(
							"search_web is unavailable right now (every research provider failed or timed out). Continue from the evidence you already have and lower the story's confidence if that evidence is thin.",
						);
					}
					if (outcome.degraded) {
						config.onDegraded?.(
							`Web search fell back to ${outcome.providerUsed}${
								outcome.degradedReason ? ` (${outcome.degradedReason})` : ""
							}`,
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

	/**
	 * Every tool goes through the boundary hook first. Wrapping here rather than
	 * inside each `execute` keeps the hook impossible to forget when a twelfth
	 * tool is added later.
	 */
	const withBoundary = (tool: ToolDefinition): ToolDefinition =>
		ctx.onToolBoundary === undefined
			? tool
			: ({
					...tool,
					execute: async (...args: Parameters<typeof tool.execute>) => {
						await ctx.onToolBoundary?.();
						return tool.execute(...args);
					},
				} as ToolDefinition);

	return [
		getDailyInventory,
		listUnseenItems,
		getItemDetail,
		searchItems,
		findHistory,
		getStory,
		listTodayStories,
		upsertStory,
		upsertStories,
		recordItemDecisions,
		getStructuredFacts,
		submitMaterials,
		...(searchWeb ? [searchWeb] : []),
	].map(withBoundary);
}
