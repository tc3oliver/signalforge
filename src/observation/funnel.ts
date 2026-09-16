/*
 * Where a topic's stories stop.
 *
 * Until now the only way to answer "is Crypto under-covered because nothing is
 * collected, or because the Curator scores it low, or because the Editor never
 * picks it?" was to trace one story by hand through five SQL queries. That
 * works for a story the owner already remembers; it cannot answer the question
 * for a topic in aggregate, which is the form the complaint actually arrives in.
 *
 * Four stages, all of them rows the pipeline already wrote:
 *
 *   candidate  story_ledger              the Curator made a story of it
 *   material   daily_material_stories    the Curator handed it to the Editor
 *   final      daily_brief_stories       the Editor published it
 *   mustKnow   daily_brief_stories.must_know
 *
 * The topic attribution comes from `story_ledger.topic_ids`, which means the
 * funnel starts at the candidate stage and cannot start earlier: a raw item is
 * not attributed to a topic anywhere, so "how many Crypto items were collected"
 * is not derivable and is reported as unavailable rather than estimated. That
 * boundary is deliberate — the gap between collected and candidate is exactly
 * where a guess would be least defensible and most load-bearing.
 */

/** One story's per-stage presence, as read from the durable rows. */
export interface FunnelStoryInput {
	storyId: string;
	topicIds: string[];
	isMaterial: boolean;
	isFinal: boolean;
	isMustKnow: boolean;
}

export interface TopicFunnelRow {
	topicId: string;
	label: string;
	/** From the interest profile, so a thin topic can be read against its prior. */
	weight: number;
	candidateStories: number;
	materialStories: number;
	finalStories: number;
	mustKnowStories: number;
}

export interface TopicFunnel {
	rows: TopicFunnelRow[];
	/** Candidate stories the Curator attributed to no topic at all. */
	untagged: number;
	/** Total candidate stories considered, tagged or not. */
	totalCandidates: number;
	/**
	 * Stages that could not be attributed to a topic for this range. Always
	 * carries the raw stage; see the file header.
	 */
	unavailableStages: string[];
}

/** A topic as the report needs it: identity and its configured prior. */
export interface FunnelTopic {
	id: string;
	label: string;
	weight: number;
}

/**
 * A story counts towards every topic it carries, so the rows do not sum to the
 * story total. That is correct rather than convenient: a story tagged both
 * `inference` and `vllm` genuinely is evidence for both, and splitting it
 * fractionally would make each row unreadable on its own.
 */
export function buildTopicFunnel(
	stories: readonly FunnelStoryInput[],
	topics: readonly FunnelTopic[],
): TopicFunnel {
	const rows = new Map<string, TopicFunnelRow>();
	for (const topic of topics) {
		rows.set(topic.id, {
			topicId: topic.id,
			label: topic.label,
			weight: topic.weight,
			candidateStories: 0,
			materialStories: 0,
			finalStories: 0,
			mustKnowStories: 0,
		});
	}

	let untagged = 0;
	for (const story of stories) {
		if (story.topicIds.length === 0) {
			untagged++;
			continue;
		}
		for (const topicId of story.topicIds) {
			let row = rows.get(topicId);
			if (!row) {
				// A topic the Curator named that the profile no longer lists -- a
				// renamed or deleted topic. Kept and marked, because dropping it would
				// make the story vanish from the funnel without trace.
				row = {
					topicId,
					label: `${topicId} (not in the current profile)`,
					weight: 0,
					candidateStories: 0,
					materialStories: 0,
					finalStories: 0,
					mustKnowStories: 0,
				};
				rows.set(topicId, row);
			}
			row.candidateStories++;
			if (story.isMaterial) row.materialStories++;
			if (story.isFinal) row.finalStories++;
			if (story.isMustKnow) row.mustKnowStories++;
		}
	}

	const ordered = [...rows.values()].sort(
		(a, b) => b.weight - a.weight || b.candidateStories - a.candidateStories || (a.topicId < b.topicId ? -1 : 1),
	);

	return {
		rows: ordered,
		untagged,
		totalCandidates: stories.length,
		unavailableStages: ["raw (no topic attribution exists on normalized_items)"],
	};
}
