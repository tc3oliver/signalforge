import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCuratorStage } from "../../src/curator/session.ts";
import { InvalidAgentOutputError } from "../../src/runtime/error-classifier.ts";
import { MODEL_CHAIN } from "../../src/runtime/model-config.ts";
import { JsonStoryRepository } from "../../src/stories/json-repository.ts";
import {
	REPO_ROOT,
	competentCuratorScript,
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
	root = mkdtempSync(join(tmpdir(), "di-integ-resume-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("partial curator run then resume", () => {
	it("carries durable state, not conversation state, into a second session", async () => {
		const manifest = makeManifest({ date: DATE, groups: 10, perGroup: 2 });
		const ledgerDir = join(root, "ledger");
		const spec = MODEL_CHAIN[0]!;

		let submitRejection: unknown;

		// --- Run A: decide half the items, then discover submit is refused ------
		const halfScript: Script = async ({ call }) => {
			const page = await call<{ items: Array<{ id: string; metadata: Record<string, unknown> }> }>(
				"list_unseen_items",
				{ limit: 10 },
			);
			const half = page.items.slice(0, 10);
			const groups = new Map<string, string[]>();
			for (const item of half) {
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
				decisions: half.map((item) => ({
					itemId: item.id,
					disposition: "CANDIDATE",
					storyId: storyIdFor(groupOf(item)),
					reason: "half-run decision",
				})),
			});

			submitRejection = await call("submit_materials", {
				stories: [...groups.entries()].map(([g, ids]) => ({
					storyId: storyIdFor(g),
					tier: "A",
					canonicalTitle: `Event ${g}`,
					whySelected: "premature",
					changeType: "NEW",
					importance: 0.5,
					novelty: 0.5,
					confidence: 0.5,
					sourceItemIds: ids,
					primarySourceIds: [ids[0]],
				})),
			}).then(
				() => new Error("submit_materials unexpectedly succeeded"),
				(err) => err,
			);
		};

		const repoA = new JsonStoryRepository(ledgerDir);
		await expect(
			runCuratorStage({
				date: DATE,
				manifest,
				repo: repoA,
				spec,
				skillsRoot: SKILLS_ROOT,
				cwd: root,
				driverFactory: createFakeDriverFactory([halfScript]),
				mode: "FRESH",
				maxNudges: 0,
			}),
		).rejects.toThrow(InvalidAgentOutputError);

		expect(submitRejection).toBeInstanceOf(Error);
		expect((submitRejection as Error).message).toMatch(/Scan coverage incomplete: 10 of 20/);
		expect((submitRejection as Error).message).toMatch(/Nothing was saved/);

		// --- Run B: a brand new repository instance reads the same directory ----
		const pagesSeen: string[][] = [];
		const repoB = new JsonStoryRepository(ledgerDir);
		expect((await repoB.listDecisions(DATE)).length).toBe(10);

		const result = await runCuratorStage({
			date: DATE,
			manifest,
			repo: repoB,
			spec,
			skillsRoot: SKILLS_ROOT,
			cwd: root,
			driverFactory: createFakeDriverFactory([
				competentCuratorScript({ onPage: (ids) => pagesSeen.push(ids) }),
			]),
			mode: "RESUME",
			maxNudges: 2,
		});

		// The resumed session was only ever shown the undecided remainder.
		expect(pagesSeen[0]).toHaveLength(10);
		expect(pagesSeen[0]).toEqual(manifest.items.slice(10).map((i) => i.id));

		// Run A's decisions survived, and the day is now fully covered.
		const decisions = await repoB.listDecisions(DATE);
		expect(decisions).toHaveLength(20);
		expect(decisions.filter((d) => d.reason === "half-run decision")).toHaveLength(10);
		expect((await repoB.processedItemIds(DATE)).size).toBe(20);

		// Stories from both runs coexist in the ledger.
		const stories = await repoB.listStories(DATE);
		expect(stories.map((s) => s.storyId).sort()).toEqual(
			Array.from({ length: 10 }, (_, i) => storyIdFor(`g${String(i + 1).padStart(2, "0")}`)).sort(),
		);

		// And the accepted materials came out of the resumed session.
		expect(result.materials.stories).toHaveLength(5);
		expect(result.materials.date).toBe(DATE);
	});
});
