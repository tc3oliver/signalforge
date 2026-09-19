import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCuratorTools, type CuratorContext } from "../../src/curator/tools.ts";
import { runCuratorStage } from "../../src/curator/session.ts";
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

const DATE = "2026-09-13";
const SKILLS_ROOT = join(REPO_ROOT, "agent", "skills");

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "di-integ-curator-reject-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Drive the real curator tools directly, without a session, for tool-level assertions. */
async function withTools(
	manifest: ReturnType<typeof makeManifest>,
	fn: (
		call: (name: string, args?: unknown) => Promise<any>,
		ctx: CuratorContext,
		repo: JsonStoryRepository,
	) => Promise<void>,
): Promise<void> {
	const repo = new JsonStoryRepository(join(root, "ledger"));
	const ctx: CuratorContext = { date: DATE, manifest, repo, now: () => new Date("2026-09-13T12:00:00Z") };
	const tools = createCuratorTools(ctx);
	const byName = new Map(tools.map((t) => [t.name, t]));
	let seq = 0;
	const call = async (name: string, args: unknown = {}) => {
		const tool = byName.get(name);
		if (!tool) throw new Error(`no tool ${name}`);
		seq += 1;
		const result = await tool.execute(`call-${seq}`, args as never, undefined, undefined, {} as never);
		const text = (result.content[0] as { text?: string } | undefined)?.text ?? "";
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	};
	await fn(call, ctx, repo);
}

/** Decide every item, clustering by group, so only the submit payload is at fault. */
async function curateFully(
	call: (name: string, args?: unknown) => Promise<any>,
	manifest: ReturnType<typeof makeManifest>,
): Promise<Map<string, string[]>> {
	const groups = new Map<string, string[]>();
	for (const item of manifest.items) {
		const g = groupOf(item);
		groups.set(g, [...(groups.get(g) ?? []), item.id]);
	}
	await call("commit_curation_batch", {
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
			confidence: 0.5,
			reason: `Cluster ${g}`,
		})),
		decisions: manifest.items.map((item) => ({
			itemId: item.id,
			disposition: "CANDIDATE",
			storyId: storyIdFor(groupOf(item)),
			reason: "decided",
		})),
	});
	return groups;
}

function materialStory(storyId: string, ids: string[]): Record<string, unknown> {
	return {
		storyId,
		tier: "A",
		canonicalTitle: storyId,
		whySelected: "because",
		changeType: "NEW",
		importance: 0.5,
		novelty: 0.5,
		confidence: 0.5,
		sourceItemIds: ids,
		primarySourceIds: [ids[0]],
	};
}

