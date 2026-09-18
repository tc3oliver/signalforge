import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CollectedItem, Collector, CollectorResult } from "../../src/collectors/types.ts";
import { ScreeningConfig } from "../../src/config/schema.ts";
import { createCuratorTools } from "../../src/curator/tools.ts";
import { createSql, type Sql } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { saveScreening } from "../../src/db/screening.ts";
import {
	announceSkip,
	probeDatabase,
	purgeIssuedLineages,
	testLineage,
} from "../../src/db/test-support.ts";
import { fetchScreeningOutcomes, fetchScreeningVersions } from "../../src/observation/queries.ts";
import { buildScreeningFunnel } from "../../src/observation/screening-funnel.ts";
import { runDailyPipeline } from "../../src/pipeline/daily-run.ts";
import type { RegistryEntry } from "../../src/pipeline/collection.ts";
import { MODEL_CHAIN } from "../../src/runtime/model-config.ts";
import { JsonStoryRepository } from "../../src/stories/json-repository.ts";
import {
	REPO_ROOT,
	competentCuratorScript,
	competentEditorScript,
	createResolvedDriverFactory,
	makeManifest,
} from "../support/fake-agent.ts";

const probe = await probeDatabase();
announceSkip("pipeline-screening", probe);

const DATE = "2026-09-13";
const NOW = new Date("2026-09-13T07:00:00.000Z");
const SKILLS_ROOT = join(REPO_ROOT, "agent", "skills");

/*
 * The screening stage through the real pipeline: what it writes, what it
 * withholds, what it can never withhold, and how it fails open.
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

/** Curator and editor scripted against the real tools; `pages` collects every list_unseen_items page. */
function workingDriverFactory(pages: string[][] = []) {
	return createResolvedDriverFactory((opts) =>
		opts.customTools.some((t) => t.name === "submit_brief")
			? competentEditorScript()
			: competentCuratorScript({ onPage: (ids) => pages.push(ids) }),
	);
}

const MODEL = "test-screener";
const POLICY = "screening-v1";

function screeningConfig(over: Record<string, unknown> = {}): ScreeningConfig {
	return ScreeningConfig.parse({
		mode: "shadow",
		provider: "openai",
		baseUrl: "https://screener.invalid/v1",
		model: MODEL,
		policyVersion: POLICY,
		batchSize: 7,
		concurrency: 3,
		timeoutMs: 5_000,
		maxWallClockMs: 20_000,
		auditDropSampleRate: 0,
		...over,
	});
}

const routeConfig = (over: Record<string, unknown> = {}) =>
	screeningConfig({
		mode: "route",
		routing: { trustedModel: MODEL, trustedPolicyVersion: POLICY },
		...over,
	});

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

/** The items of one screening request, as the screener rendered them. */
function itemsIn(requestBody: string): Array<{ id: string; title: string }> {
	const body = JSON.parse(requestBody) as { messages: Array<{ content: string }> };
	return String(body.messages[1]?.content)
		.split("\n---\n")
		.map((block) => ({
			id: /^id: (\S+)$/m.exec(block)?.[1] ?? "",
			title: /^title: (.*)$/m.exec(block)?.[1] ?? "",
		}));
}

type Verdict = "DROP" | "KEEP" | "UNSURE" | null;

/**
 * Answers the chat-completions endpoint and nothing else. `decide` returns the
 * verdict for an item, or null to leave it out of the response (unscreened).
 */
