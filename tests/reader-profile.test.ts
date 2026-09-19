import { describe, expect, it } from "vitest";
import { InterestsConfig } from "../src/config/schema.ts";
import { DEFAULT_PERSONA, buildReaderProfile, renderReaderProfile } from "../src/profile/reader-profile.ts";
import { buildCuratorSystemPrompt } from "../src/curator/prompt.ts";
import { buildEditorSystemPrompt } from "../src/editor/prompt.ts";

/*
 * `config/interests.yaml` was loaded, validated and strictly typed from the
 * start, and for just as long its only production reader was the setup check,
 * which printed a topic count. The Curator scored relevance and the Editor chose
 * what led the brief against one sentence compiled into the prompt, while a
 * carefully weighted topic list sat in a file nothing consumed.
 *
 * The rule these tests exist to hold is the one in docs/INTELLIGENCE_BACKLOG:
 * weights are priors, not filters. A weight may reorder. It may never excuse an
 * item from being decided, turn "off-topic" into IRRELEVANT, or drop an
 * important story no topic happens to name.
 */

function interests(raw: unknown) {
	return InterestsConfig.parse(raw);
}

const TWO_TOPICS = interests({
	topics: [
		{ id: "inference", label: "Inference", weight: 0.85, keywords: ["vllm", "kv-cache"] },
		{ id: "ai-llm", label: "AI / LLM", weight: 1.0, keywords: ["llm"] },
	],
});

describe("buildReaderProfile", () => {
	it("orders topics by weight so the block leads with what matters most", () => {
		expect(buildReaderProfile(TWO_TOPICS).topics.map((t) => t.id)).toEqual(["ai-llm", "inference"]);
	});

	it("keeps the old hardcoded reader when the profile declines to describe one", () => {
		// The Editor has always had a reader. A profile with no persona must not
		// leave it with none.
		expect(buildReaderProfile(TWO_TOPICS).persona).toBe(DEFAULT_PERSONA);
	});

	it("uses a declared persona over the default", () => {
		const withPersona = interests({ ...TWO_TOPICS, persona: "a hardware reliability engineer" });
		expect(buildReaderProfile(withPersona).persona).toBe("a hardware reliability engineer");
	});

	it("gives the same profile the same version, and a changed one a different version", () => {
		// The version is what lets a brief record which profile shaped it, so it
		// has to be stable against reordering and sensitive to actual edits.
		const reordered = interests({ topics: [...TWO_TOPICS.topics].reverse() });
		expect(buildReaderProfile(reordered).version).toBe(buildReaderProfile(TWO_TOPICS).version);

		const reweighted = interests({
			topics: TWO_TOPICS.topics.map((t) => (t.id === "inference" ? { ...t, weight: 0.2 } : t)),
		});
		expect(buildReaderProfile(reweighted).version).not.toBe(buildReaderProfile(TWO_TOPICS).version);
	});
});

