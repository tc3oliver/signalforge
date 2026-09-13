import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
	AgentDriver,
	AgentDriverFactory,
	AgentDriverOptions,
} from "../../src/runtime/agent-driver.ts";
import type { DailyManifest, NormalizedItem, StructuredFact } from "../../src/schemas/index.ts";
import type { Phase1Paths } from "../../src/runtime/orchestrator.ts";

/**
 * The integration layer's stand-in for a model. It receives the REAL tool array
 * the session driver built, so every tool, validator and repository under test is
 * the production one — only the thing choosing tool calls is scripted.
 */
export interface ScriptApi {
	/** Invoke a tool by name. A tool rejection propagates so a script can assert it. */
	call<T = any>(name: string, args?: unknown): Promise<T>;
	/** The prompt text the session driver sent for this turn. */
	promptText: string;
	/** 1-based turn number within this driver (one per `prompt()`). */
	turn: number;
	/** Names of the tools this session actually has. */
	toolNames: string[];
	/** The options the session driver constructed this driver with. */
	driverOptions: AgentDriverOptions;
}

export type Script = (api: ScriptApi) => Promise<void>;

/** Chooses the script for each driver, e.g. by model, in fallback tests. */
export type ScriptResolver = (opts: AgentDriverOptions) => Script | Script[];

export interface FakeDriverOptions {
	/** Called once per driver creation, before any prompt. */
	onCreate?: (opts: AgentDriverOptions) => void;
	/** Record of every tool call made through any driver of this factory. */
	toolLog?: Array<{ name: string; args: unknown; result?: unknown; error?: unknown }>;
}

export class FakeToolMissingError extends Error {}

function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
	const first = result.content[0];
	const text = first && "text" in first ? (first.text ?? "") : "";
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/**
 * Build an {@link AgentDriverFactory} that replays scripts instead of calling a
 * model. Each `prompt()` consumes the next script; a single script is re-run for
 * every prompt with an incremented `turn`, which is how the nudge loop is
 * simulated. When the array is exhausted the driver does nothing, letting the
 * real "did not submit" path run.
 */
export function createFakeDriverFactory(
	source: Script | Script[],
	options: FakeDriverOptions = {},
): AgentDriverFactory {
	return createResolvedDriverFactory(() => source, options);
}

/** Same, but the script is chosen per driver — used to give each model its own behaviour. */
export function createResolvedDriverFactory(
	resolve: ScriptResolver,
	options: FakeDriverOptions = {},
): AgentDriverFactory {
	return async (driverOptions: AgentDriverOptions): Promise<AgentDriver> => {
		options.onCreate?.(driverOptions);
		const resolved = resolve(driverOptions);

		const tools: ToolDefinition[] = driverOptions.customTools;
		const byName = new Map(tools.map((t) => [t.name, t]));
		let turn = 0;
		let callSeq = 0;
		let disposed = false;

		const call = async <T,>(name: string, args: unknown = {}): Promise<T> => {
			const tool = byName.get(name);
			if (!tool) {
				throw new FakeToolMissingError(
					`No tool named "${name}". Available: ${[...byName.keys()].join(", ")}`,
				);
			}
			callSeq += 1;
			try {
				const result = await tool.execute(`call-${callSeq}`, args as never, undefined, undefined, {} as never);
				const parsed = parseResult(result as never) as T;
				options.toolLog?.push({ name, args, result: parsed });
				return parsed;
			} catch (err) {
				options.toolLog?.push({ name, args, error: err });
				throw err;
			}
		};

		return {
			async prompt(text: string): Promise<void> {
				if (disposed) throw new Error("prompt() after dispose()");
				turn += 1;
				const script = Array.isArray(resolved) ? resolved[turn - 1] : resolved;
				if (!script) return;
				await script({
					call,
					promptText: text,
					turn,
					toolNames: [...byName.keys()],
					driverOptions,
				});
			},
			getActiveToolNames: () => [...byName.keys()],
			dispose: () => {
				disposed = true;
			},
		};
	};
}

/** A driver factory whose creation always throws — simulates a dead model. */
export function createThrowingDriverFactory(error: unknown): AgentDriverFactory {
	return async () => {
		throw error;
	};
}

/** Attach `status`/`message` the way a provider SDK error does. */
export function providerError(message: string, status: number): Error & { status: number } {
	const err = new Error(message) as Error & { status: number };
	err.status = status;
	return err;
}

/* -------------------------------------------------------------------------- */
/* Synthetic manifests                                                        */
/* -------------------------------------------------------------------------- */

export interface SyntheticManifestOptions {
	date: string;
	/** Number of distinct story groups. */
	groups: number;
	/** Items per group. */
	perGroup?: number;
	/** Number of structured facts to attach (to the first item of the first groups). */
	facts?: number;
}

/**
 * A small, fully deterministic manifest. Items carry `metadata.group`, which is
 * what the scripted curator clusters on — deliberately dumb, because these tests
 * are about the machinery and not about curation quality.
 */
