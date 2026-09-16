import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { attributeMiss, type StageHits, summarise } from "../src/observation/attribution.ts";
import {
	AuditGroupsConfig,
	buildTopicIndex,
	classifyStory,
	loadAuditGroups,
	tallyAudit,
	UNCLASSIFIED,
} from "../src/observation/audit.ts";
import { assessContinuity, continuityForDay, daySpan } from "../src/observation/continuity.ts";
import {
	type BriefEpochRow,
	checkAggregation,
	currentEpoch,
	deriveEpochs,
	PRE_PERSONALIZATION_EPOCH,
} from "../src/observation/epoch.ts";
import { buildTopicFunnel, type FunnelStoryInput } from "../src/observation/funnel.ts";

/*
 * The observation layer is pure apart from its queries, so all of this runs
 * without a database. That is deliberate: a measurement tool whose own tests
 * only run when Postgres happens to be up is a tool whose logic quietly stops
 * being checked.
 */

const brief = (date: string, profileVersion: string | null): BriefEpochRow => ({
	date,
	runId: `run-${date}`,
	profileVersion,
});

describe("epochs", () => {
	it("puts every pre-personalization day in one epoch", () => {
		const epochs = deriveEpochs([brief("2026-09-13", null), brief("2026-09-14", null)]);
		expect(epochs).toHaveLength(1);
		expect(epochs[0]?.id).toBe(PRE_PERSONALIZATION_EPOCH);
		expect(epochs[0]?.days).toBe(2);
	});

	it("starts a new epoch at the first day carrying a profile version", () => {
		const epochs = deriveEpochs([
			brief("2026-09-13", null),
			brief("2026-09-14", null),
			brief("2026-09-15", "abc123abc123"),
		]);
		expect(epochs.map((e) => e.id)).toEqual([PRE_PERSONALIZATION_EPOCH, "profile-abc123abc123"]);
		expect(epochs[1]?.startedAt).toBe("2026-09-15");
	});

	it("splits again when the profile is edited", () => {
		const epochs = deriveEpochs([brief("2026-09-15", "aaa"), brief("2026-09-16", "bbb")]);
		expect(epochs).toHaveLength(2);
	});

	it("refuses to aggregate days that span epochs", () => {
		const check = checkAggregation([brief("2026-09-14", null), brief("2026-09-15", "abc")]);
		expect(check.ok).toBe(false);
		expect(check.refusal).toContain("2 intelligence epochs");
		expect(check.refusal).toContain("not one baseline");
	});

	it("allows aggregation inside one epoch", () => {
		const check = checkAggregation([brief("2026-09-15", "abc"), brief("2026-09-16", "abc")]);
		expect(check.ok).toBe(true);
		expect(check.refusal).toBeUndefined();
	});

	it("treats a re-published older day as the same epoch, not a third one", () => {
		// A backfill re-runs 09-14 under the new profile. Ordering by date would
		// interleave it; grouping by version keeps the two epochs intact.
		const epochs = deriveEpochs([brief("2026-09-13", null), brief("2026-09-14", "abc"), brief("2026-09-15", "abc")]);
		expect(epochs).toHaveLength(2);
		expect(epochs[1]?.days).toBe(2);
	});

	it("names the newest epoch as the current one", () => {
		const epochs = deriveEpochs([brief("2026-09-13", null), brief("2026-09-16", "abc")]);
		expect(currentEpoch(epochs)?.id).toBe("profile-abc");
	});
});

