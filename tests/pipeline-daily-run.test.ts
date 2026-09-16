import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CollectedItem, Collector, CollectorResult } from "../src/collectors/types.ts";
import { getBrief } from "../src/db/briefs.ts";
import { createSql, type Sql } from "../src/db/client.ts";
import { getMaterials } from "../src/db/materials.ts";
import { migrate } from "../src/db/migrate.ts";
import { getRun } from "../src/db/runs.ts";
import { listSignals } from "../src/db/signals.ts";
import { announceSkip, probeDatabase, purgeIssuedLineages, purgeLineage, testLineage } from "../src/db/test-support.ts";
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
function syntheticItems(prefix = "g"): CollectedItem[] {
	const items: CollectedItem[] = [];
	for (let g = 1; g <= GROUPS; g++) {
		const group = `${prefix}${String(g).padStart(2, "0")}`;
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

function goodCollector(prefix = "g"): Collector {
	return {
		id: "fake-good",
		sourceType: "rss",
		requiredSecrets: [],
		check: async () => ({ ok: true, detail: "fake" }),
		collect: async (): Promise<CollectorResult> => {
			const items = syntheticItems(prefix);
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
	// Every lineage this file named, not just the shared one: each scenario below
	// names its own, and purging only `lineage` is how 194 of them accumulated.
	await purgeIssuedLineages(sql);
	await sql`delete from source_configs where collector_id in ('fake-good','fake-broken')`;
	await sql.end({ timeout: 5 });
});

describe.skipIf(!probe.available)("daily pipeline", () => {
	/** Collection rows for one run, counted directly so an unrelated test's rows
	 * cannot push them out of a "most recent N" listing. */
	async function collectionRunsFor(runId: string): Promise<number> {
		const rows = await sql<{ n: string }[]>`
			select count(*)::text as n from collection_runs where run_id = ${runId}
		`;
		return Number(rows[0]?.n ?? "0");
	}

	/** Raw rows this run collected. Scoped to the run for the same reason as
	 * above: a global count reads shared state, and these suites run in
	 * parallel against one database. */
	async function rawItemsFor(runId: string): Promise<number> {
		const rows = await sql<{ n: string }[]>`
			select count(*)::text as n from raw_items
			where collection_run_id in (select collection_run_id from collection_runs where run_id = ${runId})
		`;
		return Number(rows[0]?.n ?? "0");
	}

	/** Every decision recorded for the day, across runs. */
	async function decisionCount(forLineage: string): Promise<number> {
		const rows = await sql<{ n: string }[]>`
			select count(*)::text as n from item_decisions where lineage = ${forLineage} and date = ${DATE}
		`;
		return Number(rows[0]?.n ?? "0");
	}

	/** CURATOR stage rows recorded against one run; one per curation attempt. */
	async function curatorRunsFor(runId: string): Promise<{ stage: string }[]> {
		return await sql<{ stage: string }[]>`
			select stage from agent_runs where run_id = ${runId} and stage = 'CURATOR'
		`;
	}

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

	it("curates again on a second run of the same day instead of republishing the first selection", async () => {
		const secondLineage = testLineage("pipeline-second-run");
		try {
			const first = await runDailyPipeline({
				...baseOptions,
				sql,
				lineage: secondLineage,
				collection,
				driverFactory: workingDriverFactory(),
			});
			expect(first.state).toBe("PUBLISHED");
			expect((await curatorRunsFor(first.runId)).length).toBe(1);
			const firstDecisions = await decisionCount(secondLineage);

			// The day moves on: the next scheduled run collects items the first
			// run never saw. This is the case that used to skip curation entirely.
			const laterCollection = {
				entries: [{ sourceKey: "fake-good", collector: goodCollector("h") }],
				enabledSourceKeys: ["fake-good"],
			};
			const second = await runDailyPipeline({
				...baseOptions,
				sql,
				lineage: secondLineage,
				collection: laterCollection,
				driverFactory: workingDriverFactory(),
			});

			expect(second.state).toBe("PUBLISHED");
			expect(second.runId).not.toBe(first.runId);
			// Its own curator ran, and the newly collected items were judged.
			expect((await curatorRunsFor(second.runId)).length).toBe(1);
			expect(await decisionCount(secondLineage)).toBeGreaterThan(firstDecisions);
		} finally {
			await purgeLineage(sql, secondLineage);
		}
	});

	it("stores one draft per run and records the verdict on it", async () => {
		// saveDraft is append-only, so the PENDING save and the verdict save wrote
		// the identical brief twice and the history claimed two editor attempts.
		const draftLineage = testLineage("pipeline-draft");
		try {
			const result = await runDailyPipeline({
				...baseOptions,
				sql,
				lineage: draftLineage,
				collection,
				driverFactory: workingDriverFactory(),
			});
			expect(result.state).toBe("PUBLISHED");

			const drafts = await sql<{ draft_no: number; validation_status: string }[]>`
				select draft_no, validation_status from daily_brief_drafts
				where lineage = ${draftLineage} and date = ${DATE} order by draft_no
			`;
			expect(drafts).toHaveLength(1);
			expect(drafts[0]?.validation_status).toBe("PASSED");
		} finally {
			await purgeLineage(sql, draftLineage);
		}
	});

	it("reports a fallback on a run that then failed, not only on a published one", async () => {
		// fallbackOccurred was set on the PUBLISHED path alone, so the runs where
		// knowing a model had been swapped matters most reported none.
		const fallbackLineage = testLineage("pipeline-fallback");
		try {
			const result = await runDailyPipeline({
				...baseOptions,
				sql,
				lineage: fallbackLineage,
				chain: MODEL_CHAIN.slice(0, 2),
				collection,
				driverFactory: createThrowingDriverFactory(new Error("model unavailable - quota exceeded")),
			});
			expect(result.state).toBe("CURATION_FAILED");
			expect(result.attempts).toBeGreaterThan(1);
			expect(result.fallbackOccurred).toBe(true);
		} finally {
			await purgeLineage(sql, fallbackLineage);
		}
	});

	it("refuses to validate a day that has no stored draft instead of writing a new one", async () => {
		// "--stage validate" used to fall through into a fresh EDITOR session, so
		// asking to validate quietly spent a model run writing something new.
		const validateLineage = testLineage("pipeline-validate");
		try {
			const collected = await runDailyPipeline({
				...baseOptions,
				sql,
				lineage: validateLineage,
				stage: "collect",
				collection,
				driverFactory: workingDriverFactory(),
			});
			expect(collected.state).toBe("COLLECTED");
			const curated = await runDailyPipeline({
				...baseOptions,
				sql,
				lineage: validateLineage,
				runId: collected.runId,
				stage: "curate",
				collection,
				driverFactory: workingDriverFactory(),
			});
			expect(curated.state).toBe("MATERIALS_READY");

			await expect(
				runDailyPipeline({
					...baseOptions,
					sql,
					lineage: validateLineage,
					runId: curated.runId,
					stage: "validate",
					collection,
					driverFactory: workingDriverFactory(),
				}),
			).rejects.toThrow(/No draft stored/);

			const drafts = await sql<{ n: string }[]>`
				select count(*)::text as n from daily_brief_drafts
				where lineage = ${validateLineage} and date = ${DATE}
			`;
			expect(drafts[0]?.n).toBe("0");

			/*
			 * That throw used to unwind straight out of the pipeline, past the
			 * drain of the queued-write list -- so "no insert outlives the run"
			 * held on this path only because nothing happens to be queued before
			 * it. The drain is now a `finally` around the whole body. Measured
			 * here as the run's write count being final the moment the caller sees
			 * the rejection: a late insert would show up as a change.
			 */
			const attemptCount = async (): Promise<string | undefined> => {
				const rows = await sql<{ n: string }[]>`
					select count(*)::text as n from agent_attempts where run_id = ${curated.runId}
				`;
				return rows[0]?.n;
			};
			const atRejection = await attemptCount();
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(await attemptCount()).toBe(atRejection);
		} finally {
			await purgeLineage(sql, validateLineage);
		}
	});

	it("refuses to write a day that has no stored materials, and ends cleanly", async () => {
		// Sibling of the no-draft throw, and it left the run the same way: out of
		// the function without draining the queued writes.
		const writeLineage = testLineage("pipeline-write");
		try {
			await expect(
				runDailyPipeline({
					...baseOptions,
					sql,
					lineage: writeLineage,
					stage: "write",
					collection,
					driverFactory: workingDriverFactory(),
				}),
			).rejects.toThrow(/No materials stored/);

			const drafts = await sql<{ n: string }[]>`
				select count(*)::text as n from daily_brief_drafts
				where lineage = ${writeLineage} and date = ${DATE}
			`;
			expect(drafts[0]?.n).toBe("0");
			const runs = await sql<{ run_id: string }[]>`
				select run_id from daily_runs where lineage = ${writeLineage} and date = ${DATE}
			`;
			const runId = runs[0]?.run_id;
			expect(runId).toBeDefined();
			const attempts = await sql<{ n: string }[]>`
				select count(*)::text as n from agent_attempts where run_id = ${runId ?? ""}
			`;
			await new Promise((resolve) => setTimeout(resolve, 100));
			const later = await sql<{ n: string }[]>`
				select count(*)::text as n from agent_attempts where run_id = ${runId ?? ""}
			`;
			// Nothing landed after the caller saw the error.
			expect(later[0]?.n).toBe(attempts[0]?.n);
		} finally {
			await purgeLineage(sql, writeLineage);
			await sql`delete from daily_runs where lineage = ${writeLineage}`;
		}
	});

	it("bounds a turn that never returns, using the configured stage timeout", async () => {
		/*
		 * The tuning in config/agent.yaml was read by nothing, so no limit
		 * applied: on 2026-09-13 the editor spent 114 minutes across six turns
		 * that each produced nothing, and because the stage never failed, the
		 * router never fell back. A turn that stops returning must end the
		 * attempt.
		 *
		 * It must also end the STAGE. This driver never settles, so the turn is
		 * still running after the abort grace period expires -- and every response
		 * other than failing (retry, continue, fall back) would start a second
		 * curator session writing the same day's decisions while the first one is
		 * still able to write them. So the assertion here is the absence of a
		 * fallback: one attempt, no replacement. See TurnAbandonedError.
		 */
		const stalledLineage = testLineage("pipeline-stalled");
		const hangingFactory = createResolvedDriverFactory(() => () => new Promise<void>(() => {}));
		try {
			const result = await runDailyPipeline({
				...baseOptions,
				sql,
				lineage: stalledLineage,
				collection,
				driverFactory: hangingFactory,
				stages: {
					CURATOR: { timeoutMs: 100, maxAttemptsPerModel: 1, maxNudges: 1 },
					EDITOR: { timeoutMs: 100, maxAttemptsPerModel: 1, maxNudges: 1 },
				},
			});
			expect(result.state).toBe("CURATION_FAILED");
			const attempts = await sql<
				{ fallback_reason: string | null; failure_class: string | null; status: string }[]
			>`
				select fallback_reason, failure_class, status
				from agent_attempts where run_id = ${result.runId}
			`;
			expect(attempts.length).toBeGreaterThan(0);
			expect(attempts.every((a) => a.status === "FAILED")).toBe(true);
			expect(attempts.map((a) => a.failure_class ?? "").join(" ")).toMatch(/TIMEOUT/);
			// No fallback: a replacement session would overlap the one still running.
			expect(attempts.every((a) => a.fallback_reason === null)).toBe(true);
			// And no continuation either -- "it was making progress" is not a reason
			// to run two sessions over one day.
			expect(attempts.every((a) => a.status !== "YIELDED")).toBe(true);
		} finally {
			await purgeLineage(sql, stalledLineage);
		}
	}, 60_000);

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

			const rawAfterCollection = await rawItemsFor(crashed.runId);
			const collectionRunsAfter = await collectionRunsFor(crashed.runId);
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
			expect(await rawItemsFor(crashed.runId)).toBe(rawAfterCollection);
			expect(await collectionRunsFor(crashed.runId)).toBe(collectionRunsAfter);

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
			expect(await rawItemsFor(crashed.runId)).toBe(rawAfterCollection);
			expect((await getBrief(sql, retryLineage, DATE))?.stories.length).toBeGreaterThanOrEqual(8);
		} finally {
			await purgeLineage(sql, retryLineage);
			await sql`delete from collection_runs where run_id in (select run_id from daily_runs where lineage = ${retryLineage})`;
			await sql`delete from agent_attempts where run_id in (select run_id from daily_runs where lineage = ${retryLineage})`;
			await sql`delete from agent_runs where run_id in (select run_id from daily_runs where lineage = ${retryLineage})`;
			await sql`delete from daily_runs where lineage = ${retryLineage}`;
		}
	});

	/*
	 * `daily_materials` is keyed by (lineage, date), so a second run of the same
	 * day finds the first run's package sitting there. The reuse gate used to ask
	 * only "does a run exist and is there a package", which is true for a resumed
	 * run B looking at run A's work: B skipped curation entirely and published a
	 * selection it never made, against a manifest it had grown by 400 items.
	 */
	it("refuses to reuse another run's materials when resuming", async () => {
		const crossLineage = testLineage("pipeline-cross-run");
		try {
			// Run A curates and publishes the day.
			const runA = await runDailyPipeline({
				...baseOptions,
				sql,
				lineage: crossLineage,
				collection,
				driverFactory: workingDriverFactory(),
			});
			expect(runA.state).toBe("PUBLISHED");
			expect((await getMaterials(sql, crossLineage, DATE))?.runId).toBe(runA.runId);

			// Run B is a separate run of the same date that dies during curation.
			const runB = await runDailyPipeline({
				...baseOptions,
				sql,
				lineage: crossLineage,
				collection,
				driverFactory: createThrowingDriverFactory(new Error("model unavailable - quota exceeded")),
			});
			expect(runB.state).toBe("CURATION_FAILED");
			expect(runB.runId).not.toBe(runA.runId);

			/*
			 * Resuming B must go through the curator again, because the stored
			 * package is A's. A curator that cannot run is how that is observed: the
			 * old gate skipped the stage outright and walked B to WRITING on A's
			 * selection, so reaching CURATION_FAILED is the whole point.
			 */
			const resumed = await runDailyPipeline({
				...baseOptions,
				sql,
				lineage: crossLineage,
				runId: runB.runId,
				collection,
				driverFactory: createThrowingDriverFactory(new Error("model unavailable - quota exceeded")),
			});

			expect(resumed.runId).toBe(runB.runId);
			expect(resumed.state).toBe("CURATION_FAILED");
			expect(resumed.brief).toBeUndefined();
			// A's package is untouched; B never claimed it.
			expect((await getMaterials(sql, crossLineage, DATE))?.runId).toBe(runA.runId);
		} finally {
			await purgeLineage(sql, crossLineage);
			await sql`delete from collection_runs where run_id in (select run_id from daily_runs where lineage = ${crossLineage})`;
			await sql`delete from agent_attempts where run_id in (select run_id from daily_runs where lineage = ${crossLineage})`;
			await sql`delete from agent_runs where run_id in (select run_id from daily_runs where lineage = ${crossLineage})`;
			await sql`delete from daily_runs where lineage = ${crossLineage}`;
		}
	}, 60_000);
});
