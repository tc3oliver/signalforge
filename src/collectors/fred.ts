import { scrubSecrets } from "../runtime/redact.ts";
import { HttpError, TokenBucket, fetchWithRetry, mapWithConcurrency } from "./http.ts";
import type { Collector, CollectorContext, CollectorResult, CollectedFact } from "./types.ts";

const API_BASE = "https://api.stlouisfed.org/fred/series/observations";

/**
 * FRED takes the key as a query param; never let it reach a log or stored raw
 * payload. Redaction lives in one shared module rather than here, so a fourth
 * keyed collector inherits it instead of needing its own copy.
 */
const redactUrl = scrubSecrets;

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
		/** Things that went wrong, and only those: these decide the health. */
		const problems: string[] = [];
		/** Things worth telling an operator that are not faults. */
		const notes: string[] = [];
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
		const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 2 });
		/*
		 * Series fan-out runs two at a time, matching the bucket above rather than the
		 * shared COLLECTOR_CONCURRENCY of 4.
		 *
		 * The bucket admits 2 requests/second sustained, so a fan-out of 4 bought nothing
		 * past the opening burst: two workers would sit blocked in `bucket.take()` for the
		 * whole run while the code read as though four series were in flight. Raising the
		 * bucket instead would need a rate FRED actually permits, and no limit for this API
		 * is documented anywhere in this repo, so a larger number would be a guess aimed at
		 * the remote's throttle. Lowering the concurrency to what the bucket can feed keeps
		 * throughput identical and stops the code implying parallelism it cannot deliver.
		 * If a real documented limit turns up, raise both together.
		 */
		const FRED_CONCURRENCY = 2;
		const series = (ctx.watchlists?.fred_series ?? []).map((s) => s.id);

		const cursorIn = parseCursor(ctx.cursor);
		const cursorOut: Cursor = { ...cursorIn };
		let health: "OK" | "DEGRADED" | "FAILED" = "OK";

		if (series.length === 0) problems.push("no FRED series configured");

		// Series are independent observation fetches; run a few at once and fold the
		// per-series output back in watchlist order so facts and messages stay deterministic.
		const perSeries = await mapWithConcurrency(series, FRED_CONCURRENCY, async (seriesId) => {
			const outFacts: CollectedFact[] = [];
			const outProblems: string[] = [];
			const outNotes: string[] = [];
			let outFetched = 0;
			let outCursor: string | undefined;
			const observationStart = cursorIn[seriesId] ?? ctx.since.toISOString().slice(0, 10);
			const url = `${API_BASE}?series_id=${seriesId}&observation_start=${observationStart}&file_type=json&api_key=${apiKey}`;
			try {
				const res = await fetchWithRetry(url, {}, { fetchImpl: ctx.fetch, timeoutMs: 15_000, maxAttempts: 3, signal: ctx.signal, bucket });
				const body = (await res.json()) as { observations?: Observation[] };
				// Absent and non-array are both malformed. Defaulting a missing key to
				// [] would make a broken response indistinguishable from a series that
				// simply has nothing new -- and under the health rule below, that would
				// turn a real fault into a silent OK.
				if (!Array.isArray(body.observations)) {
					outProblems.push(`${seriesId}: malformed payload, missing observations array`);
					return { outFacts, outProblems, outNotes, outFetched, outCursor };
				}
				const observations = body.observations;

				let latestDate = cursorIn[seriesId];
				for (const obs of observations) {
					const value = Number(obs.value);
					// FRED uses "." for a missing reading on that date; skip without treating it as a parse failure.
					if (obs.value === "." || Number.isNaN(value)) continue;
					outFetched++;
					outFacts.push({
						kind: "macro",
						label: seriesId,
						value,
						// asOf is the observation date, never the fetch time — a stale series must
						// stay distinguishable from a current one downstream.
						asOf: obs.date,
						unit: "level",
						externalId: `fred-${seriesId}-${obs.date}`,
						metadata: { series: seriesId },
					});
					if (!latestDate || obs.date > latestDate) latestDate = obs.date;
				}

				if (latestDate) {
					// Advance the cursor to the day after the last observed date so the next
					// run doesn't refetch it; if nothing new came back, the cursor — and thus
					// the fact's real asOf — stays where it was, which is how staleness is detected.
					const next = new Date(latestDate);
					next.setUTCDate(next.getUTCDate() + 1);
					outCursor = next.toISOString().slice(0, 10);
				} else if (observations.length === 0) {
					// Not a problem: an economic series that has not printed since the
					// last run is the normal state of most series on most days. It is
					// recorded so an operator can see the series was asked, but it must
					// not be mistaken for a fault -- see the health rule below.
					outNotes.push(`${seriesId}: no new observations since ${observationStart}`);
				}
			} catch (err) {
				if (err instanceof HttpError) {
					outProblems.push(`${seriesId} returned ${err.status} for ${redactUrl(url)}`);
				} else {
					outProblems.push(`${seriesId} request failed: ${(err as Error).message}`);
				}
			}
			return { outFacts, outProblems, outNotes, outFetched, outCursor };
		});

		for (const [index, result] of perSeries.entries()) {
			facts.push(...result.outFacts);
			problems.push(...result.outProblems);
			notes.push(...result.outNotes);
			itemsFetched += result.outFetched;
			const seriesId = series[index] as string;
			if (result.outCursor !== undefined) cursorOut[seriesId] = result.outCursor;
		}

		/*
		 * Only a problem degrades the collector. Emptiness does not: FRED is
		 * incremental, and a day on which no configured series printed a new
		 * observation is a day on which this collector worked perfectly and had
		 * nothing to add. Conflating the two reported FAILED for a healthy,
		 * authenticated collector, which is exactly the kind of false alarm that
		 * teaches an operator to ignore the health column.
		 */
		const warnings = [...problems, ...notes];
		if (problems.length > 0) health = facts.length > 0 ? "DEGRADED" : "FAILED";

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
