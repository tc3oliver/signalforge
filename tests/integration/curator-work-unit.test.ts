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
 * The bounded work unit, against the real tools.
 *
 * The fake driver receives the production tool array, so `list_unseen_items`,
 * `record_item_decisions` and the repository under test are the real ones --
 * only the thing choosing tool calls is scripted. That matters here, because the
 * ceiling is enforced inside `list_unseen_items` rather than by the session
 * asking the model to stop, and a test that stubbed the tools would be testing
 * the stub.
 */

const DATE = "2026-09-16";
const SKILLS_ROOT = join(REPO_ROOT, "agent", "skills");

let root: string;
/** Groups the scripted curator clustered, so a submit can be built from them. */
let seenGroups: Map<string, string[]>;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "di-work-unit-"));
	seenGroups = new Map();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

type Call = <T = unknown>(name: string, args?: unknown) => Promise<T>;

/**
 * A model that pages and decides until the tools stop offering it work, which
 * is what a well-behaved curator does.
 */
const pagingScript: Script = async ({ call }) => {
	for (;;) {
		const page = await call<{
			items: Array<{ id: string; metadata: Record<string, unknown> }>;
			returned: number;
			turnComplete?: boolean;
		}>("list_unseen_items", { limit: 50 });
		if (page.returned === 0) return;

		const groups = new Map<string, string[]>();
		for (const item of page.items) {
			const g = groupOf(item);
			groups.set(g, [...(groups.get(g) ?? []), item.id]);
		}
		for (const [g, ids] of groups) {
			seenGroups.set(g, [...(seenGroups.get(g) ?? []), ...ids]);
			await call("upsert_story", {
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
			});
		}
		await call("record_item_decisions", {
			decisions: page.items.map((i) => ({
				itemId: i.id,
				disposition: "CANDIDATE",
				storyId: storyIdFor(groupOf(i)),
				reason: "candidate",
			})),
		});
	}
};

/** submit_materials wants whole stories, not just ids. */
async function submitAll(call: Call): Promise<void> {
	await call("submit_materials", {
		curatorNotes: "Scripted curator.",
		stories: [...seenGroups.entries()].slice(0, 10).map(([group, itemIds], i) => ({
			storyId: storyIdFor(group),
			tier: i < 3 ? "A" : "B",
			canonicalTitle: `Event ${group}`,
			whySelected: `Event ${group} is the distinct thing that happened.`,
			changeType: "NEW",
			importance: 0.6,
			novelty: 0.7,
			confidence: 0.9,
			sourceItemIds: itemIds,
			primarySourceIds: [itemIds[0]],
		})),
	});
}

function runOnce(opts: {
	manifest: ReturnType<typeof makeManifest>;
	repo: JsonStoryRepository;
	maxDecisionsPerTurn?: number;
	script?: Script;
	mode?: "FRESH" | "RESUME";
}) {
	return runCuratorStage({
		date: DATE,
		manifest: opts.manifest,
		repo: opts.repo,
		spec: MODEL_CHAIN[0]!,
		skillsRoot: SKILLS_ROOT,
		cwd: root,
		driverFactory: createFakeDriverFactory(opts.script ?? pagingScript),
		mode: opts.mode ?? "FRESH",
		maxNudges: 0,
		...(opts.maxDecisionsPerTurn === undefined
			? {}
			: { maxDecisionsPerTurn: opts.maxDecisionsPerTurn }),
	});
}

