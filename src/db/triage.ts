import type { Sql } from "./client.ts";
import type { TriageResult } from "../triage/types.ts";

/*
 * The only write path to `item_triage`, and there is deliberately no read path
 * from the pipeline.
 *
 * Shadow mode means the prediction is recorded next to the decision the Curator
 * actually made and changes nothing about how that decision is reached. The
 * observation report reads this table; `src/pipeline/` and the agent tools must
 * not, and `tests/triage.test.ts` walks the tree to keep it that way.
 */

/**
 * Version stamp for the rule set that produced a row.
 *
 * Bumped by hand when a rule changes in a way that moves the mix. Recall
 * measured across a rule change is two different measurements averaged, which
 * is the same silent merge the observation epochs refuse, so the version is
 * stored per row rather than assumed constant.
 */
export const TRIAGE_RULES_VERSION = "deterministic-v1";

export async function saveTriage(
	sql: Sql,
	lineage: string,
	date: string,
	results: readonly TriageResult[],
	rulesVersion: string = TRIAGE_RULES_VERSION,
): Promise<number> {
	if (results.length === 0) return 0;

	// Chunked: a manifest can carry a couple of thousand rows and a single
	// statement with that many parameter tuples is the kind of thing that works
	// until the day it does not.
	const CHUNK = 500;
	let written = 0;
	for (let i = 0; i < results.length; i += CHUNK) {
		const chunk = results.slice(i, i + CHUNK).map((r) => ({
			lineage,
			date,
			item_id: r.itemId,
			category: r.category,
			rule_id: r.ruleId,
			reason: r.reason,
			relevance_hint: r.relevanceHint,
			topic_ids: r.topicIds,
			rules_version: rulesVersion,
		}));
		await sql`
			insert into item_triage ${sql(
				chunk,
				"lineage",
				"date",
				"item_id",
				"category",
				"rule_id",
				"reason",
				"relevance_hint",
				"topic_ids",
				"rules_version",
			)}
			on conflict (lineage, date, item_id) do update set
				category = excluded.category,
				rule_id = excluded.rule_id,
				reason = excluded.reason,
				relevance_hint = excluded.relevance_hint,
				topic_ids = excluded.topic_ids,
				rules_version = excluded.rules_version
		`;
		written += chunk.length;
	}
	return written;
}