export function makeManifest(opts: SyntheticManifestOptions): DailyManifest {
	const perGroup = opts.perGroup ?? 2;
	const items: NormalizedItem[] = [];
	let n = 0;
	for (let g = 0; g < opts.groups; g++) {
		const group = `g${String(g + 1).padStart(2, "0")}`;
		for (let k = 0; k < perGroup; k++) {
			n += 1;
			items.push({
				id: `itm-${opts.date.replace(/-/g, "")}-${String(n).padStart(4, "0")}`,
				sourceType: k === 0 ? "rss" : "hackernews",
				trust: "UNTRUSTED_EXTERNAL_CONTENT" as const,
				sourceName: k === 0 ? "Synthetic Wire" : "Hacker News",
				title: `${group} coverage ${k + 1}: something measurable happened`,
				summary: `Report ${k + 1} about event ${group}.`,
				content: `Full body for ${group} coverage ${k + 1}.`,
				url: `https://example.invalid/${group}/${k + 1}`,
				publishedAt: `${opts.date}T0${(n % 9) + 1}:00:00.000Z`,
				metadata: { group },
			});
		}
	}

	const facts: StructuredFact[] = [];
	for (let f = 0; f < (opts.facts ?? 0); f++) {
		const item = items[f * perGroup] ?? items[0]!;
		facts.push({
			factId: `fct-${opts.date.replace(/-/g, "")}-${String(f + 1).padStart(3, "0")}`,
			kind: "macro",
			label: `Synthetic metric ${f + 1}`,
			value: 100 + f,
			unit: "index",
			asOf: `${opts.date}T09:00:00.000Z`,
			sourceItemId: item.id,
		});
	}

	return { date: opts.date, generatedAt: `${opts.date}T00:00:00.000Z`, items, facts };
}

/** The grouping the scripted curator uses: `metadata.group`, else the item id. */
export function groupOf(item: { id: string; metadata: Record<string, unknown> }): string {
	const g = item.metadata["group"];
	return typeof g === "string" ? g : item.id;
}

export function storyIdFor(group: string): string {
	return `story-${group}`;
}

/* -------------------------------------------------------------------------- */
/* Competent agents                                                           */
/* -------------------------------------------------------------------------- */

export interface CuratorScriptOptions {
	/** Stop after deciding this many items, without submitting. */
	stopAfterItems?: number;
	/** Page size passed to list_unseen_items. */
	pageSize?: number;
	/** Skip the final submit_materials call. */
	skipSubmit?: boolean;
	/** Observe every group the script created, for assertions. */
	onStory?: (storyId: string, itemIds: string[]) => void;
	/** Observe each page returned by list_unseen_items. */
	onPage?: (itemIds: string[]) => void;
	/** Called just before submit_materials, so a test can see which model got that far. */
	onSubmit?: () => void;
	/**
	 * Shared group -> item ids accumulator. Pass the same Map to two scripts so the
	 * second one submits materials covering stories the first one created: the
	 * curator tools expose no way to enumerate stories from an earlier session, so a
	 * resumed run has to be told, and in a real run that is the model's own memory.
	 */
	groups?: Map<string, string[]>;
}

type UnseenPage = {
	items: Array<{ id: string; metadata: Record<string, unknown> }>;
	returned: number;
	remainingAfterPage: number;
	nextCursor: string | null;
};

/**
 * Plays a curator that is complete and valid without being smart: it pages every
 * unseen item, clusters by `metadata.group`, upserts one story per group and
 * records a decision for every item, then submits.
 */
