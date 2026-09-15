import { COLLECTOR_CONCURRENCY, HttpError, TokenBucket, fetchWithRetry, mapWithConcurrency } from "./http.ts";
import type { Collector, CollectorContext, CollectorResult, CollectedItem, CollectedFact } from "./types.ts";
import { UNTRUSTED_EXTERNAL_CONTENT } from "./types.ts";

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
	// SEC's contact User-Agent is mandated by their policy but is not a credential
	// (it's a public, loggable string); it comes through ctx.config, not ctx.secret.
	requiredSecrets: [],

	async check(ctx: CollectorContext) {
		const userAgent = await ctx.config?.("SEC_USER_AGENT");
		if (!userAgent) {
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

		const userAgent = await ctx.config?.("SEC_USER_AGENT");
		if (!userAgent) {
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

		// SEC's stated limit is 10 req/sec across all their endpoints.
		const bucket = new TokenBucket({ capacity: 10, refillPerSecond: 10 });
		const headers = { "User-Agent": userAgent };

		let health: "OK" | "DEGRADED" | "FAILED" = "OK";
		const sinceIso = ctx.since.toISOString().slice(0, 10);

		// Only companies with a looked-up CIK can be polled; a null CIK is a
		// documented gap in the watchlist, not a collection failure.
		const secCompanies = ctx.watchlists?.sec_companies ?? [];
		const companies = secCompanies.filter((c): c is typeof c & { cik: string } => c.cik !== null);
		const skipped = secCompanies.length - companies.length;
		if (skipped > 0) warnings.push(`${skipped} watchlisted compan${skipped === 1 ? "y has" : "ies have"} no CIK on file, skipped`);
		if (secCompanies.length === 0) warnings.push("no SEC companies configured");

		// Each company is an independent submissions fetch. Run a few at once and fold the
		// per-company output back in watchlist order so items and warnings stay deterministic.
		const perCompany = await mapWithConcurrency(companies, COLLECTOR_CONCURRENCY, async (company) => {
			const outItems: CollectedItem[] = [];
			const outFacts: CollectedFact[] = [];
			const outWarnings: string[] = [];
			let outFetched = 0;
			const url = `https://data.sec.gov/submissions/CIK${company.cik}.json`;
			try {
				const res = await fetchWithRetry(url, { headers }, { fetchImpl: ctx.fetch, timeoutMs: 15_000, maxAttempts: 3, signal: ctx.signal, bucket });
				const body = (await res.json()) as SubmissionsResponse;
				const recent = body.filings?.recent;
				if (!recent || !Array.isArray(recent.form) || !Array.isArray(recent.filingDate)) {
					outWarnings.push(`${company.name} (${company.cik}): malformed submissions payload`);
					return { outItems, outFacts, outWarnings, outFetched };
				}
				const count = recent.form.length;
				for (let i = 0; i < count; i++) {
					const form = recent.form[i];
					const filingDate = recent.filingDate[i];
					const accession = recent.accessionNumber?.[i];
					if (!form || !filingDate || !accession) {
						outWarnings.push(`${company.name}: malformed filing entry at index ${i}`);
						continue;
					}
					if (!isTrackedForm(form)) continue;
					if (filingDate < sinceIso) continue;

					outFetched++;
					const accessionNoDashes = accession.replace(/-/g, "");
					const primaryDoc = recent.primaryDocument?.[i];
					const filingUrl = primaryDoc
						? `https://www.sec.gov/Archives/edgar/data/${Number(company.cik)}/${accessionNoDashes}/${primaryDoc}`
						: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${company.cik}`;
					const externalId = `sec-${company.cik}-${accession}`;
					const fetchedAt = ctx.now().toISOString();

					outItems.push({
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

					outFacts.push({
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
				if (err instanceof HttpError) {
					outWarnings.push(`${company.name} (${company.cik}) returned ${err.status}`);
				} else {
					outWarnings.push(`${company.name} (${company.cik}) request failed: ${(err as Error).message}`);
				}
			}
			return { outItems, outFacts, outWarnings, outFetched };
		});

		for (const result of perCompany) {
			items.push(...result.outItems);
			facts.push(...result.outFacts);
			warnings.push(...result.outWarnings);
			itemsFetched += result.outFetched;
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
