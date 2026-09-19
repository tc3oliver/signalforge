import { Type } from "typebox";
import {
	BODY_WINDOW_MAX,
	canonicalBody,
	defineReadBodyTool,
} from "../agent-tools/item-body.ts";
import type { EvidenceConfig } from "../config/schema.ts";
import { distillEvidence } from "../evidence/distill.ts";
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

export function toScanView(item: NormalizedItem) {
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

/** Body characters `get_item_detail` may return per item before it truncates. */
const DETAIL_BODY_CHARS = 1500;

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

/**
 * A story counts as today's near-neighbour at this much title overlap. Measured
 * on the 2026-09-19 ledger: every one of the day's duplicate pairs scored 0.5
 * or better and ranked first for its twin, and the threshold fires on about one
 * story in ten, so a run pays a sentence a dozen times to be told about
 * something it otherwise shipped twice.
 *
 * Exported because `pnpm observe` reports the pairs that survived to the ledger
 * at the same threshold, and a report drawing its own line somewhere else would
 * be describing a check that is not the one running.
 */
export const TODAY_NEAR_SCORE = 0.5;
const TODAY_NEAR_LIMIT = 3;

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
	 * The reader's interest topic ids, for validating a story's `topicIds`.
	 * Absent when the run has no profile, in which case the field is accepted as
	 * given rather than rejected -- a run without a profile should behave as it
	 * always did, not refuse work.
	 */
	topicIds?: ReadonlySet<string>;
	/**
	 * How many decisions this turn may still record before it should stop.
	 *
	 * The ceiling is enforced by `list_unseen_items` refusing to hand out more
	 * work, not by the commit refusing to accept it: a model that
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
	 * and `get_item_detail` still see them, and a commit still accepts them as
	 * sources and records their decisions. Only
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

export const MAX_PAGE = 50;

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

/**
 * How `get_item_evidence` reaches its model, for the duration of a run.
 *
 * Module state for the same reason `search_web` uses it: the curator session
 * builder constructs the context itself, and an eval, gold or offline run must
 * get exactly the tool set it has always had rather than one that varies with
 * configuration.
 */
export interface CuratorEvidenceConfig {
	config: EvidenceConfig;
	apiKey: string;
	fetchImpl?: typeof fetch;
	/** Called when distillation fails, so the run can record why. */
	onDegraded?: (reason: string) => void;
}

let evidenceConfig: CuratorEvidenceConfig | undefined;

/** Enables `get_item_evidence` for sessions created while the config is set. */
export function configureCuratorEvidence(config?: CuratorEvidenceConfig): void {
	evidenceConfig = config;
}

export function createCuratorTools(ctx: CuratorContext): ToolDefinition[] {
	const itemsById = new Map(ctx.manifest.items.map((i) => [i.id, i]));
	const factsById = new Map(ctx.manifest.facts.map((f) => [f.factId, f]));
	const orderedIds = ctx.manifest.items.map((i) => i.id);

	const note = (name: string, summary: Record<string, unknown>) => ctx.onToolCall?.(name, summary);

	/** Evidence calls made by this tool set; bounded so a cheap tool cannot become a habit. */
	let evidenceCalls = 0;

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
			"Return the record for specific items -- url, source, date and the opening of the body. The body is trimmed; the reply says how long the whole thing is. When the opening does not settle it, read further with `read_item_body`, which can search inside one item and return the passage around a match. Spend either only on items that a title and summary cannot settle.",
		promptSnippet: "get_item_detail: record and opening body for specific item ids",
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
			/*
			 * Bounded, and bounded here rather than behind a flag.
			 *
			 * This tool returned whole records. On 2026-09-19 four calls put
			 * 228,130 characters into the Curator's session, one of them 96,703,
			 * and a tool result is re-sent on every later turn of its work unit --
			 * measured at six occurrences for these calls. Those three reads cost
			 * an estimated 156,000 tokens of the day's curation. An unbounded
			 * default is the defect, so there is no unbounded mode left to choose.
			 */
			let truncated = 0;
			const items = params.itemIds.map((id) => {
				const item = itemsById.get(id)!;
				const body = canonicalBody(item);
				const head = body.slice(0, DETAIL_BODY_CHARS);
				if (body.length > head.length) truncated += 1;
				return {
					id: item.id,
					source: `${item.sourceName} (${item.sourceType})`,
					title: item.title,
					at: item.publishedAt.slice(0, 10),
					...(item.url ? { url: item.url } : {}),
					bodyChars: body.length,
					body: head,
					...(body.length > head.length ? { truncated: true } : {}),
				};
			});
			note("get_item_detail", { count: params.itemIds.length, truncated });
			return ok({
				items,
				...(truncated > 0
					? {
							note: `${truncated} item(s) have more body than is shown. Use read_item_body with a \`find\` term to jump to the passage you need; the decisive detail of a long piece is usually in the middle.`,
						}
					: {}),
			});
		},
	});

	const readItemBody = defineReadBodyTool({
		name: "read_item_body",
		label: "Read item body",
		description:
			"Read part of one item's body. Give `find` to jump to a term -- the reply centres on the first match and lists where the others are -- or `start` to continue from an offset the tool gave you earlier. A long article is never returned whole: ask for what you need to know. The reply always says how long the body is and whether there is more before or after the window.",
		promptSnippet: "read_item_body: search inside one item and read the passage around a match",
		lookup: (id) => itemsById.get(id),
		unknownIdMessage: (id) =>
			`Unknown item id: ${id}. Item ids come from list_unseen_items or search_items — never construct one.`,
		note,
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
			"Search story ledger entries from PREVIOUS days. commit_curation_batch runs this check for you on every story and reports any hits; call it directly when you need to read prior entries before deciding whether today's coverage is the same story.",
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

	/**
	 * How many ranked matches a `list_today_stories` search returns, and the most
	 * it will return if asked.
	 */
	const TODAY_MATCH_LIMIT = 10;
	const TODAY_MATCH_MAX = 25;

	/**
	 * Today's stories ranked by how much of `text` their title accounts for, the
	 * same measure `find_history` uses for prior days, so "does this continue
	 * something" is answered the same way whichever side of midnight the answer
	 * is on.
	 */
	function rankToday(
		stories: readonly StoryLedgerEntry[],
		text: string,
		exclude?: string,
	): Array<{ entry: StoryLedgerEntry; score: number }> {
		const terms = new Set(tokenize(text));
		if (terms.size === 0) return [];
		return stories
			.filter((s) => s.storyId !== exclude)
			.map((entry) => {
				const hay = new Set(tokenize(entry.canonicalTitle));
				let hits = 0;
				for (const t of terms) if (hay.has(t)) hits += 1;
				return { entry, score: hits / terms.size };
			})
			.filter((r) => r.score > 0)
			.sort((a, b) => b.score - a.score || a.entry.storyId.localeCompare(b.entry.storyId));
	}

	const listTodayStories = defineTool({
		name: "list_today_stories",
		label: "List today's stories",
		description:
			"Name every story that already exists for today. With no arguments it returns each story's id and nothing else — the ids are the slugs you wrote, so a continuation is usually recognisable from the slug alone; call get_story for the full entry of one, or pass match to rank them. With match, it returns the stories whose titles best fit that text, with their titles and changeTypes. Re-using an existing storyId in a commit merges into that story instead of creating a duplicate.",
		promptSnippet: "list_today_stories: recover stories created earlier today",
		parameters: Type.Object({
			match: Type.Optional(
				Type.String({
					minLength: 2,
					description: "Title or keywords of the story you are about to write. Returns the closest existing stories instead of every id.",
				}),
			),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: TODAY_MATCH_MAX })),
		}),
		execute: async (_id, params) => {
			const stories = await ctx.repo.listStories(ctx.date);
			if (params.match !== undefined) {
				const ranked = rankToday(stories, params.match).slice(
					0,
					params.limit ?? TODAY_MATCH_LIMIT,
				);
				note("list_today_stories", { match: params.match, hits: ranked.length, total: stories.length });
				return ok({
					total: stories.length,
					matches: ranked.map((r) => ({
						storyId: r.entry.storyId,
						title: r.entry.canonicalTitle,
						changeType: r.entry.changeType,
						sourceItems: r.entry.sourceItemIds.length,
						score: Number(r.score.toFixed(3)),
					})),
				});
			}
			note("list_today_stories", { count: stories.length });
			/*
			 * Ids only, and all of them.
			 *
			 * This is called once at the start of most work units, and a tool
			 * result stays in the session and is re-sent on every later turn of
			 * that unit -- about 4.6 times, measured. So the day's ledger is paid
			 * for repeatedly, and it grows all day: on 2026-09-19 nine calls
			 * returned 28 stories and then 153, 103,557 characters in total, of
			 * which 45 ledger rows were ever re-used. The titles were the bulk of
			 * that and the redundant part: a storyId here is a slug the model
			 * wrote itself for this exact purpose, `claude-code-2-1-275` beside
			 * its own title `Claude Code 2.1.277 加入 AGENTS.md 支援`.
			 *
			 * Dropping the other fields rather than the rows is what keeps this
			 * safe. Every story that exists today is still named, so nothing a
			 * later session could have merged into becomes invisible; a slug that
			 * is not enough on its own is one get_story call away, and `match`
			 * ranks them when the model has a title in hand.
			 */
			return ok({ total: stories.length, storyIds: stories.map((s) => s.storyId) });
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
		/*
		 * The valid ids are named here, in the schema the model is shown, rather
		 * than only in the rejection it gets for guessing wrong. The 2026-09-19
		 * production run refused 119 story entries for unknown topic ids -- 97%
		 * of every refusal that day -- because the prompt rendered topic LABELS
		 * while this field takes topic IDS, and a work unit is a fresh session,
		 * so the model relearned the vocabulary by failing once per unit.
		 */
		topicIds: Type.Optional(
			Type.Array(Type.String(), {
				description: ctx.topicIds
					? `Reader-profile topic ids. Valid ids: ${[...ctx.topicIds].sort().join(", ")}. Unknown ids are dropped with a warning, not stored. An empty list is fine.`
					: "Reader-profile topic ids. An empty list is fine.",
			}),
		),
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

	/*
	 * Today's ledger as this session has seen it: loaded once and then kept in
	 * step with what this session writes. The neighbour check runs on every
	 * story, and re-reading the ledger for each entry of a twenty-story batch
	 * would trade a token problem for a query one. Appending as we go is also
	 * what lets the check see a duplicate inside a single batch, where nothing
	 * has been written when the batch is composed.
	 *
	 * Work units run one after another, so the only writer during a unit is that
	 * unit. A story a concurrent session added would be missed here -- and is
	 * still named by list_today_stories, which reads the ledger itself.
	 */
	let todayCache: StoryLedgerEntry[] | undefined;
	const loadToday = async (): Promise<StoryLedgerEntry[]> => {
		todayCache ??= await ctx.repo.listStories(ctx.date);
		return todayCache;
	};

	/*
	 * One story's write, shared by every entry of a commit.
	 *
	 * It records no tool call of its own. A batch entry is not a tool call, and
	 * emitting one per entry made the 2026-09-18 trace read as 227 single writes
	 * against 36 batched ones when the truth was 33 batch calls and 2 singles --
	 * and the conclusion drawn from that artifact, that the model would not
	 * batch, was wrong. The caller reports what the model actually sent.
	 */
	const upsertOne = async (
		raw: Record<string, unknown>,
	): Promise<{
		receipt: ReturnType<typeof toStoryReceipt>;
		history?: ReturnType<typeof toHistoryView>[];
		note?: string;
		/** Topic ids this write discarded, so a batch can report its own total. */
		droppedTopicIds?: string[];
		/** Today's nearest existing story, when the check fired, for the same reason. */
		near?: { storyId: string; top: string; score: number; candidates: string[] };
	}> => {
		const parsed = StoryUpsertInput.safeParse({
			...raw,
			factRefs: (raw["factRefs"] as unknown[] | undefined) ?? [],
			topicIds: (raw["topicIds"] as unknown[] | undefined) ?? [],
		});
		if (!parsed.success) {
			throw rejectFromZod("story payload rejected", parsed.error);
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
		/*
		 * An unknown topic id is a vocabulary error, not an unsafe reference.
		 *
		 * It used to refuse the whole entry, which threw away a complete
		 * editorial judgement -- the cluster, its sources, its scores, its
		 * reasoning -- and demanded another model turn to resend it with one
		 * string removed. On 2026-09-19 that cost about six otherwise
		 * unnecessary turns at ~27k tokens of re-sent context each.
		 *
		 * The id refers to a reader profile that already exists, so an id that
		 * is not in it simply records nothing. Dropping it is strictly safer
		 * than refusing: no false prior is stored either way, and the story
		 * survives. Nothing is remapped or invented -- a dropped id is dropped,
		 * and the model is told which, so it can use the right one next time.
		 *
		 * Unsafe references keep refusing: an unknown item id would let a story
		 * cite something that does not exist, an unknown fact ref would put a
		 * number in the brief with no source, and a malformed payload is not a
		 * judgement at all.
		 */
		const droppedTopicIds = ctx.topicIds
			? input.topicIds.filter((t) => !ctx.topicIds!.has(t))
			: [];
		if (droppedTopicIds.length > 0) {
			input.topicIds = input.topicIds.filter((t) => ctx.topicIds!.has(t));
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

		/*
		 * The same check, against today.
		 *
		 * The prior-day lookup above exists because a story that ran yesterday
		 * should keep its id; nothing did the equivalent for the story written
		 * twenty minutes ago by the previous work unit, and the tool that was
		 * supposed to cover it -- the whole ledger, injected once per unit --
		 * demonstrably did not: on 2026-09-19 the day shipped at least ten pairs
		 * that are one event under two slugs, including
		 * `openai-astra-for-law` beside `openai-astra-law`, written four units
		 * apart with the full 153-row list in context both times. A model does
		 * not re-read 153 rows before every story; it reads a note attached to
		 * the receipt it was already waiting for.
		 *
		 * Advisory, never a rejection. Whether two similar titles are one event
		 * is exactly the editorial judgement this stage exists to make, and the
		 * measure here is token overlap, which cannot tell "CFTC extends passive
		 * software relief" from "CFTC eases passive wallet registration". So
		 * this names candidates and stops. It fires only for a story that is new
		 * today, because a merge into an existing id is already the thing it
		 * would be advising.
		 */
		const todayStories = await loadToday();
		const alreadyToday = todayStories.some((s) => s.storyId === input.storyId);
		const todayNear = alreadyToday
			? []
			: rankToday(todayStories, input.canonicalTitle, input.storyId)
					.filter((r) => r.score >= TODAY_NEAR_SCORE)
					.slice(0, TODAY_NEAR_LIMIT);

		const entry = await ctx.repo.upsertStory(ctx.date, input, ctx.now());
		const at = todayStories.findIndex((s) => s.storyId === entry.storyId);
		if (at === -1) todayStories.push(entry);
		else todayStories[at] = entry;
		const rescuing = input.sourceItemIds.filter((id) => screenedOut.has(id));
		const notes: string[] = [];
		if (droppedTopicIds.length > 0) {
			notes.push(
				`Dropped topic id(s) not in the reader profile: ${droppedTopicIds.join(", ")}. ` +
					`The story was stored without them. Valid ids: ${[...(ctx.topicIds ?? [])].sort().join(", ")}.`,
			);
		}
		if (todayNear.length > 0) {
			notes.push(
				`These stories already exist today and may be the same event: ` +
					`${todayNear.map((r) => `${r.entry.storyId} ("${r.entry.canonicalTitle}")`).join("; ")}. ` +
					`If one of them is, re-upsert this coverage under that storyId -- it merges the sources ` +
					`instead of splitting the event across two entries. If they are different events, ignore this.`,
			);
		}
		if (input.changeType === "NEW" && history.length > 0) {
			notes.push(
				`History exists for this story (${history.map((h) => `${h.storyId}@${h.date}`).join(", ")}). ` +
					`If today's coverage continues one of them, re-upsert with that storyId and a non-NEW changeType.`,
			);
		}
		if (rescuing.length > 0) {
			notes.push(
				`${rescuing.length} source(s) (${rescuing.join(", ")}) were set aside by the screener. ` +
					`Include a decision for each in this commit (CANDIDATE or DUPLICATE, storyId ${entry.storyId}) -- submit_materials rejects a cited source with no decision.`,
			);
		}
		return {
			receipt: toStoryReceipt(entry),
			...(history.length > 0 ? { history: history.map(toHistoryView) } : {}),
			...(notes.length > 0 ? { note: notes.join(" ") } : {}),
			...(droppedTopicIds.length > 0 ? { droppedTopicIds } : {}),
		};
	};

	const commitCurationBatch = defineTool({
		name: "commit_curation_batch",
		label: "Commit curation batch",
		description:
			"Commit your complete judgement about the batch of items you just reviewed: the stories the batch's items belong to, and a disposition for every item in it. This is the one call that ends a batch — it writes the stories, checks each one's history for you, records the decisions, and tells you whether the work unit is finished. Stories are applied independently: a refused story is reported on its own and the rest are kept, and any decision naming a story that did not commit is refused with it so nothing is recorded pointing at a story that does not exist. Use CANDIDATE with a storyId for an item that feeds a story, DUPLICATE with a storyId for redundant coverage of one, IRRELEVANT for noise.",
		promptSnippet: "commit_curation_batch: write a page's stories and decisions in one call",
		parameters: Type.Object({
			/*
			 * Room for a whole page's events in one call.
			 *
			 * The old batch tool capped at 20 and one of 2026-09-19's 33 batches
			 * landed exactly on it, which is the shape of a clip rather than a
			 * coincidence. Now that the decisions travel with the stories, a
			 * 50-item page is meant to be one commit, and a page that happens to
			 * hold 22 distinct events should not be split into two model turns by
			 * a number.
			 */
			stories: Type.Optional(Type.Array(storyPayload, { maxItems: 25 })),
			decisions: Type.Optional(Type.Array(
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
			)),
		}),
		execute: async (_id, params) => {
			const decisions = params.decisions ?? [];
			if ((params.stories ?? []).length === 0 && decisions.length === 0) {
				throw new ToolRejection(
					"commit_curation_batch needs stories, decisions, or both. An empty commit records nothing.",
				);
			}
			const accepted: Array<Record<string, unknown>> = [];
			const droppedTopicIds: string[][] = [];
			const near: Array<{ storyId: string; top: string; score: number; candidates: string[] }> = [];
			const rejectedStories: Array<{ index: number; storyId: string; error: string }> = [];
			for (const [index, story] of (params.stories ?? []).entries()) {
				try {
					const result = await upsertOne(story as Record<string, unknown>);
					if (result.droppedTopicIds) droppedTopicIds.push(result.droppedTopicIds);
					if (result.near) near.push(result.near);
					accepted.push({
						...result.receipt,
						...(result.history ? { history: result.history } : {}),
						...(result.note ? { note: result.note } : {}),
					});
				} catch (err) {
					if (!(err instanceof ToolRejection)) throw err;
					rejectedStories.push({ index, storyId: String(story.storyId ?? ""), error: err.message });
				}
			}

			/*
			 * Which story ids a decision may name: everything today holds after the
			 * writes above, which covers the stories this call just created. An id
			 * from an earlier day is still valid and is looked up individually,
			 * exactly as it was before -- that path is rare and should not cost a
			 * lookup per decision.
			 */
			const todayIds = new Set((await ctx.repo.listStories(ctx.date)).map((st) => st.storyId));
			const refusedIds = new Set(rejectedStories.map((r) => r.storyId).filter((id) => id !== ""));

			const toRecord: ItemDecision[] = [];
			const rejectedDecisions: Array<{ itemId: string; error: string }> = [];
			const stamp = ctx.now().toISOString();
			const seenItems = new Set<string>();
			for (const raw of decisions) {
				const parsed = ItemDecisionInput.safeParse(raw);
				if (!parsed.success) {
					rejectedDecisions.push({
						itemId: String(raw.itemId ?? ""),
						error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
					});
					continue;
				}
				const d = parsed.data;
				if (!itemsById.has(d.itemId)) {
					rejectedDecisions.push({
						itemId: d.itemId,
						error: `unknown item id; ids come from tool results only`,
					});
					continue;
				}
				if (seenItems.has(d.itemId)) {
					rejectedDecisions.push({ itemId: d.itemId, error: "duplicate itemId in this batch" });
					continue;
				}
				if (d.storyId !== undefined && !todayIds.has(d.storyId)) {
					// The pointed case first: the model wrote this story in this very
					// call and it was refused, so the fix is the story, not the
					// decision.
					if (refusedIds.has(d.storyId)) {
						rejectedDecisions.push({
							itemId: d.itemId,
							error: `story "${d.storyId}" was refused above, so this decision was not recorded. Fix that story and resend both.`,
						});
						continue;
					}
					if (!(await ctx.repo.getStory(d.storyId))) {
						rejectedDecisions.push({
							itemId: d.itemId,
							error: `story "${d.storyId}" does not exist. Include it in this call's stories, or name one that does.`,
						});
						continue;
					}
				}
				seenItems.add(d.itemId);
				toRecord.push({ ...d, decidedAt: stamp });
			}

			if (toRecord.length > 0) await ctx.repo.recordDecisions(ctx.date, toRecord);
			// Spent after the write, so a refused decision never costs the turn
			// budget. Rescues are not charged: the budget bounds the broad scan, and
			// a rescue is the Curator following a story past what the scan offered.
			const rescuedNow = toRecord.filter((d) => screenedOut.has(d.itemId)).length;
			ctx.turnBudget?.spend(toRecord.length - rescuedNow);

			const account = await accounting();
			const unseenLeft = account.unaccountedItemIds.length;
			/*
			 * The work unit closes here rather than on a further question.
			 *
			 * Until now the only thing that said "stop" was `list_unseen_items`
			 * returning an empty page, so every unit ended by asking TypeScript
			 * whether it was finished -- one model turn per unit, twelve a day, to
			 * be told something the orchestrator already knew. The commit that
			 * spends the last of the budget is the moment it becomes true, so it is
			 * the moment it is said.
			 */
			const complete = ctx.turnBudget?.exhausted === true && unseenLeft > 0;
			const payload = {
				stories: {
					accepted,
					...(rejectedStories.length > 0 ? { rejected: rejectedStories } : {}),
				},
				decisions: {
					recorded: toRecord.length,
					...(rescuedNow > 0 ? { rescued: rescuedNow } : {}),
					...(rejectedDecisions.length > 0 ? { rejected: rejectedDecisions } : {}),
				},
				processedItems: account.curatorDecided,
				totalItems: account.sentToCurator,
				unseenItems: unseenLeft,
				...(complete
					? {
							turnComplete: true,
							note:
								`This work unit is complete (${ctx.turnBudget!.spent} decisions recorded). ` +
								`${unseenLeft} item(s) remain and will be offered to the next session, which ` +
								`resumes from this exact state. Stop now: do not call submit_materials, do not ` +
								`list more items, and do not look for other work. Simply end your reply.`,
						}
					: {}),
			};
			const rejectedBy: Record<string, number> = {};
			for (const r of rejectedStories) {
				const kind = upsertRejectionKind(r.error);
				rejectedBy[kind] = (rejectedBy[kind] ?? 0) + 1;
			}
			note("commit_curation_batch", {
				accepted: accepted.length,
				...(droppedTopicIds.length > 0 ? { droppedTopicIds } : {}),
				...(near.length > 0 ? { near } : {}),
				rejectedStories: rejectedStories.length,
				...(rejectedStories.length > 0 ? { rejectedBy } : {}),
				recorded: toRecord.length,
				rejectedDecisions: rejectedDecisions.length,
				processedItems: account.curatorDecided,
				unseenItems: unseenLeft,
				...(complete ? { turnComplete: true } : {}),
			});
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

	/*
	 * Asking a question of a source instead of reading it.
	 *
	 * The measured alternative is worse in both directions. Reading the whole
	 * article costs its length on every later turn of the work unit. Searching
	 * it with a term guessed from the headline works only when the decisive fact
	 * is the one the summary already mentions: on the 2026-09-19 items a blind
	 * keyword proposer missed 31% of the time, and on the day's Must Know story
	 * it would have led the Curator to the one case the article says had no
	 * effect -- returning evidence for the opposite of the published judgement.
	 */
	const getItemEvidence = evidenceConfig
		? defineTool({
				name: "get_item_evidence",
				label: "Item evidence",
				description:
					"Ask one question of up to five items and get back a short answer with the passages that support it, quoted from the item and checked against it character for character. Prefer this over reading an article whenever you would be reading it to find something out: whether two items describe the same event, what a filing actually says, whether a claim is sourced. A passage you get back is real text at a real offset; anything that could not be checked is discarded and counted, so a thin packet is a thin answer and the story's confidence should say so. Items with no body, or that could not be read, come back marked -- use read_item_body for those.",
				promptSnippet: "get_item_evidence: ask a question of specific items and get checked quotes",
				parameters: Type.Object({
					itemIds: Type.Array(Type.String(), { minItems: 1, maxItems: evidenceConfig.config.maxItemsPerCall }),
					question: Type.String({ minLength: 10, maxLength: 300 }),
				}),
				execute: async (_id, params) => {
					const unknown = params.itemIds.filter((id) => !itemsById.has(id));
					if (unknown.length > 0) {
						throw new ToolRejection(
							`Unknown item id(s): ${unknown.join(", ")}. Item ids come from list_unseen_items or search_items — never construct one.`,
						);
					}
					if (evidenceCalls >= evidenceConfig!.config.maxCallsPerRun) {
						// Not a rejection: the budget is a fact about the run, and a
						// refusal would cost a turn to learn it.
						return ok({
							question: params.question,
							items: [],
							note: "The evidence budget for this run is spent. Read what you need with read_item_body.",
						});
					}
					evidenceCalls += 1;
					const outcome = await distillEvidence(
						params.itemIds.map((id) => {
							const item = itemsById.get(id)!;
							return {
								itemId: id,
								title: item.title,
								sourceName: item.sourceName,
								body: canonicalBody(item),
							};
						}),
						params.question,
						{
							config: evidenceConfig!.config,
							apiKey: evidenceConfig!.apiKey,
							...(evidenceConfig!.fetchImpl ? { fetchImpl: evidenceConfig!.fetchImpl } : {}),
						},
					);
					if (outcome.degraded) evidenceConfig!.onDegraded?.(outcome.degraded);
					note("get_item_evidence", {
						items: params.itemIds.length,
						ok: outcome.items.filter((i) => i.status === "OK").length,
						noEvidence: outcome.items.filter((i) => i.status === "NO_EVIDENCE").length,
						unavailable: outcome.items.filter((i) => i.status === "UNAVAILABLE").length,
						quotes: outcome.items.reduce((n, i) => n + (i.evidence?.length ?? 0), 0),
						dropped: outcome.items.reduce((n, i) => n + (i.dropped ?? 0), 0),
						sourceChars: outcome.items.reduce((n, i) => n + i.bodyChars, 0),
						durationMs: outcome.durationMs,
						tokenUsage: outcome.usage ?? "unavailable",
					});
					return ok({ question: params.question, items: outcome.items });
				},
			})
		: undefined;

	return [
		getDailyInventory,
		listUnseenItems,
		getItemDetail,
		readItemBody,
		searchItems,
		findHistory,
		getStory,
		listTodayStories,
		commitCurationBatch,
		getStructuredFacts,
		submitMaterials,
		...(getItemEvidence ? [getItemEvidence] : []),
		...(searchWeb ? [searchWeb] : []),
	].map(withBoundary);
}