describe("topic funnel", () => {
	const topics = [
		{ id: "ai-llm", label: "AI / LLM", weight: 1 },
		{ id: "btc", label: "BTC", weight: 0.7 },
	];
	const story = (over: Partial<FunnelStoryInput> & { storyId: string }): FunnelStoryInput => ({
		topicIds: [],
		isMaterial: false,
		isFinal: false,
		isMustKnow: false,
		...over,
	});

	it("counts each stage a story reached", () => {
		const funnel = buildTopicFunnel(
			[story({ storyId: "s1", topicIds: ["ai-llm"], isMaterial: true, isFinal: true, isMustKnow: true })],
			topics,
		);
		const row = funnel.rows.find((r) => r.topicId === "ai-llm");
		expect(row).toMatchObject({ candidateStories: 1, materialStories: 1, finalStories: 1, mustKnowStories: 1 });
	});

	it("shows a topic that produces candidates but never reaches the brief", () => {
		const funnel = buildTopicFunnel([story({ storyId: "s1", topicIds: ["btc"], isMaterial: true })], topics);
		const row = funnel.rows.find((r) => r.topicId === "btc");
		expect(row).toMatchObject({ candidateStories: 1, materialStories: 1, finalStories: 0 });
	});

	it("counts a multi-topic story towards every topic it carries", () => {
		const funnel = buildTopicFunnel([story({ storyId: "s1", topicIds: ["ai-llm", "btc"], isFinal: true })], topics);
		expect(funnel.rows.find((r) => r.topicId === "ai-llm")?.finalStories).toBe(1);
		expect(funnel.rows.find((r) => r.topicId === "btc")?.finalStories).toBe(1);
		expect(funnel.totalCandidates).toBe(1);
	});

	it("counts untagged stories rather than dropping them", () => {
		const funnel = buildTopicFunnel([story({ storyId: "s1" }), story({ storyId: "s2", topicIds: ["btc"] })], topics);
		expect(funnel.untagged).toBe(1);
		expect(funnel.totalCandidates).toBe(2);
	});

	it("keeps a topic the profile no longer lists, and says so", () => {
		const funnel = buildTopicFunnel([story({ storyId: "s1", topicIds: ["retired-topic"] })], topics);
		const row = funnel.rows.find((r) => r.topicId === "retired-topic");
		expect(row?.candidateStories).toBe(1);
		expect(row?.label).toContain("not in the current profile");
	});

	it("declares the raw stage unavailable instead of estimating it", () => {
		const funnel = buildTopicFunnel([], topics);
		expect(funnel.unavailableStages.join(" ")).toContain("raw");
	});
});

describe("audit grouping", () => {
	const config = AuditGroupsConfig.parse({
		groups: [
			{ id: "AI_ENGINEERING", label: "Eng", topicIds: ["vllm", "mcp"] },
			{ id: "AI_BUSINESS", label: "Business", topicIds: ["funding"] },
		],
	});
	const index = buildTopicIndex(config);

	it("classifies a story whose topics all sit in one group", () => {
		expect(classifyStory(["vllm", "mcp"], index)).toBe("AI_ENGINEERING");
	});

	it("refuses to pick a winner when topics span groups", () => {
		expect(classifyStory(["vllm", "funding"], index)).toBe(UNCLASSIFIED);
	});

	it("treats a story with no topics as unclassified", () => {
		expect(classifyStory([], index)).toBe(UNCLASSIFIED);
	});

	it("treats an unmapped topic as unclassified rather than guessing", () => {
		expect(classifyStory(["macro"], index)).toBe(UNCLASSIFIED);
	});

	it("counts only what reached the brief", () => {
		const tallies = tallyAudit(
			[
				{ storyId: "s1", topicIds: ["vllm"], inBrief: true, mustKnow: true },
				{ storyId: "s2", topicIds: ["vllm"], inBrief: false, mustKnow: false },
			],
			config,
		);
		const eng = tallies.find((t) => t.bucket === "AI_ENGINEERING");
		expect(eng).toMatchObject({ stories: 1, mustKnow: 1 });
	});

	it("always reports every bucket, including the empty ones", () => {
		const tallies = tallyAudit([], config);
		expect(tallies.map((t) => t.bucket)).toEqual(["AI_ENGINEERING", "AI_BUSINESS", UNCLASSIFIED]);
	});

	it("rejects a typo'd key instead of ignoring it", () => {
		expect(() =>
			AuditGroupsConfig.parse({ groups: [{ id: "AI_ENGINEERING", label: "Eng", topicIDs: ["vllm"] }] }),
		).toThrow();
	});

	it("loads the shipped config and maps every topic id to a known group", () => {
		const shipped = loadAuditGroups();
		expect(shipped.groups.length).toBeGreaterThan(0);
		for (const group of shipped.groups) {
			for (const topicId of group.topicIds) {
				expect(buildTopicIndex(shipped).get(topicId)).toBe(group.id);
			}
		}
	});

	it("maps no topic id into two groups at once", () => {
		const shipped = loadAuditGroups();
		const seen = new Set<string>();
		for (const group of shipped.groups) {
			for (const topicId of group.topicIds) {
				expect(seen.has(topicId), `${topicId} is in more than one audit group`).toBe(false);
				seen.add(topicId);
			}
		}
	});
});