export function competentCuratorScript(opts: CuratorScriptOptions = {}): Script {
	const pageSize = opts.pageSize ?? 50;
	return async ({ call }) => {
		await call("get_daily_inventory", {});

		/** group -> item ids, accumulated across pages. */
		const groups = opts.groups ?? new Map<string, string[]>();
		let decided = 0;
		let done = false;

		while (!done) {
			const page = await call<UnseenPage>("list_unseen_items", { limit: pageSize });
			if (page.returned === 0) break;
			opts.onPage?.(page.items.map((i) => i.id));

			let batch = page.items;
			if (opts.stopAfterItems !== undefined) {
				const room = Math.max(0, opts.stopAfterItems - decided);
				batch = batch.slice(0, room);
				if (batch.length < page.items.length) done = true;
			}
			if (batch.length === 0) break;

			const pageGroups = new Map<string, string[]>();
			for (const item of batch) {
				const g = groupOf(item);
				pageGroups.set(g, [...(pageGroups.get(g) ?? []), item.id]);
			}

			for (const [group, itemIds] of pageGroups) {
				const merged = [...(groups.get(group) ?? []), ...itemIds];
				groups.set(group, merged);
				await call("upsert_story", {
					storyId: storyIdFor(group),
					canonicalTitle: `Event ${group}`,
					sourceItemIds: itemIds,
					primarySourceIds: [itemIds[0]],
					status: "OPEN",
					changeType: "NEW",
					relevance: 0.8,
					novelty: 0.7,
					importance: 0.6,
					confidence: 0.9,
					reason: `All coverage of ${group} clusters into one story.`,
				});
				opts.onStory?.(storyIdFor(group), merged);
			}

			await call("record_item_decisions", {
				decisions: batch.map((item, idx) => ({
					itemId: item.id,
					disposition: idx === 0 ? "CANDIDATE" : "DUPLICATE",
					storyId: storyIdFor(groupOf(item)),
					reason: `Assigned to ${storyIdFor(groupOf(item))}.`,
				})),
			});
			decided += batch.length;

			if (page.nextCursor === null) break;
		}

		if (opts.skipSubmit || opts.stopAfterItems !== undefined) return;

		opts.onSubmit?.();
		await call("submit_materials", {
			stories: [...groups.entries()].map(([group, itemIds], i) => ({
				storyId: storyIdFor(group),
				tier: i < 3 ? "A" : i < 8 ? "B" : "C",
				canonicalTitle: `Event ${group}`,
				whySelected: `Event ${group} is the distinct thing that happened.`,
				changeType: "NEW",
				importance: 0.6,
				novelty: 0.7,
				confidence: 0.9,
				sourceItemIds: itemIds,
				primarySourceIds: [itemIds[0]],
			})),
			curatorNotes: "Scripted curator.",
		});
	};
}

const SECTIONS = ["AI_LLM", "DEVELOPER_OSS", "RESEARCH", "CRYPTO_MARKET", "MACRO", "COMPANIES"] as const;

export interface EditorScriptOptions {
	/** How many stories to put in the brief (used to script an invalid attempt). */
	storyCount?: number;
	/** How many stories to flag mustKnow. */
	mustKnowCount?: number;
	/** Mutate the payload just before submitting, to script a specific violation. */
	mutate?: (payload: any, materials: any) => void;
	/** Swallow the rejection instead of propagating it (used for retry scripts). */
	tolerateRejection?: boolean;
}

/** Plays an editor producing a valid 8-15 story, 3-5 Must Know brief. */
export function competentEditorScript(opts: EditorScriptOptions = {}): Script {
	return async ({ call }) => {
		const materials = await call<{ stories: any[] }>("get_materials", {});
		const take = Math.min(opts.storyCount ?? Math.min(materials.stories.length, 15), materials.stories.length);
		const chosen = materials.stories.slice(0, take);
		const mustKnow = opts.mustKnowCount ?? 3;

		const payload = {
			stories: chosen.map((s, i) => ({
				storyId: s.storyId,
				section: i < mustKnow ? "MUST_KNOW" : SECTIONS[i % SECTIONS.length],
				mustKnow: i < mustKnow,
				title: `${s.canonicalTitle}`,
				whatHappened: `What happened in ${s.canonicalTitle}.`,
				whyItMatters: `Why ${s.canonicalTitle} matters.`,
				whatChanged: `What changed today for ${s.canonicalTitle}.`,
				impact: `Impact of ${s.canonicalTitle}.`,
				confidence: "HIGH",
				sourceItemIds: s.sourceItemIds,
				factRefs: s.factRefs ?? [],
			})),
			dailyAnalysis: "Scripted editor analysis of the day.",
			watchNext: ["Whether the scripted stories develop tomorrow."],
		};
		opts.mutate?.(payload, materials);

		try {
			await call("submit_brief", payload);
		} catch (err) {
			if (!opts.tolerateRejection) throw err;
		}
	};
}

/* -------------------------------------------------------------------------- */
/* Paths                                                                      */
/* -------------------------------------------------------------------------- */

/** The checked-out repository root, used to reach the real skills and gold dirs. */
export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

/**
 * Run paths rooted in a temp dir: fixtures, ledger and runs are disposable, while
 * skills point at the real `agent/skills` because the skill bundle is under test.
 */
export function makeTestPaths(root: string): Phase1Paths {
	return {
		root,
		fixturesDir: join(root, "fixtures", "generated"),
		ledgerDir: join(root, "runs", "_ledger"),
		runsDir: join(root, "runs"),
		skillsRoot: join(REPO_ROOT, "agent", "skills"),
		goldDir: join(REPO_ROOT, "eval", "gold"),
	};
}

/** Write a manifest where `loadManifest` will look for it. */
export function writeManifest(paths: Phase1Paths, manifest: DailyManifest): void {
	const dir = join(paths.fixturesDir, manifest.date);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

/** Every file under `dir`, as paths relative to it. */
export function walkFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (cur: string, prefix: string): void => {
		for (const entry of readdirSync(cur, { withFileTypes: true })) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(join(cur, entry.name), rel);
			else out.push(rel);
		}
	};
	walk(dir, "");
	return out.sort();
}
