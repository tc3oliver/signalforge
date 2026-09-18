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
	for (const [g, ids] of groups) {
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
			confidence: 0.5,
			reason: `Cluster ${g}`,
		});
	}
	await call("record_item_decisions", {
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
			for (const [g, ids] of groups) {
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
					confidence: 0.5,
					reason: `Cluster ${g}`,
				});
			}
			await call("record_item_decisions", {
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
