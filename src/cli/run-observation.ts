import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
	fetchScreeningOutcomes,
	fetchScreeningVersions,
	fetchStageUsage,
	fetchTriageOutcomes,
	fetchTriageVersions,
} from "../observation/queries.ts";
import {
	renderAttribution,
	renderAudit,
	renderContinuity,
	renderEpochs,
	renderFunnel,
	renderScreening,
	renderSignals,
	renderStageUsage,
	renderStoryLedger,
	renderTriage,
} from "../observation/render.ts";
import {
	assessScreeningReadiness,
	buildScreeningFunnel,
	type ScreeningFunnel,
} from "../observation/screening-funnel.ts";
import {
	assessRoutingReadiness,
	buildTriageFunnel,
	type TriageFunnel,
} from "../observation/triage-funnel.ts";
import { TODAY_NEAR_SCORE } from "../curator/tools.ts";
import { listStoriesForDate } from "../db/stories.ts";
import {
	ledgerTelemetry,
	listSavings,
	residualPairs,
	type LedgerEvent,
} from "../observation/story-ledger.ts";
import { parseFlags, projectRoot } from "./_args.ts";

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

/** Items the Curator decided on these days, the denominator for tokens per Curator item. */
async function countDecisions(sql: ReturnType<typeof createSql>, lineage: string, dates: readonly string[]): Promise<number> {
	const rows = await sql<{ n: number }[]>`
		select count(*)::int as n from item_decisions
		where lineage = ${lineage} and date = any(${sql.array([...dates])})
	`;
	return rows[0]?.n ?? 0;
}

function usage(): string {
	return [
		"pnpm observe [options]",
		"",
		"  --date <YYYY-MM-DD>   report one day instead of the current epoch",
		"  --all                 report every epoch separately",
		"  --missing <pattern>   attribute a story you expected but did not see",
		"                        (needs --date; matches a distinctive word from its title or URL)",
		"  --lineage <name>      default: $DI_LINEAGE or 'default'",
		"  --log <path>          run log to read story-ledger telemetry from",
		"                        (default: logs/daily.err.log; the section is skipped if absent)",
	].join("\n");
}


/**
 * The run log's events for one day, bracketed by that day's run.
 *
 * Tool events carry no run id -- only the state transitions do -- so the window
 * comes from the state lines themselves: everything from the run entering
 * CURATING until it leaves. A log that has rotated past the day simply yields
 * nothing, and the section says so rather than reporting a partial count as a
 * whole one.
 */
function readRunEvents(logPath: string, runIds: readonly string[]): LedgerEvent[] | undefined {
	if (!existsSync(logPath)) return undefined;
	const lines = readFileSync(logPath, "utf8").split("\n");
	const rows: Array<LedgerEvent & { runId?: string }> = [];
	for (const line of lines) {
		if (line.trim() === "") continue;
		try {
			rows.push(JSON.parse(line) as LedgerEvent & { runId?: string });
		} catch {
			// A log line that is not our JSON is not our business.
		}
	}
	const wanted = new Set(runIds);
	const marks = rows
		.map((r, i) => ({ r, i }))
		.filter(({ r }) => r.kind === "state" && r.runId !== undefined && wanted.has(r.runId));
	if (marks.length === 0) return undefined;
	const from = marks[0]!.i;
	const to = marks[marks.length - 1]!.i;
	return rows.slice(from, to + 1);
}

async function main(): Promise<void> {
	const flags = parseFlags(process.argv.slice(2));
	if (flags["help"] === true) {
		console.log(usage());
		return;
	}

	const lineage = typeof flags["lineage"] === "string" ? flags["lineage"] : process.env["DI_LINEAGE"] ?? "default";
	const logPath =
		typeof flags["log"] === "string" ? flags["log"] : join(projectRoot(), "logs", "daily.err.log");
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
			//
			// One section per pass. Since migration 011 the deterministic rules and
			// the model pass both hold rows for the same items, and the whole point
			// of running them together is to read their recall side by side --
			// merging them would average two different filters into a figure that
			// describes neither.
			const versions = await fetchTriageVersions(sql, lineage, epochDates);
			for (const version of versions) {
				const triageFunnels: TriageFunnel[] = [];
				for (const date of epochDates) {
					const outcomes = await fetchTriageOutcomes(sql, lineage, date, version);
					if (outcomes.length > 0) triageFunnels.push(buildTriageFunnel(outcomes));
				}
				console.log("");
				console.log(
					renderTriage(triageFunnels, assessRoutingReadiness(triageFunnels), version),
				);
			}
			if (versions.length === 0) {
				console.log("");
				console.log(renderTriage([], assessRoutingReadiness([])));
			}

			// The screener, one section per (model, policy) version -- a prompt
			// change is a new evidence epoch and must not be averaged into the old.
			const screeningMode = loadConfig().agent.screening?.mode ?? "off";
			const screeners = await fetchScreeningVersions(sql, lineage, epochDates);
			let screenedItems = 0;
			for (const version of screeners) {
				const funnels: ScreeningFunnel[] = [];
				for (const date of epochDates) {
					const outcomes = await fetchScreeningOutcomes(sql, lineage, date, version);
					if (outcomes.length > 0) funnels.push(buildScreeningFunnel(date, outcomes));
				}
				screenedItems += funnels.reduce((n, f) => n + f.total, 0);
				console.log("");
				console.log(renderScreening(funnels, assessScreeningReadiness(funnels), version, screeningMode));
			}
			if (screeners.length === 0) {
				console.log("");
				console.log(
					renderScreening([], assessScreeningReadiness([]), { provider: "-", model: "-", policyVersion: "-" }, screeningMode),
				);
			}

			/*
			 * The story ledger, one day at a time. Unlike the funnels above this
			 * is not averaged across the epoch: a split event is a specific pair
			 * of slugs on a specific day, and a person has to read the two titles
			 * to say whether it is one. Averaging would hide exactly the thing
			 * worth looking at.
			 */
			for (const date of epochDates) {
				const entries = await listStoriesForDate(sql, lineage, date);
				if (entries.length === 0) continue;
				const runIds = (
					await sql<{ run_id: string }[]>`
						select run_id from daily_runs where lineage = ${lineage} and date = ${date}
					`
				).map((r) => r.run_id);
				const events = readRunEvents(logPath, runIds) ?? [];
				const telemetry = ledgerTelemetry(events);
				// The old payload rebuilt from the ids each call actually returned,
				// so the saving is measured against this run rather than projected.
				const sizes = events
					.filter((e) => e.kind === "tool_call" && e.tool === "list_today_stories" && e.match === undefined)
					.map((e) => e.count ?? e.total ?? 0)
					.filter((n) => n > 0);
				console.log("");
				console.log(
					renderStoryLedger({
						date,
						telemetry,
						savings: listSavings(entries, sizes),
						pairs: residualPairs(entries, TODAY_NEAR_SCORE),
						threshold: TODAY_NEAR_SCORE,
						storyCount: entries.length,
					}),
				);
				if (events.length === 0) {
					console.log(`  (no run events for ${date} in ${logPath}; counts above are from the ledger only)`);
				}
			}

			const curatorItems = stories.length === 0 ? 0 : await countDecisions(sql, lineage, epochDates);
			console.log("");
			console.log(renderStageUsage(await fetchStageUsage(sql, lineage, epochDates), screenedItems, curatorItems));
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