describe("the rendered block", () => {
	const block = renderReaderProfile(buildReaderProfile(TWO_TOPICS));

	it("names every topic and its weight", () => {
		expect(block).toContain("AI / LLM (1.00)");
		expect(block).toContain("Inference (0.85)");
	});

	/*
	 * The id is what a story's `topicIds` takes. Rendering only the label
	 * left the model guessing, and on 2026-09-19 it guessed wrong 119 times in
	 * one production run.
	 */
	it("leads each topic with the id the tools take, and says so", () => {
		expect(block).toContain("`ai-llm` — AI / LLM (1.00)");
		expect(block).toContain("`inference` — Inference (0.85)");
		expect(block).toMatch(/ids not listed here are not stored/);
	});

	it("says in so many words that weights are priors and not filters", () => {
		expect(block).toContain("priors, not filters");
		expect(block).toMatch(/never justify/i);
		expect(block).toMatch(/skipping an item's decision/i);
		expect(block).toMatch(/off-topic is a low\s*\n?relevance score, not a disposition/i);
	});

	it("tells the model an important story off-profile is still worth reporting", () => {
		// The failure this guards: a model that reads a weighted list as a
		// whitelist and starves a serious outage because no topic named it.
		expect(block).toMatch(/whether or not it matches a topic above/i);
	});

	it("stays short enough to pay for on every turn", () => {
		const bigger = interests({
			topics: Array.from({ length: 40 }, (_, i) => ({
				id: `t${i}`,
				label: `Topic ${i}`,
				weight: i / 40,
				keywords: ["a", "b", "c", "d", "e", "f", "g"],
			})),
		});
		const rendered = renderReaderProfile(buildReaderProfile(bigger));
		expect(rendered.split("\n").length).toBeLessThanOrEqual(45);
		expect(rendered).toContain("lower-weighted topic(s)");
	});
});

describe("both system prompts carry the profile", () => {
	const profile = buildReaderProfile(TWO_TOPICS);
	const rendered = renderReaderProfile(profile);

	it("reaches the curator", () => {
		const prompt = buildCuratorSystemPrompt({
			date: "2026-09-15",
			totalItems: 10,
			skillSection: "SKILL",
			readerProfile: rendered,
		});
		expect(prompt).toContain("AI / LLM (1.00)");
		expect(prompt).toContain("priors, not filters");
	});

	it("reaches the editor, and replaces the reader it used to hardcode", () => {
		const withPersona = buildReaderProfile(
			interests({ ...TWO_TOPICS, persona: "a hardware reliability engineer" }),
		);
		const prompt = buildEditorSystemPrompt({
			date: "2026-09-15",
			materialCount: 12,
			tierACount: 4,
			skillSection: "SKILL",
			hasPreviousBrief: false,
			readerProfile: renderReaderProfile(withPersona),
			persona: withPersona.persona,
		});
		expect(prompt).toContain("a hardware reliability engineer");
		expect(prompt).not.toContain("a technically sophisticated engineer");
		expect(prompt).toContain("priors, not filters");
	});

	it("leaves a prompt with no profile exactly as it was", () => {
		// A run without config gets the prompt it always got, rather than a block
		// asserting the reader cares about nothing.
		const prompt = buildCuratorSystemPrompt({ date: "2026-09-15", totalItems: 10, skillSection: "SKILL" });
		expect(prompt).not.toContain("Who this is for");
		expect(prompt).toContain("SKILL");

		const editor = buildEditorSystemPrompt({
			date: "2026-09-15",
			materialCount: 12,
			tierACount: 4,
			skillSection: "SKILL",
			hasPreviousBrief: false,
		});
		expect(editor).not.toContain("Who this is for");
		expect(editor).toContain("a technically sophisticated engineer");
	});

	it("still states the scan-coverage obligation when every weight is zero", () => {
		// The acceptance criterion: a profile that cares about nothing must not
		// weaken the one guarantee the whole system rests on.
		const zeroed = buildReaderProfile(
			interests({ topics: TWO_TOPICS.topics.map((t) => ({ ...t, weight: 0 })) }),
		);
		const prompt = buildCuratorSystemPrompt({
			date: "2026-09-15",
			totalItems: 590,
			skillSection: "SKILL",
			readerProfile: renderReaderProfile(zeroed),
		});
		expect(prompt).toContain("Every one of the 590 items offered to you must have a recorded decision");
		expect(prompt).toContain("priors, not filters");
	});
});

/*
 * Parts of the same design that live outside the prompt: the prior has to be
 * recorded, or "weights are priors, not filters" is a claim nothing can check
 * after the fact. A story ranked highly looks identical whether the model
 * applied the profile or ignored it.
 */
describe("the prior is recorded, not just applied", () => {
	it("drops a topic id the reader never declared, and keeps the story", async () => {
		const { createCuratorTools } = await import("../src/curator/tools.ts");
		const { JsonStoryRepository } = await import("../src/stories/json-repository.ts");
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");

		const root = mkdtempSync(join(tmpdir(), "reader-profile-"));
		try {
			const manifest = {
				date: "2026-09-15",
				generatedAt: "2026-09-15T00:00:00.000Z",
				items: [
					{
						id: "i1",
						sourceType: "rss" as const,
						trust: "UNTRUSTED_EXTERNAL_CONTENT" as const,
						sourceName: "feed",
						title: "t",
						summary: "",
						publishedAt: "2026-09-15T00:00:00.000Z",
						metadata: {},
					},
				],
				facts: [],
			};
			const tools = createCuratorTools({
				date: "2026-09-15",
				manifest,
				repo: new JsonStoryRepository(root),
				now: () => new Date("2026-09-15T01:00:00.000Z"),
				topicIds: new Set(["ai-llm", "inference"]),
			});
			const commit = tools.find((t) => t.name === "commit_curation_batch")!;
			const execute = (id: string, story: unknown) =>
				(commit.execute as unknown as (i: string, p: unknown) => Promise<unknown>)(id, { stories: [story] });
			const story = {
				storyId: "s1",
				canonicalTitle: "A story",
				sourceItemIds: ["i1"],
				primarySourceIds: ["i1"],
				status: "OPEN",
				changeType: "NEW",
				relevance: 0.9,
				novelty: 0.9,
				importance: 0.9,
				confidence: 0.9,
				reason: "because",
			};

			/*
			 * An unknown id is dropped, not fatal: the story is stored without it
			 * and the model is told which id went. Refusing the whole entry cost
			 * a full model turn to remove one string, and on 2026-09-19 that was
			 * 119 refusals in a single production run.
			 */
			const normalized = (await execute("1", {
				...story,
				topicIds: ["quantum-basketball", "inference"],
			})) as { content: Array<{ text: string }> };
			const payload = JSON.parse(normalized.content[0]!.text) as {
				stories: { accepted: Array<{ note?: string }> };
			};
			expect(payload.stories.accepted[0]?.note).toMatch(
				/Dropped topic id\(s\) not in the reader profile: quantum-basketball/,
			);
			const stored = await new JsonStoryRepository(root).getStory("s1");
			expect(stored?.topicIds).toEqual(["inference"]);
			// A declared topic is accepted, and so is none at all -- an important
			// story that matches nothing the reader listed still belongs in the
			// ledger, and that has to be expressible.
			await expect(execute("2", { ...story, topicIds: ["inference"] })).resolves.toBeDefined();
			await expect(execute("3", { ...story, topicIds: [] })).resolves.toBeDefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts any topic id when the run has no profile at all", async () => {
		// A run without config behaves as it always did rather than refusing work.
		const { createCuratorTools } = await import("../src/curator/tools.ts");
		const { JsonStoryRepository } = await import("../src/stories/json-repository.ts");
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");

		const root = mkdtempSync(join(tmpdir(), "reader-profile-"));
		try {
			const tools = createCuratorTools({
				date: "2026-09-15",
				manifest: {
					date: "2026-09-15",
					generatedAt: "2026-09-15T00:00:00.000Z",
					items: [
						{
							id: "i1",
							sourceType: "rss" as const,
							trust: "UNTRUSTED_EXTERNAL_CONTENT" as const,
							sourceName: "feed",
							title: "t",
							summary: "",
							publishedAt: "2026-09-15T00:00:00.000Z",
							metadata: {},
						},
					],
					facts: [],
				},
				repo: new JsonStoryRepository(root),
				now: () => new Date("2026-09-15T01:00:00.000Z"),
			});
			const commit = tools.find((t) => t.name === "commit_curation_batch")!;
			const execute = (id: string, story: unknown) =>
				(commit.execute as unknown as (i: string, p: unknown) => Promise<unknown>)(id, { stories: [story] });
			await expect(
				execute("1", {
					storyId: "s1",
					canonicalTitle: "A story",
					sourceItemIds: ["i1"],
					primarySourceIds: ["i1"],
					status: "OPEN",
					changeType: "NEW",
					relevance: 0.9,
					novelty: 0.9,
					importance: 0.9,
					confidence: 0.9,
					reason: "because",
					topicIds: ["anything"],
				}),
			).resolves.toBeDefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
