import { fetchWithRetry, HttpError } from "../../collectors/http.ts";
import { ProviderCredentialError, ProviderResponseError } from "../types.ts";
import type { ResearchProvider, ResearchResult, ResearchSearchOptions, SecretResolver } from "../types.ts";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const SECRET_NAME = "TAVILY_API_KEY";

interface TavilyRawResult {
	title?: unknown;
	url?: unknown;
	content?: unknown;
	published_date?: unknown;
}

interface TavilyRawResponse {
	results?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function parseTavilyResponse(body: unknown): TavilyRawResult[] {
	if (!isRecord(body) || !Array.isArray((body as TavilyRawResponse).results)) {
		throw new ProviderResponseError("tavily", "missing or non-array `results` field");
	}
	return (body as TavilyRawResponse).results as TavilyRawResult[];
}

/**
 * Tavily search provider. Calls the provider HTTP API directly — this must
 * never bind to the globally-installed pi-web-access extension, which the
 * production worker is not allowed to depend on.
 */
export function createTavilyProvider(fetchImpl: typeof fetch, secrets: SecretResolver): ResearchProvider {
	async function resolveKey(): Promise<string> {
		const has = await secrets.hasSecret(SECRET_NAME).catch(() => false);
		if (!has) throw new ProviderCredentialError("tavily");
		try {
			const key = await secrets.secret(SECRET_NAME);
			if (!key) throw new ProviderCredentialError("tavily");
			return key;
		} catch (err) {
			if (err instanceof ProviderCredentialError) throw err;
			throw new ProviderCredentialError("tavily", { cause: err });
		}
	}

	return {
		name: "tavily",

		async check() {
			try {
				await resolveKey();
				return { ok: true, detail: "tavily credential resolved" };
			} catch {
				return { ok: false, detail: "tavily credential unavailable" };
			}
		},

		async search(query: string, opts: ResearchSearchOptions): Promise<ResearchResult[]> {
			const apiKey = await resolveKey();
			const retrievedAt = new Date().toISOString();

			let res: Response;
			try {
				res = await fetchWithRetry(
					TAVILY_ENDPOINT,
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${apiKey}`,
						},
						body: JSON.stringify({
							query,
							max_results: opts.maxResults ?? 5,
						}),
					},
					{
						fetchImpl,
						timeoutMs: opts.timeoutMs,
						signal: opts.signal,
						maxAttempts: 1, // the router owns fallback; a single attempt here keeps the failure boundary sharp
					},
				);
			} catch (err) {
				if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
					throw new ProviderCredentialError("tavily", { cause: err });
				}
				throw err;
			}

			let body: unknown;
			try {
				body = await res.json();
			} catch (err) {
				throw new ProviderResponseError("tavily", "response body was not valid JSON", { cause: err });
			}

			const rawResults = parseTavilyResponse(body);
			return rawResults
				.filter((r): r is TavilyRawResult & { title: string; url: string } => typeof r.title === "string" && typeof r.url === "string")
				.map((r) => ({
					provider: "tavily" as const,
					query,
					title: r.title,
					url: r.url,
					snippet: typeof r.content === "string" ? r.content : "",
					publishedAt: typeof r.published_date === "string" && r.published_date ? r.published_date : undefined,
					retrievedAt,
					raw: r,
				}));
		},
	};
}