describe("bounded curator work units", () => {
	it("yields once the work unit is spent, instead of running to the turn clock", async () => {
		const manifest = makeManifest({ date: DATE, groups: 100, perGroup: 4 }); // 400 items
		const repo = new JsonStoryRepository(join(root, "ledger"));

		const err = await runOnce({ manifest, repo, maxDecisionsPerTurn: 150 }).catch(
			(e: unknown) => e as Error,
		);

		expect(err).toBeInstanceOf(ProgressYieldError);
		const yielded = err as ProgressYieldError;
		expect(yielded.info.reason).toBe("WORK_UNIT_COMPLETE");
		// The ceiling is enforced at a page boundary, so the turn stops at the first
		// page that takes it to or past the limit rather than exactly on it.
		expect(yielded.info.decidedAfter).toBeGreaterThanOrEqual(150);
		expect(yielded.info.decidedAfter).toBeLessThan(250);
		expect(yielded.info.totalItems).toBe(400);
	});

	it("commits every decision it made before yielding", async () => {
		const manifest = makeManifest({ date: DATE, groups: 100, perGroup: 4 });
		const repo = new JsonStoryRepository(join(root, "ledger"));

		const err = (await runOnce({ manifest, repo, maxDecisionsPerTurn: 150 }).catch(
			(e: unknown) => e,
		)) as ProgressYieldError;

		const decided = await repo.processedItemIds(DATE);
		expect(decided.size).toBe(err.info.decidedAfter);
		expect(decided.size).toBeGreaterThan(0);
	});

	it("never re-decides an item across continuations, and finishes the backlog", async () => {
		const manifest = makeManifest({ date: DATE, groups: 100, perGroup: 4 }); // 400 items
		const repo = new JsonStoryRepository(join(root, "ledger"));

		// Submitting only once nothing is unseen is the real gate; the point here is
		// that the loop reaches it at all.
		const submitting: Script = async (api) => {
			await pagingScript(api);
			const inventory = await api.call<{ unseenItems: number }>("get_daily_inventory");
			if (inventory.unseenItems === 0) await submitAll(api.call as Call);
		};

		const perTurn: number[] = [];
		let guard = 0;
		let done = false;
		while (!done && guard++ < 20) {
			const before = (await repo.processedItemIds(DATE)).size;
			try {
				await runOnce({
					manifest,
					repo,
					maxDecisionsPerTurn: 150,
					script: submitting,
					mode: before > 0 ? "RESUME" : "FRESH",
				});
				done = true;
			} catch (err) {
				if (!(err instanceof ProgressYieldError)) throw err;
				perTurn.push(err.decidedThisTurn);
			}
		}

		expect(done).toBe(true);
		// Every turn moved the needle, and the total never exceeds the manifest --
		// which it would if a continuation re-read items it had already decided.
		expect(perTurn.every((n) => n > 0)).toBe(true);
		expect(perTurn.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(400);
		expect((await repo.processedItemIds(DATE)).size).toBe(400);
		expect((await repo.listDecisions(DATE)).length).toBe(400);
	});

	it("reports the unseen count correctly after a resume", async () => {
		const manifest = makeManifest({ date: DATE, groups: 100, perGroup: 4 });
		const repo = new JsonStoryRepository(join(root, "ledger"));

		const first = (await runOnce({ manifest, repo, maxDecisionsPerTurn: 150 }).catch(
			(e: unknown) => e,
		)) as ProgressYieldError;

		let inventory: { unseenItems: number; processedItems: number; totalItems: number } | undefined;
		const probe: Script = async ({ call }) => {
			inventory = await call("get_daily_inventory");
		};
		await runOnce({ manifest, repo, maxDecisionsPerTurn: 150, script: probe, mode: "RESUME" }).catch(
			() => {},
		);

		expect(inventory?.totalItems).toBe(400);
		expect(inventory?.processedItems).toBe(first.info.decidedAfter);
		expect(inventory?.unseenItems).toBe(400 - first.info.decidedAfter);
	});

	it("does not yield when the work fits, so a normal day is unchanged", async () => {
		const manifest = makeManifest({ date: DATE, groups: 10, perGroup: 2 }); // 20 items
		const repo = new JsonStoryRepository(join(root, "ledger"));

		const submitting: Script = async (api) => {
			await pagingScript(api);
			await submitAll(api.call as Call);
		};

		const result = await runOnce({ manifest, repo, maxDecisionsPerTurn: 150, script: submitting });
		expect(result.materials.stories.length).toBeGreaterThan(0);
		expect((await repo.processedItemIds(DATE)).size).toBe(20);
	});

	it("is unbounded when no work unit is configured", async () => {
		// Eval, gold and fixture runs pass no budget and must behave exactly as they
		// did before this existed: one turn, whole manifest, no yield.
		const manifest = makeManifest({ date: DATE, groups: 100, perGroup: 4 });
		const repo = new JsonStoryRepository(join(root, "ledger"));

		await runOnce({ manifest, repo }).catch(() => {});
		expect((await repo.processedItemIds(DATE)).size).toBe(400);
	});

	it("tells the model the turn is complete rather than rejecting its call", async () => {
		// A ToolRejection would read as "you did something wrong" and send the model
		// looking for other work for the rest of the turn.
		const manifest = makeManifest({ date: DATE, groups: 100, perGroup: 4 });
		const repo = new JsonStoryRepository(join(root, "ledger"));
		let finalPage: { returned: number; turnComplete?: boolean; note?: string } | undefined;

		const probe: Script = async (api) => {
			await pagingScript(api);
			finalPage = await api.call("list_unseen_items", { limit: 50 });
		};

		await runOnce({ manifest, repo, maxDecisionsPerTurn: 150, script: probe }).catch(() => {});
		expect(finalPage?.returned).toBe(0);
		expect(finalPage?.turnComplete).toBe(true);
		expect(finalPage?.note).toContain("resumes from this exact state");
	});

	it("submits only when nothing is unseen", async () => {
		// The scan-coverage guarantee is unchanged by any of this: a bounded turn
		// that tried to submit early is still refused.
		const manifest = makeManifest({ date: DATE, groups: 100, perGroup: 4 });
		const repo = new JsonStoryRepository(join(root, "ledger"));
		let rejection: string | undefined;

		const earlySubmit: Script = async (api) => {
			const page = await api.call<{ items: Array<{ id: string; metadata: Record<string, unknown> }> }>(
				"list_unseen_items",
				{ limit: 50 },
			);
			const g = groupOf(page.items[0]!);
			seenGroups.set(g, [page.items[0]!.id]);
			await api.call("upsert_story", {
				storyId: storyIdFor(g),
				canonicalTitle: `Event ${g}`,
				sourceItemIds: [page.items[0]!.id],
				primarySourceIds: [page.items[0]!.id],
				status: "OPEN",
				changeType: "NEW",
				relevance: 0.5,
				novelty: 0.5,
				importance: 0.5,
				confidence: 0.6,
				reason: "grouped",
			});
			try {
				await submitAll(api.call as Call);
			} catch (err) {
				rejection = err instanceof Error ? err.message : String(err);
			}
		};

		await runOnce({ manifest, repo, maxDecisionsPerTurn: 150, script: earlySubmit }).catch(() => {});
		expect(rejection).toBeDefined();
		expect(rejection).toMatch(/unseen|coverage|decision/i);
	});
	it("counts progress against the manifest, not the day, when recovering", async () => {
		/*
		 * The 2026-09-16 recovery regression.
		 *
		 * A recovery run inherits the failed run's decisions and is handed a
		 * manifest of only what is left, so the day's decision count is LARGER than
		 * the manifest. The count used to come from the repository keyed by date,
		 * which made `decided` read 1150 against a `total` of 637: the work unit
		 * never yielded because `decidedAfter < totalItems` was false from the
		 * first turn, and the stall check concluded the scan was finished while
		 * items were still unseen. It looked correct on a fresh day, where the
		 * manifest is a superset of the day's decisions -- which is every other
		 * test here.
		 */
		const repo = new JsonStoryRepository(join(root, "ledger"));
		const full = makeManifest({ date: DATE, groups: 70, perGroup: 5 }); // 350 items

		// What the run being recovered already decided: the first 200, none of
		// which appear in the manifest this run is handed.
		const alreadyDecided = full.items.slice(0, 200);
		await repo.recordDecisions(
			DATE,
			alreadyDecided.map((i) => ({
				itemId: i.id,
				disposition: "IRRELEVANT" as const,
				reason: "decided by the run being recovered",
				decidedAt: `${DATE}T00:00:00.000Z`,
			})),
		);
		expect((await repo.processedItemIds(DATE)).size).toBe(200);

		// The recovery manifest: only what is left, and disjoint from the above.
		const remaining = { ...full, items: full.items.slice(200) }; // 150 items
		expect(remaining.items.length).toBe(150);

		const err = await runCuratorStage({
			date: DATE,
			manifest: remaining,
			repo,
			spec: MODEL_CHAIN[0]!,
			skillsRoot: SKILLS_ROOT,
			cwd: root,
			driverFactory: createFakeDriverFactory(pagingScript),
			mode: "RESUME",
			maxNudges: 0,
			maxDecisionsPerTurn: 100,
		}).catch((e: unknown) => e);

		// It must yield on the work unit, not conclude the scan is already done.
		expect(err).toBeInstanceOf(ProgressYieldError);
		const yielded = err as ProgressYieldError;
		expect(yielded.info.reason).toBe("WORK_UNIT_COMPLETE");
		expect(yielded.info.totalItems).toBe(150);
		// Manifest-scoped: the 200 inherited decisions are not progress on THIS
		// manifest, so decidedAfter can never exceed totalItems.
		expect(yielded.info.decidedBefore).toBe(0);
		expect(yielded.info.decidedAfter).toBeGreaterThanOrEqual(100);
		expect(yielded.info.decidedAfter).toBeLessThanOrEqual(150);
		// And the inherited decisions are untouched.
		expect((await repo.processedItemIds(DATE)).size).toBe(200 + yielded.info.decidedAfter);
	});
});