function stubScreener(
	decide: (item: { id: string; title: string }) => Verdict,
	options: { usage?: boolean; status?: number } = {},
): void {
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!url.includes("/chat/completions")) return realFetch(input, init);
		if (options.status) return new Response("down", { status: options.status });
		const decisions = itemsIn(String(init?.body ?? ""))
			.map((item) => ({ item, verdict: decide(item) }))
			.filter((d): d is { item: { id: string; title: string }; verdict: Exclude<Verdict, null> } => d.verdict !== null)
			.map((d) => ({
				id: d.item.id,
				verdict: d.verdict,
				reasonCode: d.verdict === "DROP" ? "OFF_TOPIC" : d.verdict === "KEEP" ? "TRACKED_AREA" : "CANNOT_TELL",
				reason: "stubbed",
			}));
		return new Response(
			JSON.stringify({
				choices: [{ message: { content: JSON.stringify({ decisions }) } }],
				...(options.usage ? { usage: { prompt_tokens: 500, completion_tokens: 50, total_tokens: 550 } } : {}),
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as typeof fetch;
}

/** "coverage 2" of g01..g05 is what the stubs drop; g10 is what they leave unscreened. */
const dropTitle = (title: string) => /^g0[1-5] coverage 2/.test(title);
const unscreenedTitle = (title: string) => title.startsWith("g10 ");
const defaultDecide = (item: { id: string; title: string }): Verdict =>
	unscreenedTitle(item.title) ? null : dropTitle(item.title) ? "DROP" : item.title.includes("g09") ? "UNSURE" : "KEEP";

async function screeningRows(lineage: string) {
	return await sql<
		{ item_id: string; verdict: string; routed: boolean; audit_sampled: boolean; run_id: string | null }[]
	>`
		select item_id, verdict, routed, audit_sampled, run_id from item_screening
		where lineage = ${lineage} and date = ${DATE} and model = ${MODEL} and policy_version = ${POLICY}
		order by item_id
	`;
}

async function decidedIds(lineage: string): Promise<Set<string>> {
	const rows = await sql<{ item_id: string }[]>`
		select item_id from item_decisions where lineage = ${lineage} and date = ${DATE}
	`;
	return new Set(rows.map((r) => r.item_id));
}

async function manifestIds(lineage: string): Promise<string[]> {
	const rows = await sql<{ item_id: string }[]>`
		select item_id from normalized_items where lineage = ${lineage} order by item_id
	`;
	return rows.map((r) => r.item_id);
}

async function titleOf(lineage: string, itemId: string): Promise<string> {
	const rows = await sql<{ title: string }[]>`
		select title from normalized_items where lineage = ${lineage} and item_id = ${itemId}
	`;
	return rows[0]?.title ?? "";
}

async function materialStoryIds(lineage: string): Promise<string[]> {
	const rows = await sql<{ story_id: string }[]>`
		select story_id from daily_material_stories where lineage = ${lineage} and date = ${DATE} order by story_id
	`;
	return rows.map((r) => r.story_id);
}

async function screenerTelemetry(runId: string) {
	const runs = await sql<{ stage: string; status: string; model: string | null }[]>`
		select stage, status, model from agent_runs where run_id = ${runId} and stage = 'SCREENER'
	`;
	const attempts = await sql<{ status: string; token_usage: Record<string, number> | null; error_meta: Record<string, unknown> }[]>`
		select status, token_usage, error_meta from agent_attempts where run_id = ${runId} and stage = 'SCREENER'
	`;
	return { runs, attempts };
}

beforeAll(async () => {
	if (!probe.available) return;
	sql = createSql();
	await migrate(sql);
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

describe.skipIf(!probe.available)("shadow mode", () => {
	it("screens every item, changes nothing, and records telemetry with usage", async () => {
		const lineage = testLineage("screen-shadow");
		stubScreener(() => "DROP", { usage: true });
		const pages: string[][] = [];

		const result = await runDailyPipeline({
			...baseOptions,
			sql,
			lineage,
			collection,
			screening: screeningConfig(),
			driverFactory: workingDriverFactory(pages),
		});
		expect(result.state).toBe("PUBLISHED");
		expect(result.degraded).toBe(false);

		// Every manifest item still reached the Curator, DROP or not.
		const ids = await manifestIds(lineage);
		expect(ids).toHaveLength(20);
		expect(await decidedIds(lineage)).toEqual(new Set(ids));
		expect(new Set(pages.flat())).toEqual(new Set(ids));

		const rows = await screeningRows(lineage);
		expect(rows).toHaveLength(20);
		expect(rows.every((r) => r.verdict === "DROP" && r.routed === false)).toBe(true);
		expect(rows.every((r) => r.run_id === result.runId)).toBe(true);

		const { runs, attempts } = await screenerTelemetry(result.runId);
		expect(runs).toEqual([{ stage: "SCREENER", status: "SUCCESS", model: MODEL }]);
		expect(attempts).toHaveLength(1);
		// Three batches of 7, each reporting 500/50.
		expect(attempts[0]?.token_usage).toEqual({
			input: 1500,
			output: 150,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1650,
			reportedBy: 3,
		});
		expect(attempts[0]?.error_meta).toMatchObject({ effectiveMode: "shadow", screened: 20, withheld: 0, DROP: 20 });
	});

	it("produces the same materials as a run with screening off", async () => {
		const withScreening = testLineage("screen-shadow-same");
		stubScreener(() => "DROP");
		const a = await runDailyPipeline({
			...baseOptions,
			sql,
			lineage: withScreening,
			collection,
			screening: screeningConfig(),
			driverFactory: workingDriverFactory(),
		});
		globalThis.fetch = realFetch;

		const without = testLineage("screen-off");
		const b = await runDailyPipeline({
			...baseOptions,
			sql,
			lineage: without,
			collection,
			screening: screeningConfig({ mode: "off" }),
			driverFactory: workingDriverFactory(),
		});
		expect(a.state).toBe("PUBLISHED");
		expect(b.state).toBe("PUBLISHED");
		expect(await materialStoryIds(withScreening)).toEqual(await materialStoryIds(without));
		expect(await screeningRows(without)).toEqual([]);
	});

	it("records no usage when the provider reports none", async () => {
		const lineage = testLineage("screen-shadow-nousage");
		stubScreener(() => "KEEP");
		const result = await runDailyPipeline({
			...baseOptions,
			sql,
			lineage,
			collection,
			screening: screeningConfig(),
			driverFactory: workingDriverFactory(),
		});
		const { attempts } = await screenerTelemetry(result.runId);
		expect(attempts[0]?.status).toBe("SUCCESS");
		expect(attempts[0]?.token_usage).toBeNull();
	});
});

describe.skipIf(!probe.available)("route mode", () => {
	it("withholds trusted DROPs from the default scan and offers everything else", async () => {
		const lineage = testLineage("screen-route");
		stubScreener(defaultDecide);
		const pages: string[][] = [];

		const result = await runDailyPipeline({
			...baseOptions,
			sql,
			lineage,
			collection,
			screening: routeConfig(),
			driverFactory: workingDriverFactory(pages),
		});
		expect(result.state).toBe("PUBLISHED");
		expect(result.degraded).toBe(false);

		const ids = await manifestIds(lineage);
		const titles = new Map(await Promise.all(ids.map(async (id) => [id, await titleOf(lineage, id)] as const)));
		const dropped = ids.filter((id) => dropTitle(titles.get(id)!));
		const unscreened = ids.filter((id) => unscreenedTitle(titles.get(id)!));
		const offered = ids.filter((id) => !dropped.includes(id));
		expect(dropped).toHaveLength(5);
		expect(unscreened).toHaveLength(2);

		// Never offered, never decided, and the row says why.
		const seen = new Set(pages.flat());
		for (const id of dropped) expect(seen.has(id)).toBe(false);
		const decided = await decidedIds(lineage);
		for (const id of dropped) expect(decided.has(id)).toBe(false);
		// KEEP, UNSURE and unscreened items all reached the Curator.
		expect(seen).toEqual(new Set(offered));
		expect(decided).toEqual(new Set(offered));

		const rows = await screeningRows(lineage);
		expect(rows).toHaveLength(18);
		for (const r of rows) expect(r.routed).toBe(dropped.includes(r.item_id));
		expect(rows.some((r) => r.verdict === "UNSURE")).toBe(true);
		for (const id of unscreened) expect(rows.find((r) => r.item_id === id)).toBeUndefined();

		const { attempts } = await screenerTelemetry(result.runId);
		expect(attempts[0]?.error_meta).toMatchObject({ effectiveMode: "route", withheld: 5, unscreened: 2 });

		// The observation side reads the same rows back.
		const funnel = buildScreeningFunnel(DATE, await fetchScreeningOutcomes(sql, lineage, DATE, { model: MODEL, policyVersion: POLICY }));
		expect(funnel.byVerdict.DROP).toBe(5);
		expect(funnel.dropEvaluated).toBe(0);
		expect(funnel.rescued).toBe(0);
		expect(funnel.undecidedOffered).toBe(0);
	});

	it("never sends a watched-repository (GitHub) item to the model, and always offers it", async () => {
		// Every GitHub item comes from the watchlist -- the collector polls nothing
		// else -- so its verdict is a fact of configuration, not a model opinion.
		// The v2 backtest dropped three sst/opencode issues that formed a Must Know
		// story; this pins that no stub verdict, not even "DROP everything", can.
		const lineage = testLineage("screen-github");
		const githubItem: CollectedItem = {
			...syntheticItems()[0]!,
			sourceType: "github",
			sourceName: "GitHub",
			externalId: "watched-repo-issue",
			title: "g11 watched repo: layout regression reported",
			url: "https://example.invalid/g11/issue",
			metadata: { repo: "sst/opencode", kind: "issue" },
			raw: { externalId: "watched-repo-issue", body: {}, fetchedAt: `${DATE}T06:00:00.000Z` },
		};
		const collector: Collector = {
			...goodCollector(),
			id: "fake-github",
			collect: async () => {
				const items = [...syntheticItems(), githubItem];
				return {
					collectorId: "fake-github",
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
		const sentToModel: string[] = [];
		stubScreener((item) => {
			sentToModel.push(item.title);
			return "DROP";
		});
		const pages: string[][] = [];

		const result = await runDailyPipeline({
			...baseOptions,
			sql,
			lineage,
			collection: {
				entries: [{ sourceKey: "fake-github", collector }] as RegistryEntry[],
				enabledSourceKeys: ["fake-github"],
			},
			screening: routeConfig({ auditDropSampleRate: 0 }),
			driverFactory: workingDriverFactory(pages),
		});
		expect(result.state).toBe("PUBLISHED");

		const ids = await manifestIds(lineage);
		const githubId = (await Promise.all(ids.map(async (id) => [id, await titleOf(lineage, id)] as const)))
			.find(([, title]) => title.startsWith("g11 "))?.[0];
		expect(githubId).toBeDefined();
		expect(sentToModel.some((t) => t.startsWith("g11 "))).toBe(false);
		expect(new Set(pages.flat()).has(githubId!)).toBe(true);
		expect((await decidedIds(lineage)).has(githubId!)).toBe(true);
		const row = (await screeningRows(lineage)).find((r) => r.item_id === githubId);
		expect(row).toMatchObject({ verdict: "KEEP", routed: false });
		const reason = await sql<{ reason: string; reason_code: string }[]>`
			select reason, reason_code from item_screening where lineage = ${lineage} and item_id = ${githubId!}
		`;
		expect(reason[0]).toEqual({
			reason_code: "WATCHED_ENTITY",
			reason: "deterministic: the GitHub collector only polls watched repositories",
		});
		// Everything else was withheld as the stub asked.
		expect(pages.flat()).toEqual([githubId]);
		await sql`delete from source_configs where collector_id = 'fake-github'`;
	});

	it("offers every DROP when the audit sample rate is 1", async () => {
		const lineage = testLineage("screen-route-audit");
		stubScreener(defaultDecide);
		const pages: string[][] = [];
		const result = await runDailyPipeline({
			...baseOptions,
			sql,
			lineage,
			collection,
			screening: routeConfig({ auditDropSampleRate: 1 }),
			driverFactory: workingDriverFactory(pages),
		});
		expect(result.state).toBe("PUBLISHED");
		const ids = await manifestIds(lineage);
		expect(new Set(pages.flat())).toEqual(new Set(ids));
		const drops = (await screeningRows(lineage)).filter((r) => r.verdict === "DROP");
		expect(drops).toHaveLength(5);
		expect(drops.every((r) => r.audit_sampled && !r.routed)).toBe(true);
	});

	it("fails open to full Curator coverage when the screener is down, and says so", async () => {
		const lineage = testLineage("screen-route-down");
		stubScreener(defaultDecide, { status: 503 });
		const pages: string[][] = [];
		const result = await runDailyPipeline({
			...baseOptions,
			sql,
			lineage,
			collection,
			screening: routeConfig(),
			driverFactory: workingDriverFactory(pages),
		});
		expect(result.state).toBe("PUBLISHED");
		expect(result.degraded).toBe(true);
		expect(result.degradedReason).toMatch(/screening: 3 batch\(es\) failed, 20 item\(s\) unscreened and offered to the Curator/);
		const ids = await manifestIds(lineage);
		expect(new Set(pages.flat())).toEqual(new Set(ids));
		expect(await screeningRows(lineage)).toEqual([]);
		const { attempts } = await screenerTelemetry(result.runId);
		expect(attempts[0]?.status).toBe("FAILED");
	});

	it("fails open when the configured version is not the trusted one", async () => {
		const lineage = testLineage("screen-route-untrusted");
		stubScreener(defaultDecide);
		const pages: string[][] = [];
		const result = await runDailyPipeline({
			...baseOptions,
			sql,
			lineage,
			collection,
			screening: routeConfig({ routing: { trustedModel: MODEL, trustedPolicyVersion: "screening-older" } }),
			driverFactory: workingDriverFactory(pages),
		});
		expect(result.state).toBe("PUBLISHED");
		expect(result.degraded).toBe(true);
		expect(result.degradedReason).toMatch(/route mode requested but not trusted .*policyVersion .* is not the trusted screening-older/);
		const ids = await manifestIds(lineage);
		expect(new Set(pages.flat())).toEqual(new Set(ids));
		// Screened in shadow: rows exist, none routed.
		const rows = await screeningRows(lineage);
		expect(rows).toHaveLength(18);
		expect(rows.every((r) => !r.routed)).toBe(true);
	});

	it("keeps screener versions apart in the observation report", async () => {
		const lineage = testLineage("screen-versions");
		stubScreener(defaultDecide);
		await runDailyPipeline({
			...baseOptions,
			sql,
			lineage,
			collection,
			screening: screeningConfig(),
			driverFactory: workingDriverFactory(),
		});
		const ids = await manifestIds(lineage);
		await saveScreening(
			sql,
			{ lineage, date: DATE, provider: "openai", model: MODEL, policyVersion: "screening-v2" },
			ids.map((itemId) => ({ itemId, verdict: "KEEP" as const, reasonCode: "TRACKED_AREA" as const, reason: "v2", auditSampled: false, routed: false })),
		);
		const versions = await fetchScreeningVersions(sql, lineage, [DATE]);
		expect(versions.map((v) => v.policyVersion).sort()).toEqual([POLICY, "screening-v2"]);
		const v1 = buildScreeningFunnel(DATE, await fetchScreeningOutcomes(sql, lineage, DATE, { model: MODEL, policyVersion: POLICY }));
		const v2 = buildScreeningFunnel(DATE, await fetchScreeningOutcomes(sql, lineage, DATE, { model: MODEL, policyVersion: "screening-v2" }));
		expect(v1.byVerdict.DROP).toBe(5);
		expect(v2.byVerdict).toEqual({ DROP: 0, KEEP: 20, UNSURE: 0 });
	});
});

describe.skipIf(!probe.available)("migration 012 leaves earlier meaning intact", () => {
	it("keeps item_triage keyed and checked as 011 left it, and lets attempts carry SCREENER", async () => {
		const pk = await sql<{ def: string }[]>`
			select pg_get_constraintdef(oid) as def from pg_constraint
			where conrelid = 'item_triage'::regclass and contype = 'p'
		`;
		expect(pk[0]?.def).toBe("PRIMARY KEY (lineage, date, item_id, rules_version)");
		const check = await sql<{ def: string }[]>`
			select pg_get_constraintdef(oid) as def from pg_constraint
			where conrelid = 'item_triage'::regclass and contype = 'c'
		`;
		expect(check.map((c) => c.def).join(" ")).toMatch(/PRIORITY.*NORMAL.*LOW.*DUPLICATE_HINT.*UNCERTAIN/);
		const stage = await sql<{ def: string }[]>`
			select pg_get_constraintdef(oid) as def from pg_constraint
			where conrelid = 'agent_attempts'::regclass and conname = 'agent_attempts_stage_check'
		`;
		expect(stage[0]?.def).toContain("'SCREENER'");
	});
});

/* -------------------------------------------------------------------------- */
/* Rescue, at the tool level                                                   */
/* -------------------------------------------------------------------------- */

describe("rescuing a screened-out item", () => {
	const RDATE = "2026-09-16";
	let root: string;
	const manifest = makeManifest({ date: RDATE, groups: 2, perGroup: 2 });
	const [a1, a2, b1, b2] = manifest.items.map((i) => i.id) as [string, string, string, string];

	function tools(screenedOut: string[]) {
		root = mkdtempSync(join(tmpdir(), "di-screen-rescue-"));
		const list = createCuratorTools({
			date: RDATE,
			manifest,
			repo: new JsonStoryRepository(root),
			now: () => new Date(`${RDATE}T01:00:00.000Z`),
			screenedOutItemIds: new Set(screenedOut),
		});
		const byName = new Map(list.map((t) => [t.name, t]));
		const call = async <T = any>(name: string, args: unknown = {}): Promise<T> => {
			const tool = byName.get(name)!;
			const result = (await tool.execute("c", args as never, undefined, undefined, {} as never)) as {
				content: Array<{ text?: string }>;
			};
			const text = result.content[0]?.text ?? "null";
			// Every tool but submit_materials answers in compact JSON; submit answers in prose.
			try {
				return JSON.parse(text) as T;
			} catch {
				return text as T;
			}
		};
		return call;
	}

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	const story = (sourceItemIds: string[]) => ({
		storyId: "story-g01",
		canonicalTitle: "Event g01",
		sourceItemIds,
		primarySourceIds: [sourceItemIds[0]],
		status: "OPEN",
		changeType: "NEW",
		relevance: 0.8,
		novelty: 0.7,
		importance: 0.6,
		confidence: 0.9,
		reason: "grouped",
	});
	const materials = (sourceItemIds: string[]) => ({
		stories: [
			{
				storyId: "story-g01",
				tier: "A",
				canonicalTitle: "Event g01",
				whySelected: "it happened",
				changeType: "NEW",
				importance: 0.6,
				novelty: 0.7,
				confidence: 0.9,
				sourceItemIds,
				primarySourceIds: [sourceItemIds[0]],
			},
		],
		curatorNotes: "",
	});

	it("keeps the item searchable, flagged, citable only after a decision, and counts the rescue", async () => {
		// a2 is withheld; a1, b1, b2 are offered.
		const call = tools([a2]);

		const inventory = await call("get_daily_inventory");
		expect(inventory).toMatchObject({ totalItems: 4, screenedOutItems: 1, offeredItems: 3, unseenItems: 3, rescuedItems: 0 });

		const page = await call<{ items: Array<{ id: string }> }>("list_unseen_items", {});
		expect(page.items.map((i) => i.id)).toEqual([a1, b1, b2]);

		const found = await call<{ results: Array<{ id: string; screenedOut?: boolean }> }>("search_items", {
			query: "g01 coverage",
		});
		expect(found.results.find((r) => r.id === a2)?.screenedOut).toBe(true);
		expect(found.results.find((r) => r.id === a1)?.screenedOut).toBeUndefined();

		const upserted = await call<{ story: { storyId: string }; note?: string }>("upsert_story", story([a1, a2]));
		expect(upserted.story.storyId).toBe("story-g01");
		expect(upserted.note).toMatch(new RegExp(`${a2}.*were set aside by the screener.*record_item_decisions`));

		// Decide the offered items, but not the rescued one yet.
		await call("upsert_story", { ...story([b1, b2]), storyId: "story-g02", canonicalTitle: "Event g02" });
		await call("record_item_decisions", {
			decisions: [
				{ itemId: a1, disposition: "CANDIDATE", storyId: "story-g01", reason: "r" },
				{ itemId: b1, disposition: "CANDIDATE", storyId: "story-g02", reason: "r" },
				{ itemId: b2, disposition: "DUPLICATE", storyId: "story-g02", reason: "r" },
			],
		});
		await expect(call("submit_materials", materials([a1, a2]))).rejects.toThrow(
			new RegExp(`Undecided sourceItemIds in story "story-g01": ${a2}`),
		);

		const recorded = await call<{ rescued?: number; processedItems: number; totalItems: number; unseenItems: number }>(
			"record_item_decisions",
			{ decisions: [{ itemId: a2, disposition: "DUPLICATE", storyId: "story-g01", reason: "rescued" }] },
		);
		expect(recorded).toMatchObject({ rescued: 1, processedItems: 4, totalItems: 3, unseenItems: 0 });
		expect((await call("get_daily_inventory")) as object).toMatchObject({ rescuedItems: 1, unseenItems: 0 });

		const accepted = (await call("submit_materials", materials([a1, a2]))) as string;
		expect(accepted).toMatch(/4 decided by you, 1 set aside by the screener, 1 of those rescued; 4 total/);
	});

	it("still rejects an offered item that has no decision, by id", async () => {
		const call = tools([a2]);
		await call("upsert_story", story([a1]));
		await call("record_item_decisions", {
			decisions: [
				{ itemId: a1, disposition: "CANDIDATE", storyId: "story-g01", reason: "r" },
				{ itemId: b1, disposition: "IRRELEVANT", reason: "r" },
			],
		});
		await expect(call("submit_materials", materials([a1]))).rejects.toThrow(
			new RegExp(`2 of 3 offered items decided, 1 still unseen: ${b2}`),
		);
	});
});
