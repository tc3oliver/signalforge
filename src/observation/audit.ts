import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/*
 * Audit grouping: a read-only lens over what the pipeline already decided.
 *
 * The complaint this exists to measure is specific. The brief carries plenty of
 * AI stories, but a large share of them are funding rounds, IPOs, valuations and
 * executive remarks, while model releases, inference, serving, agent runtimes,
 * MCP, ROCm/MLX/vLLM/SGLang, quantization and GPU infrastructure are thinner
 * than they should be. "Plenty of AI stories" and "not enough AI engineering"
 * are both true, and no existing metric can tell them apart, because the
 * pipeline's own unit is the topic and the topics do not draw this line.
 *
 * So this file draws it, and does so deliberately outside the decision path.
 * It is loaded by the observation CLI and by nothing else — no collector, no
 * curator tool, no editor prompt, no ranking. Grep for `loadAuditGroups` to
 * confirm that; if it ever appears under src/curator or src/editor, the
 * measurement has started steering what it measures and the number stops being
 * worth having.
 *
 * It maps topic ids, because those are durable evidence written by the Curator
 * into `story_ledger.topic_ids`. It deliberately does not fall back to matching
 * keywords against titles: a brittle regex over headlines would produce a
 * confident-looking percentage that nobody could defend, and the honest output
 * of an unclassifiable story is UNCLASSIFIED plus a line in the manual review
 * sheet. See the note in docs/OBSERVATION_REVIEW.md about why the ratio cannot
 * yet be fully automatic.
 */

const AuditGroupId = z.enum(["AI_ENGINEERING", "AI_RESEARCH", "AI_BUSINESS", "NON_AI"]);
export type AuditGroupId = z.infer<typeof AuditGroupId>;

export const AuditGroupsConfig = z
	.object({
		groups: z
			.array(
				z
					.object({
						id: AuditGroupId,
						label: z.string().min(1),
						/** Topic ids from interests.yaml that count towards this group. */
						topicIds: z.array(z.string().min(1)).default([]),
					})
					.strict(),
			)
			.min(1),
	})
	.strict();
export type AuditGroupsConfig = z.infer<typeof AuditGroupsConfig>;

/** Stories whose topic ids map to no configured group, or that carry none at all. */
export const UNCLASSIFIED = "UNCLASSIFIED" as const;
export type AuditBucket = AuditGroupId | typeof UNCLASSIFIED;

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILE = "observation-audit.yaml";

/** Loads the grouping, preferring a gitignored `.local.yaml` exactly as every other config does. */
export function loadAuditGroups(root: string = PROJECT_ROOT): AuditGroupsConfig {
	const local = join(root, "config", "observation-audit.local.yaml");
	const path = existsSync(local) ? local : join(root, "config", FILE);
	const parsed = parseYaml(readFileSync(path, "utf8"));
	const result = AuditGroupsConfig.safeParse(parsed);
	if (!result.success) {
		const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
		throw new Error(`Invalid ${path}:\n  ${issues.join("\n  ")}`);
	}
	return result.data;
}

/** topicId -> group, built once per report rather than per story. */
export function buildTopicIndex(config: AuditGroupsConfig): Map<string, AuditGroupId> {
	const index = new Map<string, AuditGroupId>();
	for (const group of config.groups) {
		for (const topicId of group.topicIds) index.set(topicId, group.id);
	}
	return index;
}

/**
 * Which bucket one story counts towards.
 *
 * A story may carry several topics and they may disagree — an open-weight model
 * release from a company that just raised money genuinely is both. Rather than
 * pick a winner by some invented precedence, a story with topics in more than
 * one group is reported as UNCLASSIFIED, so the ambiguity shows up as a number
 * the reviewer can see instead of being resolved silently in whichever
 * direction the first matching topic happened to fall.
 */
export function classifyStory(topicIds: readonly string[], index: Map<string, AuditGroupId>): AuditBucket {
	const matched = new Set<AuditGroupId>();
	for (const id of topicIds) {
		const group = index.get(id);
		if (group) matched.add(group);
	}
	if (matched.size !== 1) return UNCLASSIFIED;
	return [...matched][0] as AuditGroupId;
}

export interface AuditTally {
	bucket: AuditBucket;
	label: string;
	stories: number;
	mustKnow: number;
}

export interface AuditStoryInput {
	storyId: string;
	topicIds: string[];
	inBrief: boolean;
	mustKnow: boolean;
}

/**
 * Counts published stories per bucket. Only stories that reached the brief are
 * counted: the question is what the reader actually read, not what was
 * considered.
 */
export function tallyAudit(stories: readonly AuditStoryInput[], config: AuditGroupsConfig): AuditTally[] {
	const index = buildTopicIndex(config);
	const labels = new Map<AuditBucket, string>(config.groups.map((g) => [g.id, g.label]));
	labels.set(UNCLASSIFIED, "Unclassified (no topic, or topics spanning groups)");

	const counts = new Map<AuditBucket, AuditTally>();
	const order: AuditBucket[] = [...config.groups.map((g) => g.id), UNCLASSIFIED];
	for (const bucket of order) {
		counts.set(bucket, { bucket, label: labels.get(bucket) ?? bucket, stories: 0, mustKnow: 0 });
	}

	for (const story of stories) {
		if (!story.inBrief) continue;
		const bucket = classifyStory(story.topicIds, index);
		const tally = counts.get(bucket);
		if (!tally) continue;
		tally.stories++;
		if (story.mustKnow) tally.mustKnow++;
	}
	return order.map((b) => counts.get(b) as AuditTally);
}
