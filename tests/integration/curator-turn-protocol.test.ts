import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCuratorStage } from "../../src/curator/session.ts";
import { ProgressYieldError } from "../../src/runtime/progress-yield.ts";
import { MODEL_CHAIN } from "../../src/runtime/model-config.ts";
import { JsonStoryRepository } from "../../src/stories/json-repository.ts";
import {
	REPO_ROOT,
	createFakeDriverFactory,
	groupOf,
	makeManifest,
	storyIdFor,
	type Script,
} from "../support/fake-agent.ts";

/*
 * The shape of a work unit, measured in model turns.
 *
 * On 2026-09-19 a unit was nine turns and four of them asked TypeScript
 * questions TypeScript had already answered: what the counts are, which items
 * are next, which stories exist, and -- at the end -- whether the unit was
 * finished. Across twelve units that is forty-four of 112 turns.
 *
 * The protocol these pin is: the session opens holding that state, the model
 * commits its judgement in one call, and the commit itself says the unit is
 * over. A curator that never touches a fetch tool must still be able to work
 * and must still yield, because that is the whole claim.
 */

const DATE = "2026-09-16";
const SKILLS_ROOT = join(REPO_ROOT, "agent", "skills");

let root: string;
let toolsUsed: string[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "di-turn-protocol-"));
	toolsUsed = [];
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

interface SeededPage {
	items: Array<{ id: string; metadata: Record<string, unknown> }>;
	returned: number;
	remainingAfterPage: number;
	nextCursor: string | null;
}

