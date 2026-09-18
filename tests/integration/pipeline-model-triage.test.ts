import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CollectedItem, Collector, CollectorResult } from "../../src/collectors/types.ts";
import { createSql, type Sql } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import {
	announceSkip,
	probeDatabase,
	purgeIssuedLineages,
	testLineage,
} from "../../src/db/test-support.ts";
import { runDailyPipeline } from "../../src/pipeline/daily-run.ts";
import type { RegistryEntry } from "../../src/pipeline/collection.ts";
import { MODEL_CHAIN } from "../../src/runtime/model-config.ts";
import {
	REPO_ROOT,
	competentCuratorScript,
	competentEditorScript,
	createResolvedDriverFactory,
} from "../support/fake-agent.ts";

const probe = await probeDatabase();
announceSkip("pipeline-model-triage", probe);

const DATE = "2026-09-13";
const NOW = new Date("2026-09-13T07:00:00.000Z");
const SKILLS_ROOT = join(REPO_ROOT, "agent", "skills");

/*
 * The shadow model-triage pass, exercised through the real pipeline.
 *
 * The classifier has its own unit tests; what those cannot reach is the wiring:
 * that the pass actually runs inside a day, that its rows land under their own
 * rulesVersion beside the deterministic ones instead of overwriting them, that
 * the run still publishes while it is in flight, and -- the one that would be
 * silent and expensive to get wrong -- that a run never returns before the
 * writes it started have finished. The pipeline's caller ends the sql connection
 * on return; a saveTriage still in flight at that moment fails on a closed pool
 * and loses the day's shadow data without saying so.
 */

function syntheticItems(): CollectedItem[] {
	const items: CollectedItem[] = [];
	for (let g = 1; g <= 10; g++) {
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

const collection = {
	entries: [{ sourceKey: "fake-good", collector: goodCollector() }] as RegistryEntry[],
	enabledSourceKeys: ["fake-good"],
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
const realFetch = globalThis.fetch;
let priorKey: string | undefined;

/**
 * Answers the chat-completions endpoint and nothing else.
 *
 * Everything that is not the triage endpoint is handed to the real fetch, so a
 * stub meant for one call cannot quietly become the transport for the rest of
 * the pipeline.
 */
function stubTriageEndpoint(handler: (body: string) => Response): void {
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!url.includes("/chat/completions")) return realFetch(input, init);
		return handler(String(init?.body ?? ""));
	}) as typeof fetch;
}

function verdictsFor(requestBody: string, category: string): Response {
	const body = JSON.parse(requestBody) as { messages: Array<{ content: string }> };
	const ids = [...String(body.messages[1]?.content).matchAll(/itemId: (\S+)/g)].map((m) => m[1]);
	return new Response(
		JSON.stringify({
			choices: [
				{
					message: {
						content: JSON.stringify({
							verdicts: ids.map((id) => ({ itemId: id, category, reason: "stubbed" })),
						}),
					},
				},
			],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

async function triageRows(lineage: string): Promise<{ rules_version: string; n: number }[]> {
	return await sql<{ rules_version: string; n: number }[]>`
		select rules_version, count(*)::int as n
		from item_triage where lineage = ${lineage} and date = ${DATE}
		group by rules_version order by rules_version
	`;
}

beforeAll(async () => {
	if (!probe.available) return;
	sql = createSql();
	await migrate(sql);
	// The pass resolves its key through env first, so this reaches it without
	// touching the Keychain or the operator's secrets file.
	priorKey = process.env["OPENAI_API_KEY"];
	process.env["OPENAI_API_KEY"] = "test-key-not-a-real-credential";
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

afterAll(async () => {
	if (!probe.available) return;
	if (priorKey === undefined) delete process.env["OPENAI_API_KEY"];
	else process.env["OPENAI_API_KEY"] = priorKey;
	await purgeIssuedLineages(sql);
	await sql`delete from source_configs where collector_id = 'fake-good'`;
	await sql.end({ timeout: 5 });
});

describe.skipIf(!probe.available)("shadow model triage inside a real run", () => {
	it("records its own rows beside the deterministic ones, and still publishes", async () => {
		const lineage = testLineage("model-triage-ok");
		stubTriageEndpoint((body) => verdictsFor(body, "NORMAL"));

		const result = await runDailyPipeline({
			...baseOptions,
			sql,
			lineage,
			collection,
			driverFactory: workingDriverFactory(),
		});

		expect(result.state).toBe("PUBLISHED");

		// Both passes, side by side. Before migration 011 the second write would
		// have overwritten the first on conflict and destroyed the baseline the
		// model pass has to be judged against.
		const rows = await triageRows(lineage);
		expect(rows.map((r) => r.rules_version).sort()).toEqual(["deterministic-v1", "model-v1"]);
		expect(rows[0]?.n).toBe(rows[1]?.n);
		expect(rows[0]?.n).toBeGreaterThan(0);
	});

	it("has finished writing by the time the run returns", async () => {
		// The pass is started before curation and joined in finish(). If it were
		// merely fired and forgotten, these rows would still be in flight here --
		// and in production the caller would have closed the pool underneath them.
		const lineage = testLineage("model-triage-join");
		stubTriageEndpoint((body) => verdictsFor(body, "PRIORITY"));

		const result = await runDailyPipeline({
			...baseOptions,
			sql,
			lineage,
			collection,
			driverFactory: workingDriverFactory(),
		});

		expect(result.state).toBe("PUBLISHED");
		// Read immediately, with no settling delay of any kind.
		const rows = await sql<{ n: number }[]>`
			select count(*)::int as n from item_triage
			where lineage = ${lineage} and date = ${DATE} and rules_version = 'model-v1'
		`;
		expect(rows[0]?.n).toBeGreaterThan(0);
	});

	it("publishes the day unchanged when every batch fails, and records nothing", async () => {
		// The measurement talks to a third party and costs money: two more ways for
		// something the run does not depend on to take the run down. A pass where
		// nothing succeeded is an outage, not an opinion, so it must leave no rows
		// -- a table full of placeholder UNCERTAINs would read as a model that had
		// judged the day and found it unreadable.
		const lineage = testLineage("model-triage-down");
		stubTriageEndpoint(() => new Response("upstream is down", { status: 503 }));

		const result = await runDailyPipeline({
			...baseOptions,
			sql,
			lineage,
			collection,
			driverFactory: workingDriverFactory(),
		});

		expect(result.state).toBe("PUBLISHED");
		expect(result.degraded).toBe(false);

		const rows = await triageRows(lineage);
		expect(rows.map((r) => r.rules_version)).toEqual(["deterministic-v1"]);
	});
});
