import { fetchWithRetry, HttpError } from "../../collectors/http.ts";
import { ProviderCredentialError, ProviderResponseError } from "../types.ts";
import type { ResearchProvider, ResearchResult, ResearchSearchOptions, SecretResolver } from "../types.ts";

const EXA_ENDPOINT = "https://api.exa.ai/search";
const SECRET_NAME = "EXA_API_KEY";

interface ExaRawResult {
	title?: unknown;
	url?: unknown;
	text?: unknown;
	publishedDate?: unknown;
}

interface ExaRawResponse {
	results?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function parseExaResponse(body: unknown): ExaRawResult[] {
	if (!isRecord(body) || !Array.isArray((body as ExaRawResponse).results)) {
		throw new ProviderResponseError("exa", "missing or non-array `results` field");
	}
	return (body as ExaRawResponse).results as ExaRawResult[];
}

/** Exa search provider — the fallback when Tavily is unavailable. See tavily.ts for the shared shape. */
export function createExaProvider(fetchImpl: typeof fetch, secrets: SecretResolver): ResearchProvider {
	async function resolveKey(): Promise<string> {
		const has = await secrets.hasSecret(SECRET_NAME).catch(() => false);
		if (!has) throw new ProviderCredentialError("exa");
		try {
			const key = await secrets.secret(SECRET_NAME);
			if (!key) throw new ProviderCredentialError("exa");
			return key;
		} catch (err) {
			if (err instanceof ProviderCredentialError) throw err;
			throw new ProviderCredentialError("exa", { cause: err });
		}
	}

	return {
		name: "exa",

		async check() {
			try {
				await resolveKey();
				return { ok: true, detail: "exa credential resolved" };
			} catch {
				return { ok: false, detail: "exa credential unavailable" };
			}
		},

		async search(query: string, opts: ResearchSearchOptions): Promise<ResearchResult[]> {
			const apiKey = await resolveKey();
			const retrievedAt = new Date().toISOString();

			let res: Response;
			try {
				res = await fetchWithRetry(
					EXA_ENDPOINT,
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							"x-api-key": apiKey,
						},
						body: JSON.stringify({
							query,
							numResults: opts.maxResults ?? 5,
							contents: { text: true },
						}),
					},
					{
						fetchImpl,
						timeoutMs: opts.timeoutMs,
						signal: opts.signal,
						maxAttempts: 1, // this is already the fallback provider; no further fallback exists past it
					},
				);
			} catch (err) {
				if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
					throw new ProviderCredentialError("exa", { cause: err });
				}
				throw err;
			}

			let body: unknown;
			try {
				body = await res.json();
			} catch (err) {
				throw new ProviderResponseError("exa", "response body was not valid JSON", { cause: err });
			}

			const rawResults = parseExaResponse(body);
			return rawResults
				.filter((r): r is ExaRawResult & { title: string; url: string } => typeof r.title === "string" && typeof r.url === "string")
				.map((r) => ({
					provider: "exa" as const,
					query,
					title: r.title,
					url: r.url,
					snippet: typeof r.text === "string" ? r.text : "",
					publishedAt: typeof r.publishedDate === "string" && r.publishedDate ? r.publishedDate : undefined,
					retrievedAt,
					raw: r,
				}));
		},
	};
}