/** The page the session handed the model, parsed out of the prompt it sent. */
function seededPage(promptText: string): SeededPage | undefined {
	const match = promptText.match(/\{"items":.*?"nextCursor":(?:null|"[^"]*")\}/s);
	return match ? (JSON.parse(match[0]) as SeededPage) : undefined;
}

function seededStoryIds(promptText: string): string[] | undefined {
	const match = promptText.match(/^\[(?:"[^"]*"(?:,"[^"]*")*)?\]$/m);
	return match ? (JSON.parse(match[0]) as string[]) : undefined;
}

/**
 * A curator that works only from what it was given: no inventory call, no
 * paging call, no story listing, one commit, and it stops when told.
 */
const seededScript = async ({ call, promptText }: { call: <T = unknown>(n: string, a?: unknown) => Promise<T>; promptText: string }): Promise<{ unseenItems: number } | undefined> => {
	const page = seededPage(promptText);
	if (!page || page.returned === 0) return undefined;
	const groups = new Map<string, string[]>();
	for (const item of page.items) {
		const g = groupOf(item);
		groups.set(g, [...(groups.get(g) ?? []), item.id]);
	}
	return call<{ unseenItems: number }>("commit_curation_batch", {
		stories: [...groups.entries()].map(([g, ids]) => ({
			storyId: storyIdFor(g),
			canonicalTitle: `Event ${g}`,
			sourceItemIds: ids,
			primarySourceIds: [ids[0]],
			status: "OPEN",
			changeType: "NEW",
			relevance: 0.5,
			novelty: 0.5,
			importance: 0.5,
			confidence: 0.6,
			reason: "grouped",
		})),
		decisions: page.items.map((i) => ({
			itemId: i.id,
			disposition: "CANDIDATE",
			storyId: storyIdFor(groupOf(i)),
			reason: "candidate",
		})),
	});
};

/** The same curator, plus the one thing that ends the day. */
const submittingScript: Script = async (api) => {
	const committed = await seededScript(api);
	// The day is over when the commit says nothing is unseen -- not when a
	// further call is made to ask.
	if (committed && committed.unseenItems > 0) return;
	const ids = (await api.call<{ storyIds: string[] }>("list_today_stories", {})).storyIds;
	const entries = await Promise.all(
		ids.slice(0, 10).map((storyId) => api.call<{ story: { sourceItemIds: string[]; primarySourceIds: string[] } | null }>("get_story", { storyId })),
	);
	await api.call("submit_materials", {
		curatorNotes: "Scripted curator.",
		stories: ids.slice(0, 10).map((storyId, i) => ({
			storyId,
			tier: i < 3 ? "A" : "B",
			canonicalTitle: `Event ${storyId}`,
			whySelected: `Event ${storyId} is the distinct thing that happened.`,
			changeType: "NEW",
			importance: 0.6,
			novelty: 0.7,
			confidence: 0.9,
			sourceItemIds: entries[i]!.story!.sourceItemIds,
			primarySourceIds: entries[i]!.story!.primarySourceIds,
		})),
	});
};

function runOnce(opts: {
	manifest: ReturnType<typeof makeManifest>;
	repo: JsonStoryRepository;
	maxDecisionsPerTurn?: number;
	mode?: "FRESH" | "RESUME";
	script?: Script;
}) {
	return runCuratorStage({
		date: DATE,
		manifest: opts.manifest,
		repo: opts.repo,
		spec: MODEL_CHAIN[0]!,
		skillsRoot: SKILLS_ROOT,
		cwd: root,
		driverFactory: createFakeDriverFactory(opts.script ?? (async (api) => void (await seededScript(api)))),
		mode: opts.mode ?? "FRESH",
		maxNudges: 0,
		onEvent: (e) => {
			if (e["kind"] === "tool_call") toolsUsed.push(String(e["tool"]));
		},
		...(opts.maxDecisionsPerTurn === undefined ? {} : { maxDecisionsPerTurn: opts.maxDecisionsPerTurn }),
	});
}

describe("a work unit opens with its state, not with fetches", () => {
	it("hands the model the page, the counts and the story ids in the prompt", async () => {
		const manifest = makeManifest({ date: DATE, groups: 10, perGroup: 4 }); // 40 items
		const repo = new JsonStoryRepository(join(root, "ledger"));
		let seen = "";
		await runOnce({
			manifest,
			repo,
			maxDecisionsPerTurn: 20,
			script: async ({ promptText }) => {
				seen = promptText;
			},
		}).catch(() => undefined);

		const page = seededPage(seen);
		expect(page?.returned).toBe(20);
		expect(page?.remainingAfterPage).toBe(20);
		expect(seen).toContain("40 offered items");
		// An empty ledger is said in words, not as an empty array to be parsed.
		expect(seen).toContain("No stories exist for today yet");
	});

	it("lets a curator finish a unit without a single fetch tool", async () => {
		const manifest = makeManifest({ date: DATE, groups: 10, perGroup: 4 });
		const repo = new JsonStoryRepository(join(root, "ledger"));

		const err = await runOnce({ manifest, repo, maxDecisionsPerTurn: 20 }).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(ProgressYieldError);
		expect((err as ProgressYieldError).info.decidedAfter).toBe(20);
		// No opening fetch, and no closing completion check.
		expect(toolsUsed).toEqual(["commit_curation_batch"]);
	});

	it("carries the ids of stories earlier units wrote into a resume", async () => {
		const manifest = makeManifest({ date: DATE, groups: 10, perGroup: 4 });
		const repo = new JsonStoryRepository(join(root, "ledger"));
		await runOnce({ manifest, repo, maxDecisionsPerTurn: 20 }).catch(() => undefined);

		let seen = "";
		await runOnce({
			manifest,
			repo,
			maxDecisionsPerTurn: 20,
			mode: "RESUME",
			script: async ({ promptText }) => {
				seen = promptText;
			},
		}).catch(() => undefined);

		expect(seededStoryIds(seen)?.length).toBe(5);
		expect(seen).toContain("resuming curation");
		// The second unit is offered what the first did not decide, never a repeat.
		expect(seededPage(seen)?.items.map((i) => i.id)).not.toContain(
			manifest.items[0]!.id,
		);
	});

	it("keeps durable state resumable across units and finishes the backlog", async () => {
		const manifest = makeManifest({ date: DATE, groups: 10, perGroup: 4 });
		const repo = new JsonStoryRepository(join(root, "ledger"));

		let guard = 0;
		while (guard++ < 10) {
			const before = (await repo.processedItemIds(DATE)).size;
			if (before >= 40) break;
			await runOnce({
				manifest,
				repo,
				maxDecisionsPerTurn: 20,
				mode: before > 0 ? "RESUME" : "FRESH",
				script: submittingScript,
			}).catch((e: unknown) => {
				if (!(e instanceof ProgressYieldError)) throw e;
			});
			const after = (await repo.processedItemIds(DATE)).size;
			expect(after).toBeGreaterThan(before);
		}
		expect((await repo.processedItemIds(DATE)).size).toBe(40);
		// Ten groups, written once each: a resumed unit merged rather than split.
		expect((await repo.listStories(DATE)).length).toBe(10);
	});

	/*
	 * The nudge text says "keep going from the batch below" and the system prompt
	 * tells the model it never has to fetch state. If a nudge sent those words
	 * with nothing under them, a model that stopped early would have been told
	 * twice not to call `list_unseen_items` and given no other way to obtain
	 * work; re-committing from its stale in-context page writes nothing, so two
	 * such turns trip the stall check and are recorded as a model fault.
	 */
	it("re-seeds a nudge with the work that is actually left", async () => {
		const manifest = makeManifest({ date: DATE, groups: 10, perGroup: 4 }); // 40 items
		const repo = new JsonStoryRepository(join(root, "ledger"));
		const prompts: string[] = [];
		await runCuratorStage({
			date: DATE,
			manifest,
			repo,
			spec: MODEL_CHAIN[0]!,
			skillsRoot: SKILLS_ROOT,
			cwd: root,
			maxNudges: 1,
			maxDecisionsPerTurn: 40,
			driverFactory: createFakeDriverFactory(async (api) => {
				prompts.push(api.promptText);
				// Stop early on the first turn without spending the budget, which
				// is exactly what makes the session nudge.
				if (api.turn > 1) return;
				const page = seededPage(api.promptText);
				await api.call("commit_curation_batch", {
					decisions: page!.items.slice(0, 4).map((i) => ({
						itemId: i.id,
						disposition: "IRRELEVANT",
						reason: "noise",
					})),
				});
			}),
			mode: "FRESH",
		}).catch(() => undefined);

		expect(prompts.length).toBeGreaterThan(1);
		const nudge = prompts[1]!;
		expect(nudge).toContain("still have no recorded decision");
		// The batch the words promise is actually under them, and it holds only
		// what is left.
		const page = seededPage(nudge);
		expect(page).toBeDefined();
		expect(page!.returned).toBe(36);
		expect(page!.items.map((i) => i.id)).not.toContain(manifest.items[0]!.id);
	});

	it("still offers the fetch tools to a unit that wants to look again", async () => {
		const manifest = makeManifest({ date: DATE, groups: 10, perGroup: 4 });
		const repo = new JsonStoryRepository(join(root, "ledger"));
		await runOnce({
			manifest,
			repo,
			maxDecisionsPerTurn: 20,
			script: async (api) => {
				await api.call("get_daily_inventory");
				await api.call("list_today_stories", {});
				await seededScript(api);
			},
		}).catch(() => undefined);
		expect(toolsUsed).toEqual(["get_daily_inventory", "list_today_stories", "commit_curation_batch"]);
	});
});
