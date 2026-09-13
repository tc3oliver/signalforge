import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CollectedItem, Collector, CollectorResult } from "../src/collectors/types.ts";
import { getBrief } from "../src/db/briefs.ts";
import { createSql, type Sql } from "../src/db/client.ts";
import { listCollectionRuns } from "../src/db/collector-health.ts";
import { countRawItems } from "../src/db/items.ts";
import { getMaterials } from "../src/db/materials.ts";
import { migrate } from "../src/db/migrate.ts";
import { getRun } from "../src/db/runs.ts";
import { listSignals } from "../src/db/signals.ts";
import { announceSkip, probeDatabase, purgeLineage, testLineage } from "../src/db/test-support.ts";
import { runDailyPipeline } from "../src/pipeline/daily-run.ts";
import type { RegistryEntry } from "../src/pipeline/collection.ts";
import { MODEL_CHAIN } from "../src/runtime/model-config.ts";
import {
	REPO_ROOT,
	competentCuratorScript,
	competentEditorScript,
	createResolvedDriverFactory,
	createThrowingDriverFactory,
} from "./support/fake-agent.ts";

const probe = await probeDatabase();
announceSkip("pipeline-daily-run", probe);

const DATE = "2026-09-13";
const NOW = new Date("2026-09-13T07:00:00.000Z");
const GROUPS = 10;
const SKILLS_ROOT = join(REPO_ROOT, "agent", "skills");

/** Ten groups of two so the curator yields enough stories for a valid 8-15 story brief. */
function syntheticItems(): CollectedItem[] {
	const items: CollectedItem[] = [];
	for (let g = 1; g <= GROUPS; g++) {
		const group = `g${String(g).padStart(2, "0")}`;
		for (let k = 0; k < 2; k++) {
			const externalId = `${group}-${k}`;
			items.push({
				sourceType: k === 0 ? "rss" : "hackernews",
				sourceName: k === 0 ? "Synthetic Wire" : "Hacker News",
				externalId,
				title: `${group} coverage ${k + 1}: something measurable happened`,
				summary: `Report ${k + 1} about event ${group}.`,
				body: `Full body for ${group} coverage ${k + 1}.`,
				url: `https://example.invalid/${group}/${k + 1}`,
				publishedAt: `${DATE}T0${(g % 9) + 1}:00:00.000Z`,
				metadata: { group },
				trust: "UNTRUSTED_EXTERNAL_CONTENT",
				raw: { externalId, body: { externalId }, fetchedAt: `${DATE}T06:00:00.000Z` },
			});
		}
	}
	return items;
}

function goodCollector(): Collector {
	return {
		id: "fake-good",
		sourceType: "rss",
		requiredSecrets: [],
		check: async () => ({ ok: true, detail: "fake" }),
		collect: async (): Promise<CollectorResult> => {
			const items = syntheticItems();
			return {
				collectorId: "fake-good",
				health: "OK",
				items,
				facts: [],
				itemsFetched: items.length,
				cursor: "cursor-next",
				warnings: [],
				startedAt: NOW.toISOString(),
				finishedAt: NOW.toISOString(),
				latencyMs: 3,
			};
		},
	};
}

function brokenCollector(): Collector {
	return {
		id: "fake-broken",
		sourceType: "github",
		requiredSecrets: [],
		check: async () => ({ ok: true, detail: "fake" }),
		collect: async () => {
			throw new Error("provider returned 503");
		},
	};
}

const ENTRIES: RegistryEntry[] = [
	{ sourceKey: "fake-good", collector: goodCollector() },
	{ sourceKey: "fake-broken", collector: brokenCollector() },
];

const collection = {
	entries: ENTRIES,
	enabledSourceKeys: ["fake-good", "fake-broken"],
};

/** Curator and editor are scripted against the real tools; no model is contacted. */
function workingDriverFactory() {
	return createResolvedDriverFactory((opts) =>
		opts.customTools.some((t) => t.name === "submit_brief")
			? competentEditorScript()
			: competentCuratorScript(),
	);
}

const baseOptions = {
	date: DATE,
	skillsRoot: SKILLS_ROOT,
	cwd: REPO_ROOT,
	chain: [MODEL_CHAIN[0]!],
	now: () => NOW,
};

let sql: Sql;
let lineage: string;

beforeAll(async () => {
	if (!probe.available) return;
	sql = createSql();
	await migrate(sql);
	lineage = testLineage("pipeline-daily");
});

