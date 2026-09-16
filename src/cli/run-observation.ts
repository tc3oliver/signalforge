import { loadConfig } from "../config/loader.ts";
import { createSql } from "../db/client.ts";
import { attributeMiss } from "../observation/attribution.ts";
import { loadAuditGroups, tallyAudit } from "../observation/audit.ts";
import { assessContinuity, continuityForDay, type ContinuityMetrics } from "../observation/continuity.ts";
import { checkAggregation, currentEpoch, epochId } from "../observation/epoch.ts";
import { buildTopicFunnel, type FunnelStoryInput } from "../observation/funnel.ts";
import {
	fetchBriefEpochs,
	fetchChangeTypes,
	fetchFunnelStories,
	fetchSignals,
	fetchStageHits,
	fetchTriageOutcomes,
} from "../observation/queries.ts";
import {
	renderAttribution,
	renderAudit,
	renderContinuity,
	renderEpochs,
	renderFunnel,
	renderSignals,
	renderTriage,
} from "../observation/render.ts";
import {
	assessRoutingReadiness,
	buildTriageFunnel,
	type TriageFunnel,
} from "../observation/triage-funnel.ts";
import { parseFlags } from "./_args.ts";

/*
 * The observation report: `pnpm observe`.
 *
 * It reads and prints. It writes no table, changes no config and contacts no
 * network, which is what makes it safe to run in the middle of an observation
 * window -- the whole point of a freeze is that measuring must not perturb.
 *
 *   pnpm observe                          the current epoch
 *   pnpm observe --date 2026-09-16        one day
 *   pnpm observe --all                    every epoch, reported separately
 *   pnpm observe --missing "liquid network" --date 2026-09-16
 *
 * The default deliberately covers only the current epoch. Asking for a range
 * that spans a profile change prints the refusal from checkAggregation rather
 * than a merged figure; see src/observation/epoch.ts for why that is a feature.
 */

function usage(): string {
	return [
		"pnpm observe [options]",
		"",
		"  --date <YYYY-MM-DD>   report one day instead of the current epoch",
		"  --all                 report every epoch separately",
		"  --missing <pattern>   attribute a story you expected but did not see",
		"                        (needs --date; matches a distinctive word from its title or URL)",
		"  --lineage <name>      default: $DI_LINEAGE or 'default'",
	].join("\n");
}

async function main(): Promise<void> {
	const flags = parseFlags(process.argv.slice(2));
	if (flags["help"] === true) {
		console.log(usage());
		return;
	}

	const lineage = typeof flags["lineage"] === "string" ? flags["lineage"] : process.env["DI_LINEAGE"] ?? "default";
	const sql = createSql();

	try {
		const briefRows = await fetchBriefEpochs(sql, lineage);
		if (briefRows.length === 0) {
			console.log(`No published briefs in lineage '${lineage}'. Nothing to observe yet.`);
			return;
		}

		const allEpochs = checkAggregation(briefRows);
		const latest = currentEpoch(allEpochs.epochs);

		console.log(`# SignalForge observation — lineage '${lineage}'`);
		console.log(`# generated ${new Date().toISOString()}`);
		console.log("");
		console.log(renderEpochs(allEpochs, latest));

		// Which days this run reports on, and the epoch they belong to.
		let dates: string[];
		if (typeof flags["date"] === "string") {
			dates = [flags["date"]];
		} else if (flags["all"] === true) {
			dates = briefRows.map((r) => r.date);
		} else {
			dates = latest?.dates ?? [];
		}

		// Group by epoch rather than reporting one merged block: a --all run spans
		// the personalization boundary by definition, and that is exactly the merge
		// the epoch check exists to prevent.
		const epochOfDate = new Map(briefRows.map((r) => [r.date, epochId(r.profileVersion)]));
		const byEpoch = new Map<string, string[]>();
		for (const date of dates) {
			const id = epochOfDate.get(date) ?? "(no published brief)";
			const bucket = byEpoch.get(id);
			if (bucket) bucket.push(date);
			else byEpoch.set(id, [date]);
		}

		const interests = loadConfig().interests;
		const topics = interests.topics.map((t) => ({ id: t.id, label: t.label, weight: t.weight }));
		const auditGroups = loadAuditGroups();

		for (const [id, epochDates] of byEpoch) {
			console.log(`\n${"=".repeat(72)}`);
			console.log(`EPOCH ${id} — ${epochDates.join(", ")}`);
			console.log("=".repeat(72));

			const stories: FunnelStoryInput[] = [];
			const continuity: ContinuityMetrics[] = [];
			for (const date of epochDates) {
				stories.push(...(await fetchFunnelStories(sql, lineage, date)));
				continuity.push(continuityForDay(date, await fetchChangeTypes(sql, lineage, date)));
			}

			console.log("");
			console.log(renderFunnel(buildTopicFunnel(stories, topics)));
			console.log("");
			console.log(
				renderAudit(
					tallyAudit(
						stories.map((s) => ({
							storyId: s.storyId,
							topicIds: s.topicIds,
							inBrief: s.isFinal,
							mustKnow: s.isMustKnow,
						})),
						auditGroups,
					),
				),
			);
			console.log("");
			console.log(renderContinuity(continuity, assessContinuity(continuity)));

			// Shadow-mode triage, reported per epoch for the same reason everything
			// else is: a rule change and a profile change both move these numbers,
			// and averaging across either produces a figure describing no system.
			const triageFunnels: TriageFunnel[] = [];
			for (const date of epochDates) {
				const outcomes = await fetchTriageOutcomes(sql, lineage, date);
				if (outcomes.length > 0) triageFunnels.push(buildTriageFunnel(outcomes));
			}
			console.log("");
			console.log(renderTriage(triageFunnels, assessRoutingReadiness(triageFunnels)));
		}

		console.log("");
		console.log(renderSignals(await fetchSignals(sql, lineage)));

		if (typeof flags["missing"] === "string") {
			const date = flags["date"];
			if (typeof date !== "string") {
				throw new Error("--missing needs --date: a story can only be traced through one day's rows");
			}
			const hits = await fetchStageHits(sql, lineage, date, flags["missing"]);
			console.log("");
			console.log(renderAttribution(flags["missing"], attributeMiss(hits)));
		}
	} finally {
		await sql.end();
	}
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
});