describe("continuity", () => {
	it("computes the non-NEW rate", () => {
		const day = continuityForDay("2026-09-15", [
			{ changeType: "NEW", count: 9 },
			{ changeType: "UPDATE", count: 12 },
			{ changeType: "ESCALATION", count: 1 },
		]);
		expect(day.total).toBe(22);
		expect(day.nonNewCount).toBe(13);
		expect(day.nonNewRate).toBeCloseTo(13 / 22);
	});

	it("reports no rate for a day with no stories, rather than zero", () => {
		expect(continuityForDay("2026-09-15", []).nonNewRate).toBeNull();
	});

	it("flags a stretch where everything is NEW", () => {
		const days = ["2026-09-13", "2026-09-14"].map((d) => continuityForDay(d, [{ changeType: "NEW", count: 10 }]));
		const verdict = assessContinuity(days);
		expect(verdict.looksLikeNoMemory).toBe(true);
		expect(verdict.message).toContain("history invariant");
	});

	it("does not flag a stretch where stories are connected", () => {
		const days = [
			continuityForDay("2026-09-14", [
				{ changeType: "NEW", count: 5 },
				{ changeType: "UPDATE", count: 5 },
			]),
		];
		expect(assessContinuity(days).looksLikeNoMemory).toBe(false);
	});

	it("says nothing when there is nothing to say", () => {
		expect(assessContinuity([]).daysMeasured).toBe(0);
	});

	it("counts a signal seen once as spanning one day", () => {
		expect(daySpan("2026-09-14T10:00:00Z", "2026-09-14T22:00:00Z")).toBe(1);
	});

	it("counts calendar span across days", () => {
		expect(daySpan("2026-09-13T10:00:00Z", "2026-09-15T11:00:00Z")).toBe(3);
	});
});

