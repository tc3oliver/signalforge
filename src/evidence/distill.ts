import { z } from "zod";
import type { EvidenceConfig } from "../config/schema.ts";
import type { TokenUsage } from "../schemas/run.ts";
import { locateQuotes } from "./locate.ts";

/*
 * Reading one source document, once, on the Curator's behalf.
 *
 * The Curator is a stateful session: every tool result it receives is re-sent
 * to the provider on each later turn of that work unit, measured at about six
 * occurrences for a mid-unit read. So a 97,000-character article does not cost
 * 97,000 characters, it costs them six times, and on 2026-09-19 three such
 * reads accounted for an estimated 156,000 tokens of that day's curation.
 *
 * This stage answers one question about one document in a request that is
 * thrown away afterwards, and hands back a packet small enough that carrying it
 * for the rest of the unit is free. The division of labour is deliberate and is
 * the reason this is safe: the cheap model finds and proposes passages,
 * TypeScript decides which of them exist, and the Curator alone decides what
 * any of it means editorially. Nothing here ranks, clusters, scores or judges.
 *
 * Like the screener, it is a function call rather than an agent: no tools, no
 * session, no fallback chain. A model that could look things up would start
 * answering the questions the Curator exists to answer.
 */

/*
 * What the distilling model is allowed to return.
 *
 * Deliberately permissive about shape and strict about meaning. An earlier
 * version capped the answer's length in the schema and rejected the whole
 * response when it ran over; a live check found a model answering in 940
 * characters against a 600-character cap, which threw away four passages that
 * had verified perfectly. Length is a formatting problem and is fixed by
 * trimming here, not by discarding an item's evidence. Unknown keys are ignored
 * for the same reason: an extra field the model volunteered is not a reason to
 * lose the fields that matter.
 *
 * What is not negotiable is that every quote is checked against the source
 * before the Curator sees it. That happens below, not here.
 */
const ModelEvidence = z.object({
	answer: z.string().min(1),
	attribution: z.string().optional(),
	quotes: z.array(z.string().min(1)).default([]),
});

/** The answer is orientation, not evidence; the located passages carry the weight. */
const ANSWER_CHARS = 600;
const ATTRIBUTION_CHARS = 200;

function clamp(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export type EvidenceStatus = "OK" | "NO_EVIDENCE" | "EMPTY_BODY" | "UNAVAILABLE";

export interface EvidenceItem {
	itemId: string;
	status: EvidenceStatus;
	/** How long the canonical prose body is, so the Curator can judge a follow-up read. */
	bodyChars: number;
	/** Who published or announced the thing described. Present when the model supplied it. */
	attribution?: string;
	/** The distilling model's answer to the question. Absent unless at least one quote verified. */
	answer?: string;
	/** Passages located in the body, as the body's own characters. */
	evidence?: Array<{ quote: string; at: number }>;
	/** Proposed passages that could not be located, and were therefore discarded. */
	dropped?: number;
}

export interface EvidenceOutcome {
	items: EvidenceItem[];
	/** One sentence when something failed; drives the run's degraded reason. */
	degraded?: string;
	usage?: TokenUsage;
	durationMs: number;
}

export interface EvidenceInput {
	itemId: string;
	title: string;
	sourceName: string;
	/** Canonical prose. Offsets in the result are indices into this string. */
	body: string;
}

export interface EvidenceDeps {
	config: EvidenceConfig;
	apiKey: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
	log?: (msg: string, fields?: Record<string, unknown>) => void;
}

/*
 * Extraction and judgement in one request.
 *
 * Asking for the answer and the passages together was measured against asking
 * separately: once both sides are compared as prose rather than as raw markup,
 * the difference in how often a proposed passage can be located is about two
 * points, 97% against 99%. A second request would re-send the whole body to buy
 * that, which on a short item is several times the amplified cost of the packet
 * it is protecting. One request.
 *
 * `attribution` is a required field because of a measured miss: a packet
 * described a reporting framework's contents accurately and dropped whose
 * framework it was, which is the opening clause of the story the Curator went
 * on to write.
 */
const SYSTEM = `You read one source document and answer one question about it for an editor. You have no tools and no other sources. Everything you write must come from the document in front of you.

Return JSON with exactly these keys:
- "answer": 2-4 sentences answering the question directly, in the document's own terms. If the document does not answer it, say so plainly here.
- "attribution": who published, announced, reported or demonstrated the thing described, named as the document names them. Empty string only if the document truly does not say.
- "quotes": 2-5 passages copied EXACTLY from the document, each under 300 characters, that support your answer. Copy the characters as they appear. Do not tidy, join, shorten or paraphrase a passage; a passage that is not character-for-character from the document is worse than no passage at all, because it will be discarded and your answer will be left unsupported.

Choose passages that carry the specific, checkable content: the number, the date, the named party, the version, the concrete change. Prefer a passage from the middle or end of the document when that is where the substance is; an opening paragraph usually restates the headline.

Never infer, extrapolate or add background knowledge. Do not judge importance, novelty or newsworthiness — that is the editor's job, not yours. Do not describe your own reasoning.`;

function render(input: EvidenceInput, question: string): string {
	return `QUESTION: ${question}\n\nTITLE: ${input.title}\nSOURCE: ${input.sourceName}\n\nDOCUMENT:\n${input.body}`;
}

interface ApiUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	prompt_tokens_details?: { cached_tokens?: number };
}

/**
 * Distils one document. Never throws: every failure is a status on the item,
 * because the alternative the Curator would reach for is reading the whole
 * article, which is the cost being removed.
 */