describe("submit_materials rejections", () => {
	it("rejects unknown sourceItemIds and persists nothing", async () => {
		const manifest = makeManifest({ date: DATE, groups: 4, perGroup: 2 });
		await withTools(manifest, async (call, ctx) => {
			const groups = await curateFully(call, manifest);
			const [g, ids] = [...groups.entries()][0]!;
			await expect(
				call("submit_materials", {
					stories: [materialStory(storyIdFor(g), [...ids, "itm-does-not-exist"])],
				}),
			).rejects.toThrow(/Unknown sourceItemIds .*itm-does-not-exist/s);
			expect(ctx.submitted).toBeUndefined();
		});
	});

	it("rejects a storyId that was never upserted", async () => {
		const manifest = makeManifest({ date: DATE, groups: 4, perGroup: 2 });
		await withTools(manifest, async (call, ctx) => {
			const groups = await curateFully(call, manifest);
			const ids = [...groups.values()][0]!;
			await expect(
				call("submit_materials", { stories: [materialStory("story-never-created", ids)] }),
			).rejects.toThrow(/Unknown storyId in story "story-never-created".*story ledger/s);
			expect(ctx.submitted).toBeUndefined();
		});
	});

	it("rejects primarySourceIds that are not a subset of sourceItemIds", async () => {
		const manifest = makeManifest({ date: DATE, groups: 4, perGroup: 2 });
		await withTools(manifest, async (call, ctx) => {
			const groups = await curateFully(call, manifest);
			const entries = [...groups.entries()];
			const [g, ids] = entries[0]!;
			const strayId = entries[1]![1][0]!;
			await expect(
				call("submit_materials", {
					stories: [{ ...materialStory(storyIdFor(g), ids), primarySourceIds: [strayId] }],
				}),
			).rejects.toThrow(new RegExp(`primarySourceIds not listed in sourceItemIds.*${strayId}`, "s"));
			expect(ctx.submitted).toBeUndefined();
		});
	});

	it("rejects an unknown factRef", async () => {
		const manifest = makeManifest({ date: DATE, groups: 4, perGroup: 2, facts: 2 });
		await withTools(manifest, async (call, ctx) => {
			const groups = await curateFully(call, manifest);
			const [g, ids] = [...groups.entries()][0]!;
			await expect(
				call("submit_materials", {
					stories: [{ ...materialStory(storyIdFor(g), ids), factRefs: ["fct-invented-001"] }],
				}),
			).rejects.toThrow(/Unknown factRefs .*fct-invented-001/s);
			expect(ctx.submitted).toBeUndefined();
		});
	});

	it("names the coverage gap when one item is still undecided", async () => {
		const manifest = makeManifest({ date: DATE, groups: 5, perGroup: 2 });
		const repo = new JsonStoryRepository(join(root, "ledger"));
		let rejection: unknown;

		const script: Script = async ({ call }) => {
			const page = await call<{ items: Array<{ id: string; metadata: Record<string, unknown> }> }>(
				"list_unseen_items",
				{},
			);
			const allButOne = page.items.slice(0, page.items.length - 1);
			const groups = new Map<string, string[]>();
			for (const item of allButOne) {
				const g = groupOf(item);
				groups.set(g, [...(groups.get(g) ?? []), item.id]);
			}
			await call("commit_curation_batch", {
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
					confidence: 0.5,
					reason: `Cluster ${g}`,
				})),
				decisions: allButOne.map((item) => ({
					itemId: item.id,
					disposition: "CANDIDATE",
					storyId: storyIdFor(groupOf(item)),
					reason: "decided",
				})),
			});
			rejection = await call("submit_materials", {
				stories: [...groups.entries()].map(([g, ids]) => materialStory(storyIdFor(g), ids)),
			}).then(
				() => new Error("submit_materials unexpectedly succeeded"),
				(err) => err,
			);
		};

		// The stage only throws this when ctx.submitted was never set, so the message
		// is the observable proof that the rejected submit persisted nothing.
		await expect(
			runCuratorStage({
				date: DATE,
				manifest,
				repo,
				spec: MODEL_CHAIN[0]!,
				skillsRoot: SKILLS_ROOT,
				cwd: root,
				driverFactory: createFakeDriverFactory([script]),
				mode: "FRESH",
				maxNudges: 0,
			}),
		).rejects.toThrow(/did not produce accepted materials after 0 nudges \(9\/10 items decided/);

		expect((rejection as Error).message).toMatch(
			/Scan coverage incomplete: 9 of 10 offered items decided, 1 still unseen/,
		);
		// Nothing was accepted: the decisions are all that survived.
		expect((await repo.processedItemIds(DATE)).size).toBe(9);
	});
});

