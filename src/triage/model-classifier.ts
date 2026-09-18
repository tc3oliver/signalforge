import { z } from "zod";
import type { TriageModelConfig } from "../config/schema.ts";
import type { InterestsConfig } from "../config/schema.ts";
import { TriageCategory } from "./types.ts";
import type { TriageInput, TriageResult } from "./types.ts";

/*
 * A second Stage 0 opinion, formed by a model instead of by rules. Shadow mode,
 * exactly like the rules: it writes to `item_triage` under its own
 * `rulesVersion` and nothing in the pipeline reads it back.
 *
 * Why this exists, in the words of the rules it runs beside
 * (src/triage/rules.ts):
 *
 *   "If UNCERTAIN turns out to dominate and the misses concentrate there, that
 *    is the evidence for spending a model on UNCERTAIN only -- and it will be a
 *    much smaller, better-specified problem than 'classify everything'."
 *
 * On 2026-09-18 UNCERTAIN was 471 of 1311 items, the largest bucket, so the
 * first half of that condition is met. The second half -- where the misses
 * concentrate -- is what this pass exists to measure, and it cannot be measured
 * without a candidate to measure. So: the rules keep running, this runs beside
 * them, and `pnpm observe` compares both against what the Curator and Editor
 * actually did.
 *
 * Three properties this must hold, none of them negotiable:
 *
 * 1. It never fails a run. A measurement that has never influenced a run must
 *    not be able to end one. Every failure path here degrades to UNCERTAIN and
 *    says why in `reason`.
 *
 * 2. It never invents a verdict. An item whose batch failed, whose response was
 *    malformed, or that the model simply did not mention comes back UNCERTAIN
 *    with the failure named -- never NORMAL, and above all never LOW. LOW is the
 *    bucket a future filter drops, and a parse error must not be able to put
 *    anything in it. This mirrors rule 1 in rules.ts: LOW is a claim, not a shrug.
 *
 * 3. It is bounded. Per-request timeout, whole-pass wall clock, and a bounded
 *    batch so one bad response loses one batch rather than the day.
 */

/** What the model is asked to return for each item. */
const ModelVerdict = z
	.object({
		itemId: z.string().min(1),
		category: TriageCategory,
		reason: z.string().min(1).max(300),
	})
	.strict();

const ModelResponse = z
	.object({
		verdicts: z.array(ModelVerdict).default([]),
	})
	.strict();

export interface ModelTriageDeps {
	config: TriageModelConfig;
	apiKey: string;
	interests: InterestsConfig;
	/** Injectable for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch;
	now?: () => number;
	log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface ModelTriageOutcome {
	results: TriageResult[];
	/** Batches that returned a usable response. */
	batchesOk: number;
	/** Batches that failed, timed out, or were cut off by the wall clock. */
	batchesFailed: number;
	/** Items that came back UNCERTAIN because something went wrong, not because the model said so. */
	degraded: number;
	durationMs: number;
}

/**
 * The category vocabulary, described for the model in the same terms the rules
 * use. Kept in this file rather than a prompt template so that a change to the
 * vocabulary and a change to its description cannot drift apart.
 */
function categoryGuide(): string {
	return [
		"PRIORITY  - something the reader is known to want: a watched entity, a security advisory, a major outage, a concrete technical release.",
		"NORMAL    - plausibly relevant to one of the reader's topics.",
		"LOW       - positively identifiable business/PR noise: funding rounds, hiring, marketing, awards, listicles.",
		"UNCERTAIN - you cannot tell from the title and summary alone.",
	].join("\n");
}

function systemPrompt(interests: InterestsConfig): string {
	const topics = interests.topics.map((t) => `- ${t.id}: ${t.label}`).join("\n");
	return [
		"You are a triage pass over a daily feed of technical news items.",
		"For every item you are given, return exactly one category.",
		"",
		"Categories:",
		categoryGuide(),
		"",
		"The reader's topics:",
		topics,
		"",
		"Two rules that override everything else:",
		"1. LOW is a claim, not a shrug. Use it only when something positively",
		"   indicates business or PR noise. If you cannot read the item, say",
		"   UNCERTAIN. A technical release you do not recognise is NEVER LOW:",
		"   an unfamiliar name is the most common shape of the thing worth",
		"   catching, not of the thing worth dropping.",
		"2. A security advisory, a major outage or a watched entity is PRIORITY",
		"   whether or not it matches a listed topic.",
		"",
		"Return JSON: {\"verdicts\":[{\"itemId\":\"...\",\"category\":\"...\",\"reason\":\"...\"}]}",
		"Return one verdict per item given, using the itemId exactly as supplied.",
		"Keep each reason under 200 characters.",
	].join("\n");
}

/** The projection sent to the model. Mirrors TriageInput: never the full body. */
function renderBatch(items: readonly TriageInput[]): string {
	return items
		.map((i) =>
			[
				`itemId: ${i.itemId}`,
				`source: ${i.sourceName} (${i.sourceType})`,
				`title: ${i.title}`,
				`summary: ${i.summary.slice(0, 600)}`,
			].join("\n"),
		)
		.join("\n---\n");
}

