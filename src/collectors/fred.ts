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
import type { Collector, CollectorContext, CollectorResult, CollectedFact } from "./types.ts";

/** Series tracked by default; widen here once a config surface for collectors exists. */
const SERIES = ["FEDFUNDS", "DGS2", "DGS10", "T10Y2Y", "CPIAUCSL", "UNRATE", "M2SL", "WALCL"] as const;

const API_BASE = "https://api.stlouisfed.org/fred/series/observations";

/** FRED takes the key as a query param; never let it reach a log or stored raw payload. */
function redactUrl(url: string): string {
	return url.replace(/([?&]api_key=)[^&]+/i, "$1REDACTED");
}

interface Observation {
	date: string;
	value: string;
}

/**
 * Cursor shape: one observation_start date per series, so each series advances
 * independently even though they're fetched in a single collect() call.
 */
type Cursor = Record<string, string>;

function parseCursor(raw: string | undefined): Cursor {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object") return parsed as Cursor;
	} catch {
		// fall through to empty cursor — a corrupt cursor should not crash collection
	}
	return {};
}

export const fredCollector: Collector = {
	id: "fred",
	sourceType: "fred",
	requiredSecrets: ["FRED_API_KEY"],

	async check(ctx: CollectorContext) {
		const hasKey = await ctx.hasSecret("FRED_API_KEY");
		if (!hasKey) return { ok: false, detail: "FRED_API_KEY is required and not configured" };
		return { ok: true, detail: "FRED_API_KEY present" };
	},

	async collect(ctx: CollectorContext): Promise<CollectorResult> {
		const startedAt = ctx.now().toISOString();
		const facts: CollectedFact[] = [];
		const warnings: string[] = [];
		let itemsFetched = 0;

		const hasKey = await ctx.hasSecret("FRED_API_KEY");
		if (!hasKey) {
			const finishedAt = ctx.now().toISOString();
			return {
				collectorId: "fred",
				health: "DISABLED",
				items: [],
				facts: [],
				itemsFetched: 0,
				warnings: [],
				error: "FRED_API_KEY is required and not configured",
				startedAt,
				finishedAt,
				latencyMs: 0,
			};
		}

		const apiKey = await ctx.secret("FRED_API_KEY");
		const client = createHttpClient(ctx.fetch, {
			timeoutMs: 15_000,
			retries: 3,
			rateLimit: { perSecond: 2 },
			signal: ctx.signal,
		});

		const cursorIn = parseCursor(ctx.cursor);
		const cursorOut: Cursor = { ...cursorIn };
		let health: "OK" | "DEGRADED" | "FAILED" = "OK";

		for (const series of SERIES) {
			const observationStart = cursorIn[series] ?? ctx.since.toISOString().slice(0, 10);
			const url = `${API_BASE}?series_id=${series}&observation_start=${observationStart}&file_type=json&api_key=${apiKey}`;
			try {
				const res = await client.get(url);
				if (!res.ok) {
					warnings.push(`${series} returned ${res.status} for ${redactUrl(url)}`);
					continue;
				}
				const body = (await res.json()) as { observations?: Observation[] };
				const observations = body.observations ?? [];
				if (!Array.isArray(observations)) {
					warnings.push(`${series}: malformed payload, missing observations array`);
					continue;
				}

				let latestDate = cursorIn[series];
				for (const obs of observations) {
					const value = Number(obs.value);
					// FRED uses "." for a missing reading on that date; skip without treating it as a parse failure.
					if (obs.value === "." || Number.isNaN(value)) continue;
					itemsFetched++;
					facts.push({
						kind: "macro",
						label: series,
						value,
						// asOf is the observation date, never the fetch time — a stale series must
						// stay distinguishable from a current one downstream.
						asOf: obs.date,
						unit: "level",
						externalId: `fred-${series}-${obs.date}`,
						metadata: { series },
					});
					if (!latestDate || obs.date > latestDate) latestDate = obs.date;
				}

				if (latestDate) {
					// Advance the cursor to the day after the last observed date so the next
					// run doesn't refetch it; if nothing new came back, the cursor — and thus
					// the fact's real asOf — stays where it was, which is how staleness is detected.
					const next = new Date(latestDate);
					next.setUTCDate(next.getUTCDate() + 1);
					cursorOut[series] = next.toISOString().slice(0, 10);
				} else if (observations.length === 0) {
					warnings.push(`${series}: no new observations since ${observationStart}`);
				}
			} catch (err) {
				warnings.push(`${series} request failed: ${(err as Error).message}`);
			}
		}

		if (warnings.length > 0) health = facts.length > 0 ? "DEGRADED" : "FAILED";

		const finishedAt = ctx.now().toISOString();
		return {
			collectorId: "fred",
			health,
			items: [],
			facts,
			cursor: JSON.stringify(cursorOut),
			itemsFetched,
			warnings,
			startedAt,
			finishedAt,
			latencyMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
		};
	},
};