async function distillOne(
	input: EvidenceInput,
	question: string,
	deps: EvidenceDeps,
	signal: AbortSignal,
): Promise<{ item: EvidenceItem; usage?: ApiUsage; failure?: string }> {
	/*
	 * One retry, and only for a request that failed to complete.
	 *
	 * Measured across 24 live calls, about one in twelve ended in a transport
	 * error rather than a result. That is survivable -- the item comes back
	 * UNAVAILABLE and the Curator reads it instead -- but on a five-item call it
	 * makes a partial packet likely, and a Curator that finds the tool
	 * unreliable will stop using it and go back to reading whole articles.
	 *
	 * This is not the repair round the grounding work rejected. That one showed
	 * a model its own failed quotation and asked for a better one, which
	 * re-fabricated seventeen times in thirty-one and never once refused. This
	 * re-sends an identical request that never arrived, and changes no
	 * judgement about what the document says.
	 */
	const first = await attemptDistill(input, question, deps, signal);
	if (!first.failure) return first;
	if (signal.aborted) return first;
	deps.log?.("retrying evidence distillation", { itemId: input.itemId, after: first.failure });
	return attemptDistill(input, question, deps, signal);
}

async function attemptDistill(
	input: EvidenceInput,
	question: string,
	deps: EvidenceDeps,
	signal: AbortSignal,
): Promise<{ item: EvidenceItem; usage?: ApiUsage; failure?: string }> {
	const { config } = deps;
	const fetchImpl = deps.fetchImpl ?? fetch;
	try {
		const res = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${deps.apiKey}` },
			body: JSON.stringify({
				model: config.model,
				response_format: { type: "json_object" },
				messages: [
					{ role: "system", content: SYSTEM },
					{ role: "user", content: render(input, question) },
				],
			}),
			signal,
		});
		// The body can echo request content, so only the status propagates.
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const payload = (await res.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
			usage?: ApiUsage;
		};
		const content = payload.choices?.[0]?.message?.content;
		if (typeof content !== "string" || content.trim() === "") throw new Error("empty completion");
		const parsed = ModelEvidence.safeParse(JSON.parse(content));
		if (!parsed.success) throw new Error("response did not match the expected shape");

		const { located, dropped } = locateQuotes(input.body, parsed.data.quotes);
		const attribution = parsed.data.attribution ? clamp(parsed.data.attribution, ATTRIBUTION_CHARS) : undefined;
		if (located.length === 0) {
			/*
			 * An answer with nothing verifiable behind it is withheld. It would
			 * read like evidence and be indistinguishable, in the session, from
			 * an answer that was checked.
			 */
			return {
				item: {
					itemId: input.itemId,
					status: "NO_EVIDENCE",
					bodyChars: input.body.length,
					...(dropped > 0 ? { dropped } : {}),
				},
				usage: payload.usage,
			};
		}
		return {
			item: {
				itemId: input.itemId,
				status: "OK",
				bodyChars: input.body.length,
				...(attribution ? { attribution } : {}),
				answer: clamp(parsed.data.answer, ANSWER_CHARS),
				evidence: located.slice(0, config.maxQuotesPerItem).map((l) => ({ quote: l.quote, at: l.at })),
				...(dropped > 0 ? { dropped } : {}),
			},
			usage: payload.usage,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		deps.log?.("evidence distillation failed", { itemId: input.itemId, error: message });
		return {
			item: { itemId: input.itemId, status: "UNAVAILABLE", bodyChars: input.body.length },
			failure: message,
		};
	}
}

/** Distils each document for the same question. Never throws. */
export async function distillEvidence(
	inputs: readonly EvidenceInput[],
	question: string,
	deps: EvidenceDeps,
): Promise<EvidenceOutcome> {
	const now = deps.now ?? (() => Date.now());
	const startedAt = now();
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reportedBy: 0 };
	const failures: string[] = [];
	const items: EvidenceItem[] = [];

	const withBody = inputs.filter((i) => i.body.length > 0);
	for (const input of inputs) {
		if (input.body.length === 0) {
			items.push({ itemId: input.itemId, status: "EMPTY_BODY", bodyChars: 0 });
		}
	}

	/*
	 * One bound per request, and only one.
	 *
	 * An earlier version composed a pass-wide AbortController with a per-request
	 * `AbortSignal.timeout`, which is two mechanisms for one job and aborted a
	 * request that had not run out of time. Each document gets its own clock.
	 */
	const results = await Promise.all(
		withBody.map((input) => distillOne(input, question, deps, AbortSignal.timeout(deps.config.timeoutMs))),
	);
	for (const r of results) {
		items.push(r.item);
		if (r.failure) failures.push(r.failure);
		if (r.usage) {
			usage.input += r.usage.prompt_tokens ?? 0;
			usage.output += r.usage.completion_tokens ?? 0;
			usage.cacheRead += r.usage.prompt_tokens_details?.cached_tokens ?? 0;
			usage.totalTokens += r.usage.total_tokens ?? 0;
			usage.reportedBy += 1;
		}
	}

	// Keep the caller's order, so the packet reads in the order asked for.
	const byId = new Map(items.map((i) => [i.itemId, i]));
	const ordered = inputs.map((i) => byId.get(i.itemId)!).filter(Boolean);

	return {
		items: ordered,
		...(failures.length > 0
			? { degraded: `evidence distillation failed for ${failures.length} item(s): ${failures[0]}` }
			: {}),
		...(usage.reportedBy > 0 ? { usage } : {}),
		durationMs: now() - startedAt,
	};
}