describe("missing-story attribution", () => {
	const empty: StageHits = { items: [], decisions: [], candidates: [], materials: [], finals: [] };
	const item = { itemId: "i1", sourceName: "Decrypt", title: "t", publishedAt: null };
	const decision = { itemId: "i1", disposition: "IRRELEVANT", storyId: null, reason: "r" };
	const candidate = { storyId: "s1", canonicalTitle: "t", relevance: 0.4, reason: "r" };
	const material = { storyId: "s1", tier: "PRIMARY", canonicalTitle: "t" };
	const final = { storyId: "s1", section: "AI", mustKnow: false, title: "t" };

	it("blames the data plane when nothing was collected", () => {
		expect(attributeMiss(empty).verdict).toBe("SOURCE_MISS");
	});

	it("blames the curator when the item was scanned but promoted nothing", () => {
		expect(attributeMiss({ ...empty, items: [item], decisions: [decision] }).verdict).toBe("CURATOR_MISS");
	});

	it("blames material selection when a story existed but was not handed over", () => {
		const hits = { ...empty, items: [item], decisions: [decision], candidates: [candidate] };
		expect(attributeMiss(hits).verdict).toBe("MATERIAL_MISS");
	});

	it("blames the editor when the material was there and nothing was published", () => {
		const hits = {
			...empty,
			items: [item],
			decisions: [decision],
			candidates: [candidate],
			materials: [material],
		};
		expect(attributeMiss(hits).verdict).toBe("EDITOR_MISS");
	});

	it("reports PUBLISHED when the story did reach the brief", () => {
		const hits = {
			items: [item],
			decisions: [decision],
			candidates: [candidate],
			materials: [material],
			finals: [final],
		};
		expect(attributeMiss(hits).verdict).toBe("PUBLISHED");
	});

	it("does not blame the editor for a story that was never collected", () => {
		// The regression this guards: checking stages backwards makes a total miss
		// look like an editor problem, because absence is true at every stage.
		const result = attributeMiss(empty);
		expect(result.verdict).not.toBe("EDITOR_MISS");
		expect(result.evidence[0]).toContain("no match");
	});

	it("says UNKNOWN when an item was collected but never decided", () => {
		expect(attributeMiss({ ...empty, items: [item] }).verdict).toBe("UNKNOWN");
	});

	it("explains every verdict it can return", () => {
		for (const hits of [empty, { ...empty, items: [item] }]) {
			expect(attributeMiss(hits).meaning.length).toBeGreaterThan(0);
		}
	});

	it("summarises repeated values instead of listing them", () => {
		expect(summarise(["IRRELEVANT", "IRRELEVANT", "DUPLICATE"])).toBe("IRRELEVANT x2, DUPLICATE");
	});
});

/*
 * The isolation claim, pinned structurally.
 *
 * config/observation-audit.yaml draws a line the interest profile does not --
 * engineering versus business -- and the whole reason its numbers are worth
 * reading is that nothing on the decision path can see it. That guarantee is
 * stated in the file header, in the config comments and in docs/OBSERVATION_REVIEW.md,
 * and a guarantee repeated in three prose comments and enforced nowhere is a
 * guarantee that survives exactly until someone needs a topic grouping in a
 * hurry. So it is a test: the audit grouping, and the observation module around
 * it, may be reached from the observation CLI and from tests, and from nothing
 * else.
 */
describe("the observation layer stays off the decision path", () => {
	const SRC = fileURLToPath(new URL("../src", import.meta.url));
	const WEB = fileURLToPath(new URL("../web", import.meta.url));
	const SKIP_DIRS = new Set(["node_modules", "dist", "out", ".turbo"]);
	const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

	/** The one file allowed to consume it: the read-only reporting command. */
	const ALLOWED = new Set(["cli/run-observation.ts"]);

	async function walk(dir: string): Promise<string[]> {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return [];
		}
		const out: string[] = [];
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".next")) continue;
				out.push(...(await walk(full)));
			} else if (SOURCE_EXT.test(entry.name)) {
				out.push(full);
			}
		}
		return out;
	}

	it("is imported by the observation CLI and by nothing else in src/ or web/", async () => {
		const offenders: string[] = [];
		for (const root of [SRC, WEB]) {
			for (const file of await walk(root)) {
				const rel = relative(SRC, file);
				if (rel.startsWith("observation/") || ALLOWED.has(rel)) continue;
				const text = await readFile(file, "utf8");
				if (/from\s+["'][^"']*observation\//.test(text) || /loadAuditGroups/.test(text)) {
					offenders.push(relative(fileURLToPath(new URL("..", import.meta.url)), file));
				}
			}
		}
		expect(offenders, `observation code reached from the decision path: ${offenders.join(", ")}`).toEqual([]);
	});

	it("does not read the interest profile's weights back into anything it writes", async () => {
		// The module has no write path at all; this pins that rather than trusting
		// the header comment, because a measurement tool that can write is a tool
		// whose own numbers have to be qualified forever.
		for (const file of await walk(join(SRC, "observation"))) {
			const text = await readFile(file, "utf8");
			expect(text, `${file} contains a write statement`).not.toMatch(/\b(insert into|update\s+\w+\s+set|delete from)\b/i);
		}
	});
});