/**
 * An item the pass could not get a real verdict for.
 *
 * Always UNCERTAIN, never LOW, and the reason names the failure rather than
 * describing the item -- a row that says "batch timed out" is auditable; one
 * that silently reads as a judgement about the article is not.
 */
function degradedResult(item: TriageInput, why: string): TriageResult {
	return {
		itemId: item.itemId,
		category: "UNCERTAIN",
		topicIds: [],
		relevanceHint: 0,
		reason: `model triage unavailable: ${why}`,
		ruleId: "model-unavailable",
	};
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

async function classifyBatch(
	batch: readonly TriageInput[],
	deps: ModelTriageDeps,
	signal: AbortSignal,
): Promise<TriageResult[]> {
	const { config, apiKey, interests } = deps;
	const fetchImpl = deps.fetchImpl ?? fetch;

	const timeout = AbortSignal.timeout(config.timeoutMs);
	const combined = AbortSignal.any([signal, timeout]);

	const res = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: config.model,
			// JSON mode rather than a named schema: the strict-schema feature is not
			// available on every OpenAI-compatible endpoint or every model, and the
			// response is validated against ModelResponse here either way. Asking for
			// a feature the endpoint lacks fails the whole request; validating what
			// comes back costs nothing and works everywhere.
			response_format: { type: "json_object" },
			messages: [
				{ role: "system", content: systemPrompt(interests) },
				{ role: "user", content: renderBatch(batch) },
			],
		}),
		signal: combined,
	});

	if (!res.ok) {
		// The body can carry provider detail worth having, but it can also carry
		// echoed request content, so only the status is propagated.
		throw new Error(`HTTP ${res.status}`);
	}

	const payload = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
	const content = payload.choices?.[0]?.message?.content;
	if (typeof content !== "string" || content.trim() === "") {
		throw new Error("empty completion");
	}

	const parsed = ModelResponse.safeParse(JSON.parse(content));
	if (!parsed.success) throw new Error("response did not match the expected shape");

	const byId = new Map(parsed.data.verdicts.map((v) => [v.itemId, v] as const));
	return batch.map((item) => {
		const verdict = byId.get(item.itemId);
		// An item the model skipped is a gap in the measurement, not a NORMAL.
		if (!verdict) return degradedResult(item, "model returned no verdict for this item");
		return {
			itemId: item.itemId,
			category: verdict.category,
			topicIds: [],
			// Explicitly not a score. The rules' own note applies unchanged: triage
			// has no standing to decide an editorial outcome, and nothing
			// downstream reads this.
			relevanceHint: 0,
			reason: verdict.reason,
			ruleId: "model-classifier",
		};
	});
}

/**
 * Classifies a whole manifest, in bounded parallel batches.
 *
 * Never throws. The caller gets a result for every input item, one way or
 * another, and `degraded` says how many of them are placeholders.
 */
export async function classifyWithModel(
	items: readonly TriageInput[],
	deps: ModelTriageDeps,
): Promise<ModelTriageOutcome> {
	const now = deps.now ?? (() => Date.now());
	const log = deps.log ?? (() => {});
	const startedAt = now();

	if (items.length === 0) {
		return { results: [], batchesOk: 0, batchesFailed: 0, degraded: 0, durationMs: 0 };
	}

	const batches = chunk(items, deps.config.batchSize);
	const results = new Map<string, TriageResult>();
	let batchesOk = 0;
	let batchesFailed = 0;

	// One controller for the whole pass: when the wall clock runs out, every
	// request still in flight is abandoned at once rather than each waiting out
	// its own timeout.
	const passController = new AbortController();
	const wallClock = setTimeout(() => passController.abort(), deps.config.maxWallClockMs);

	try {
		let next = 0;
		const workers = Array.from({ length: Math.min(deps.config.concurrency, batches.length) }, async () => {
			while (true) {
				const index = next++;
				const batch = batches[index];
				if (!batch) return;

				try {
					for (const r of await classifyBatch(batch, deps, passController.signal)) {
						results.set(r.itemId, r);
					}
					batchesOk += 1;
				} catch (err) {
					batchesFailed += 1;
					const why = err instanceof Error ? err.message : String(err);
					log("model triage batch failed", { batch: index, items: batch.length, error: why });
					for (const item of batch) {
						results.set(item.itemId, degradedResult(item, why));
					}
				}
			}
		});
		await Promise.all(workers);
	} finally {
		clearTimeout(wallClock);
	}

	// Ordered by the input, and complete by construction: an item that no batch
	// ever reached still gets a row, because a missing row and a LOW row are
	// indistinguishable in a recall query that joins on item id.
	const ordered = items.map(
		(item) => results.get(item.itemId) ?? degradedResult(item, "item was never classified"),
	);

	return {
		results: ordered,
		batchesOk,
		batchesFailed,
		degraded: ordered.filter((r) => r.ruleId === "model-unavailable").length,
		durationMs: now() - startedAt,
	};
}
