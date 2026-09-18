import { loadConfig } from "../config/loader.ts";
import { loadSecretsFileAndReport } from "../config/secrets-file.ts";
import type { ScreeningConfig } from "../config/schema.ts";
import { createSql, type Sql } from "../db/client.ts";
import { fetchScreeningOutcomes } from "../observation/queries.ts";
import { renderScreening } from "../observation/render.ts";
import { assessScreeningReadiness, buildScreeningFunnel, type ScreeningFunnel } from "../observation/screening-funnel.ts";
import { createLogger } from "../runtime/logger.ts";
import type { DailyManifest, NormalizedItem } from "../schemas/index.ts";
import { runScreeningStage } from "../screening/stage.ts";
import { parseFlags } from "./_args.ts";

/*
 * Backtest the screener against days the Curator has already judged.
 *
 *   pnpm screen --date 2026-09-18
 *   pnpm screen --date 2026-09-16,2026-09-17,2026-09-18
 *   pnpm screen --date 2026-09-18 --policy-version screening-v2-exp --force
 *
 * Every item the Curator decided on that day is screened, in shadow, and the
 * verdicts are stored in item_screening with no run id. Nothing about the day
 * changes: no decision, story, material or brief is touched, and a backfilled
 * row can never withhold anything (`routed` is always false here).
 *
 * The point is evidence now rather than later. Three production days already
 * hold ~4000 items with a Curator disposition, a story link and a
 * material/final/Must-Know outcome each; replaying the screener over them
 * answers "what would routing have cost?" exactly, today. The report at the
 * end is the same `pnpm observe` section, so a backtest and a live shadow day
 * read identically.
 *
 * `--policy-version` and `--model` override config for a one-off experiment.
 * They write under the overridden version, so an experiment never pollutes
 * the evidence of the configured one.
 */

function usage(): string {
	return [
		"pnpm screen --date <YYYY-MM-DD>[,<YYYY-MM-DD>...] [options]",
		"",
		"  --lineage <name>          default: $DI_LINEAGE or 'default'",
		"  --force                   re-screen items that already carry a verdict from this version",
		"  --policy-version <v>      stamp rows with this policy version instead of the configured one",
		"  --model <id>              use this model instead of the configured one",
		"  --batch-size <n>          items per request",
		"  --hint                    include the per-source hint line (score, repo, categories)",
		"  --report-only             print the report for existing rows; call no model",
	].join("\n");
}

/** Items the Curator decided on `date`: the evidence set for a backtest. */
async function decidedItems(sql: Sql, lineage: string, date: string): Promise<NormalizedItem[]> {
	const rows = await sql<
		{
			item_id: string;
			source_type: NormalizedItem["sourceType"];
			source_name: string;
			title: string;
			summary: string;
			published_at: string;
			metadata: Record<string, unknown>;
		}[]
	>`
		select n.item_id, n.source_type, n.source_name, n.title, n.summary, n.published_at, n.metadata
		from item_decisions d
		join normalized_items n on n.lineage = d.lineage and n.item_id = d.item_id
		where d.lineage = ${lineage} and d.date = ${date}
		order by n.published_at, n.item_id
	`;
	return rows.map((r) => ({
		id: r.item_id,
		sourceType: r.source_type,
		sourceName: r.source_name,
		title: r.title,
		summary: r.summary,
		publishedAt: new Date(r.published_at).toISOString(),
		metadata: r.metadata ?? {},
		trust: "UNTRUSTED_EXTERNAL_CONTENT" as const,
	}));
}

async function main(): Promise<void> {
	const flags = parseFlags(process.argv.slice(2));
	if (flags["help"] === true || typeof flags["date"] !== "string") {
		console.log(usage());
		if (flags["help"] !== true) process.exitCode = 2;
		return;
	}
	const dates = flags["date"].split(",").map((d) => d.trim()).filter(Boolean);
	const lineage = typeof flags["lineage"] === "string" ? flags["lineage"] : process.env["DI_LINEAGE"] ?? "default";
	const log = createLogger("screen");
	loadSecretsFileAndReport((msg, fields) => log.info(msg, fields));

	const configured = loadConfig().agent.screening;
	if (!configured) throw new Error("config/agent.yaml has no `screening` block");
	const config: ScreeningConfig = {
		...configured,
		...(typeof flags["policy-version"] === "string" ? { policyVersion: flags["policy-version"] } : {}),
		...(typeof flags["model"] === "string" ? { model: flags["model"] } : {}),
		...(typeof flags["batch-size"] === "string" ? { batchSize: Number(flags["batch-size"]) } : {}),
		...(flags["hint"] === true ? { includeHint: true } : {}),
	};
	const version = { provider: config.provider, model: config.model, policyVersion: config.policyVersion };

	const sql = createSql();
	try {
		const funnels: ScreeningFunnel[] = [];
		let totalUsage = { input: 0, output: 0, totalTokens: 0, reportedBy: 0 };
		let totalMs = 0;
		for (const date of dates) {
			const items = await decidedItems(sql, lineage, date);
			if (items.length === 0) {
				log.info("no decided items for this day; nothing to backtest", { date });
				continue;
			}
			const manifest: DailyManifest = { date, generatedAt: new Date().toISOString(), items, facts: [] };

			if (flags["report-only"] !== true) {
				const outcome = await runScreeningStage({
					sql,
					lineage,
					date,
					manifest,
					config,
					interests: loadConfig().interests,
					forceShadow: true,
					incremental: flags["force"] !== true,
					log: (msg, fields) => log.info(msg, fields),
				});
				totalMs += outcome.durationMs;
				if (outcome.usage) {
					totalUsage = {
						input: totalUsage.input + outcome.usage.input,
						output: totalUsage.output + outcome.usage.output,
						totalTokens: totalUsage.totalTokens + outcome.usage.totalTokens,
						reportedBy: totalUsage.reportedBy + outcome.usage.reportedBy,
					};
				}
			}

			const rows = await fetchScreeningOutcomes(sql, lineage, date, version);
			if (rows.length > 0) funnels.push(buildScreeningFunnel(date, rows));
		}

		console.log("");
		console.log(renderScreening(funnels, assessScreeningReadiness(funnels), version, `backtest of ${configured.mode}`));
		if (flags["report-only"] !== true) {
			console.log("");
			console.log(
				totalUsage.reportedBy > 0
					? `backtest spend: ${totalUsage.totalTokens} tokens (${totalUsage.input} in, ${totalUsage.output} out) over ${totalUsage.reportedBy} request(s), ${Math.round(totalMs / 1000)}s`
					: `backtest spend: usage unavailable (no request reported it), ${Math.round(totalMs / 1000)}s`,
			);
		}
	} finally {
		await sql.end();
	}
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
});
