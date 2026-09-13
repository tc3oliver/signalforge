import { fetchWithRetry, TokenBucket } from "./http.ts";

/**
 * Thin per-collector adapter over the shared fetchWithRetry/TokenBucket
 * primitives in ./http.ts (owned by another agent) — gives call sites a
 * small get(url) surface instead of threading bucket/signal through each one.
 */
function createHttpClient(
	fetchImpl: typeof fetch,
	opts: { timeoutMs?: number; retries?: number; rateLimit?: { perSecond: number }; headers?: Record<string, string>; signal?: AbortSignal },
) {
	const bucket = opts.rateLimit
		? new TokenBucket({ capacity: Math.max(1, Math.ceil(opts.rateLimit.perSecond)), refillPerSecond: opts.rateLimit.perSecond })
		: undefined;
	return {
		async get(url: string, extra?: { headers?: Record<string, string> }): Promise<Response> {
			return fetchWithRetry(
				url,
				{ method: "GET", headers: { ...opts.headers, ...extra?.headers } },
				{ fetchImpl, timeoutMs: opts.timeoutMs, maxAttempts: opts.retries, signal: opts.signal, bucket },
			);
		},
	};
}
import type { Collector, CollectorContext, CollectorResult, CollectedItem, CollectedFact } from "./types.ts";
import { UNTRUSTED_EXTERNAL_CONTENT } from "./types.ts";

/** Watchlist of CIKs (zero-padded to 10 digits, as SEC requires) to poll. */
const WATCHLIST: { cik: string; name: string }[] = [
	{ cik: "0000320193", name: "Apple Inc." },
	{ cik: "0000789019", name: "Microsoft Corp." },
	{ cik: "0001652044", name: "Alphabet Inc." },
];

const TRACKED_FORMS = new Set(["8-K", "10-Q", "10-K", "S-3", "424B", "4"]);

/** 424B has sub-variants (424B2, 424B5, ...); match the family by prefix. */
function isTrackedForm(form: string): boolean {
	if (TRACKED_FORMS.has(form)) return true;
	if (form.startsWith("424B")) return true;
	return false;
}

interface SubmissionsResponse {
	name?: string;
	filings?: {
		recent?: {
			form?: string[];
			filingDate?: string[];
			accessionNumber?: string[];
			primaryDocument?: string[];
			reportDate?: string[];
		};
	};
}

export const secCollector: Collector = {
	id: "sec",
	sourceType: "sec",
	requiredSecrets: ["SEC_USER_AGENT"],

	async check(ctx: CollectorContext) {
		const hasUa = await ctx.hasSecret("SEC_USER_AGENT");
		if (!hasUa) {
			return { ok: false, detail: "SEC_USER_AGENT is required (SEC policy mandates a descriptive contact UA)" };
		}
		return { ok: true, detail: "SEC_USER_AGENT present" };
	},

	async collect(ctx: CollectorContext): Promise<CollectorResult> {
		const startedAt = ctx.now().toISOString();
		const items: CollectedItem[] = [];
		const facts: CollectedFact[] = [];
		const warnings: string[] = [];
		let itemsFetched = 0;

		const hasUa = await ctx.hasSecret("SEC_USER_AGENT");
		if (!hasUa) {
			const finishedAt = ctx.now().toISOString();
			return {
				collectorId: "sec",
				health: "DISABLED",
				items: [],
				facts: [],
				itemsFetched: 0,
				warnings: [],
				error: "SEC_USER_AGENT is required (SEC policy mandates a descriptive contact UA) and not configured",
				startedAt,
				finishedAt,
				latencyMs: 0,
			};
		}

		const userAgent = await ctx.secret("SEC_USER_AGENT");
		// SEC's stated limit is 10 req/sec across all their endpoints.
		const client = createHttpClient(ctx.fetch, {
			timeoutMs: 15_000,
			retries: 3,
			rateLimit: { perSecond: 10 },
			headers: { "User-Agent": userAgent },
			signal: ctx.signal,
		});

		let health: "OK" | "DEGRADED" | "FAILED" = "OK";
		const sinceIso = ctx.since.toISOString().slice(0, 10);

		for (const company of WATCHLIST) {
			const url = `https://data.sec.gov/submissions/CIK${company.cik}.json`;
			try {
				const res = await client.get(url);
				if (!res.ok) {
					warnings.push(`${company.name} (${company.cik}) returned ${res.status}`);
					continue;
				}
				const body = (await res.json()) as SubmissionsResponse;
				const recent = body.filings?.recent;
				if (!recent || !Array.isArray(recent.form) || !Array.isArray(recent.filingDate)) {
					warnings.push(`${company.name} (${company.cik}): malformed submissions payload`);
					continue;
				}
				const count = recent.form.length;
				for (let i = 0; i < count; i++) {
					const form = recent.form[i];
					const filingDate = recent.filingDate[i];
					const accession = recent.accessionNumber?.[i];
					if (!form || !filingDate || !accession) {
						warnings.push(`${company.name}: malformed filing entry at index ${i}`);
						continue;
					}
					if (!isTrackedForm(form)) continue;
					if (filingDate < sinceIso) continue;

					itemsFetched++;
					const accessionNoDashes = accession.replace(/-/g, "");
					const primaryDoc = recent.primaryDocument?.[i];
					const filingUrl = primaryDoc
						? `https://www.sec.gov/Archives/edgar/data/${Number(company.cik)}/${accessionNoDashes}/${primaryDoc}`
						: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${company.cik}`;
					const externalId = `sec-${company.cik}-${accession}`;
					const fetchedAt = ctx.now().toISOString();

					items.push({
						sourceType: "sec",
						sourceName: `SEC EDGAR: ${company.name}`,
						externalId,
						title: `${company.name} filed ${form}`,
						summary: `${company.name} filed Form ${form} on ${filingDate}.`,
						url: filingUrl,
						author: company.name,
						publishedAt: filingDate,
						metadata: { cik: company.cik, form, accessionNumber: accession },
						trust: UNTRUSTED_EXTERNAL_CONTENT,
						raw: { externalId, body: { form, filingDate, accession, primaryDoc }, fetchedAt },
					});

					facts.push({
						kind: "filing",
						label: `${company.name} ${form} filing`,
						value: 1,
						unit: "filing",
						asOf: filingDate,
						externalId: `sec-fact-${company.cik}-${accession}`,
						sourceExternalId: externalId,
						metadata: { cik: company.cik, form, accessionNumber: accession },
					});
				}
			} catch (err) {
				warnings.push(`${company.name} (${company.cik}) request failed: ${(err as Error).message}`);
			}
		}

		if (warnings.length > 0) health = items.length > 0 ? "DEGRADED" : "FAILED";

		const finishedAt = ctx.now().toISOString();
		return {
			collectorId: "sec",
			health,
			items,
			facts,
			itemsFetched,
			warnings,
			startedAt,
			finishedAt,
			latencyMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
		};
	},
};