describe("upsert rejection telemetry", () => {
	it("records a refused story's rejection family on the commit that carried it", async () => {
		const manifest = makeManifest({ groups: 1, perGroup: 1, date: DATE });
		const repo = new JsonStoryRepository(join(root, "ledger"));
		const calls: Array<{ name: string; summary: Record<string, unknown> }> = [];
		const ctx: CuratorContext = {
			date: DATE,
			manifest,
			repo,
			now: () => new Date("2026-09-13T12:00:00Z"),
			onToolCall: (name, summary) => calls.push({ name, summary }),
		};
		const commit = createCuratorTools(ctx).find((t) => t.name === "commit_curation_batch")!;
		const id = manifest.items[0]!.id;
		const result = (await commit.execute(
			"call-1",
			{
				stories: [
					{
						storyId: "no-history-story",
						canonicalTitle: "A story with no earlier entry",
						sourceItemIds: [id],
						primarySourceIds: [id],
						status: "OPEN",
						changeType: "UPDATE",
						relevance: 0.5,
						novelty: 0.5,
						importance: 0.5,
						confidence: 0.5,
						reason: "continues something",
					},
				],
				decisions: [{ itemId: id, disposition: "IRRELEVANT", reason: "noise" }],
			} as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: Array<{ text: string }> };
		const body = JSON.parse(result.content[0]!.text) as {
			stories: { accepted: unknown[]; rejected?: Array<{ error: string }> };
		};
		expect(body.stories.rejected?.[0]?.error).toMatch(/no earlier ledger entry/);
		// The page's sound half still landed: one bad story is not a lost batch.
		expect(calls.at(-1)?.name).toBe("commit_curation_batch");
		expect(calls.at(-1)?.summary).toMatchObject({
			rejectedStories: 1,
			rejectedBy: { CHANGE_TYPE_WITHOUT_HISTORY: 1 },
			recorded: 1,
		});
	});
});

describe("unknown topic ids are normalized, not refused", () => {
	/*
	 * The expensive failure this prevents: a batch of a dozen fully-formed
	 * stories refused in its entirety because one string was not in the reader
	 * profile, costing a whole model turn of re-sent context to resend the same
	 * judgements with that string removed.
	 */
	async function toolsWithProfile(onToolCall: (n: string, s: Record<string, unknown>) => void) {
		const manifest = makeManifest({ date: DATE, groups: 2, perGroup: 2 });
		const repo = new JsonStoryRepository(join(root, "ledger"));
		const ctx: CuratorContext = {
			date: DATE,
			manifest,
			repo,
			now: () => new Date("2026-09-13T12:00:00Z"),
			topicIds: new Set(["ai-llm", "inference"]),
			onToolCall,
		};
		return { tools: createCuratorTools(ctx), manifest, repo };
	}

	function payload(manifest: ReturnType<typeof makeManifest>, storyId: string, topicIds: string[]) {
		const id = manifest.items[0]!.id;
		return {
			storyId,
			canonicalTitle: `Story ${storyId}`,
			sourceItemIds: [id],
			primarySourceIds: [id],
			status: "OPEN",
			changeType: "NEW",
			relevance: 0.5,
			novelty: 0.5,
			importance: 0.5,
			confidence: 0.5,
			reason: "because",
			topicIds,
		};
	}

	it("accepts a whole batch whose only defect is an unknown topic id, and records what it dropped", async () => {
		const calls: Array<{ name: string; summary: Record<string, unknown> }> = [];
		const { tools, manifest, repo } = await toolsWithProfile((name, summary) => calls.push({ name, summary }));
		const batch = tools.find((t) => t.name === "commit_curation_batch")!;
		const result = (await batch.execute(
			"c",
			{
				stories: [
					payload(manifest, "a", ["quantum-basketball", "inference"]),
					payload(manifest, "b", ["also-not-real"]),
				],
			} as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: Array<{ text: string }> };
		const body = JSON.parse(result.content[0]!.text) as {
			stories: { accepted: Array<{ storyId: string; note?: string }>; rejected?: unknown[] };
		};
		expect(body.stories.accepted.map((a) => a.storyId)).toEqual(["a", "b"]);
		expect(body.stories.rejected).toBeUndefined();
		expect(body.stories.accepted[0]!.note).toMatch(/Dropped topic id\(s\).*quantum-basketball/);

		// Only the real id is stored; nothing is invented or remapped.
		expect((await repo.getStory("a"))?.topicIds).toEqual(["inference"]);
		expect((await repo.getStory("b"))?.topicIds).toEqual([]);

		// And the drop stays visible in the trace, on the batch that is the tool
		// call. It used to be emitted once per entry, which made a batch of twenty
		// read as twenty `upsert_story` calls and produced a false reading of the
		// 2026-09-18 trace; the aggregate is the same signal against the truth.
		const batchNote = calls.find((c) => c.name === "commit_curation_batch")!;
		expect(batchNote.summary).toMatchObject({
			accepted: 2,
			rejectedStories: 0,
			droppedTopicIds: [["quantum-basketball"], ["also-not-real"]],
		});
		expect(calls.filter((c) => c.name === "upsert_story")).toEqual([]);
	});

	it("still refuses a source item that does not exist", async () => {
		const { tools, manifest } = await toolsWithProfile(() => {});
		const commit = tools.find((t) => t.name === "commit_curation_batch")!;
		// A story may not cite an item that does not exist, and a commit that
		// recorded nothing at all is refused outright rather than returned as a
		// success with an empty receipt.
		await expect(
			commit.execute(
				"c",
				{
					stories: [
						{ ...payload(manifest, "c", ["inference"]), sourceItemIds: ["no-such-item"], primarySourceIds: ["no-such-item"] },
					],
				} as never,
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow(/not in today's manifest/);
	});
});