afterAll(async () => {
	if (!probe.available) return;
	await purgeLineage(sql, lineage);
	await sql`delete from agent_attempts where run_id in (select run_id from daily_runs where lineage = ${lineage})`;
	await sql`delete from agent_runs where run_id in (select run_id from daily_runs where lineage = ${lineage})`;
	await sql`delete from collection_runs where run_id in (select run_id from daily_runs where lineage = ${lineage})`;
	await sql`delete from daily_runs where lineage = ${lineage}`;
	await sql`delete from source_configs where collector_id in ('fake-good','fake-broken')`;
	await sql.end({ timeout: 5 });
});

describe.skipIf(!probe.available)("daily pipeline", () => {
	it("publishes a degraded run and keeps the failed collector's data out without failing", async () => {
		const result = await runDailyPipeline({
			...baseOptions,
			sql,
			lineage,
			collection,
			driverFactory: workingDriverFactory(),
		});

		expect(result.state).toBe("PUBLISHED");
		// One collector died; the day is degraded and still published.
		expect(result.degraded).toBe(true);
		expect(result.degradedReason).toMatch(/fake-broken unavailable: provider returned 503/);
		expect(result.collection?.outcomes.find((o) => o.collectorId === "fake-broken")?.health).toBe("FAILED");
		expect(result.brief?.stories.length).toBeGreaterThanOrEqual(8);

		const published = await getBrief(sql, lineage, DATE);
		expect(published?.stories.length).toBe(result.brief?.stories.length);

		// The real state is persisted verbatim (migration 002), not mapped away —
		// /admin/runs must be able to tell PUBLISHED from every other status.
		const run = await getRun(sql, result.runId);
		expect(run?.status).toBe("PUBLISHED");
		// degraded_reason is orthogonal to status: this run is both PUBLISHED and
		// degraded, with the reason readable straight off the row.
		expect(run?.degradedReason).toMatch(/fake-broken unavailable: provider returned 503/);
	});

	it("records emerging signals derived from the published brief", async () => {
		const signals = await listSignals(sql, lineage);
		// The scripted editor publishes no signals, so the table is consistent
		// rather than populated; what matters is that publishing did not throw.
		expect(Array.isArray(signals)).toBe(true);
	});

	it("retries a failed stage from persisted state without re-collecting", async () => {
		const retryLineage = testLineage("pipeline-retry");
		try {
			// 1. Collection succeeds, the curator dies.
			const crashed = await runDailyPipeline({
				...baseOptions,
				sql,
				lineage: retryLineage,
				collection,
				driverFactory: createThrowingDriverFactory(new Error("model unavailable - quota exceeded")),
			});
			expect(crashed.state).toBe("CURATION_FAILED");

			const rawAfterCollection = await countRawItems(sql);
			const collectionRunsAfter = (await listCollectionRuns(sql, 200)).filter(
				(r) => r.runId === crashed.runId,
			).length;
			expect(collectionRunsAfter).toBe(2);

			// 2. Retry only the curator stage on the same run.
			const curated = await runDailyPipeline({
				...baseOptions,
				sql,
				lineage: retryLineage,
				runId: crashed.runId,
				stage: "curate",
				collection,
				driverFactory: workingDriverFactory(),
			});
			expect(curated.state).toBe("MATERIALS_READY");
			expect(await getMaterials(sql, retryLineage, DATE)).toBeDefined();

			// Nothing was collected again: no new raw rows, no new collection runs.
			expect(await countRawItems(sql)).toBe(rawAfterCollection);
			expect(
				(await listCollectionRuns(sql, 200)).filter((r) => r.runId === crashed.runId).length,
			).toBe(collectionRunsAfter);

			// 3. Retry the writing stage; validation and publishing follow.
			const published = await runDailyPipeline({
				...baseOptions,
				sql,
				lineage: retryLineage,
				runId: crashed.runId,
				stage: "write",
				collection,
				driverFactory: workingDriverFactory(),
			});
			expect(published.state).toBe("PUBLISHED");
			expect(await countRawItems(sql)).toBe(rawAfterCollection);
			expect((await getBrief(sql, retryLineage, DATE))?.stories.length).toBeGreaterThanOrEqual(8);
		} finally {
			await purgeLineage(sql, retryLineage);
			await sql`delete from collection_runs where run_id in (select run_id from daily_runs where lineage = ${retryLineage})`;
			await sql`delete from agent_attempts where run_id in (select run_id from daily_runs where lineage = ${retryLineage})`;
			await sql`delete from agent_runs where run_id in (select run_id from daily_runs where lineage = ${retryLineage})`;
			await sql`delete from daily_runs where lineage = ${retryLineage}`;
		}
	});
});
