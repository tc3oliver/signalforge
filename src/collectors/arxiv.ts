import type { Collector, CollectorContext, CollectorResult } from "./types.ts";
import { CollectedItem } from "./types.ts";
import { RequestBudget, TokenBucket, fetchWithRetry } from "./http.ts";

/*
 * arXiv is read through the per-category announcement feeds, not through the
 * export API.
 *
 * `export.arxiv.org/api/query` answered every single request from this machine
 * with `429 Rate exceeded.` -- 27 consecutive FAILED runs over three days, no
 * items, and no `Retry-After` to back off against. The throttle is applied by
 * arXiv's frontend per client and its window is long enough that a 3-second
 * spacing, which is what arXiv's own guidance asks for, does not clear it; the
 * collector was already well-behaved and was still getting nothing.
 *
 * `rss.arxiv.org/rss/<category>` serves the same announcements, is cached, and
 * is the interface arXiv points daily readers at. It is also a better fit for
 * what this pipeline wants: one request per category returns exactly that day's
 * announcements, instead of paginating a sorted search and hoping the watermark
 * lands in the right place.
 */
const RSS_BASE = "https://rss.arxiv.org/rss";
// arXiv's usage guidance asks for >= 3s between requests from a single client.
const MIN_REQUEST_INTERVAL_MS = 3_000;
/*
 * arXiv asks clients to identify themselves. This one names the software, not
 * the operator: a personal account URL in a shipped default would be sent from
 * every installation, attributing everyone else's traffic to one person.
 * Operators who want their own contact on the header set ARXIV_USER_AGENT.
 */
const USER_AGENT =
	process.env["ARXIV_USER_AGENT"]?.trim() || "signalforge/0.1 (+https://github.com/tc3oliver/signalforge)";

const DEFAULT_CATEGORIES = ["cs.CL", "cs.LG", "cs.AI", "cs.DC"];

interface ArxivItem {
	externalId: string;
	title: string;
	summary: string;
	link: string;
	/** ISO 8601, derived from the feed's RFC-822 pubDate. */
	announcedAt: string;
	announceType: string;
	authors: string[];
	categories: string[];
}

/**
 * Cursor: the newest announcement timestamp already consumed.
 *
 * Every item in one build of a category feed carries the same `pubDate` -- the
 * announcement, not the paper -- so the watermark is a day boundary rather than
 * a per-paper one. That is the grain arXiv publishes at; pretending to a finer
 * one would only invent precision the feed does not have.
 */
interface ArxivCursor {
	lastAnnounced?: string;
}

function parseCursor(raw: string | undefined): ArxivCursor {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object") {
			const value = (parsed as ArxivCursor).lastAnnounced;
			if (typeof value === "string") return { lastAnnounced: value };
		}
	} catch {
		// Malformed cursor is treated as "start over" rather than fatal. A cursor
		// left by the old export-API collector also lands here: it has no
		// lastAnnounced, so the first RSS run simply takes the current feed.
	}
	return {};
}

/**
 * Minimal, dependency-free RSS 2.0 item extractor. Deliberately narrow: it only
 * pulls the handful of fields this collector needs, tolerating whitespace and
 * attribute variation rather than being a general XML parser.
 */
function extractItems(xml: string): { items: ArxivItem[]; malformed: number } {
	const items: ArxivItem[] = [];
	let malformed = 0;
	for (const block of xml.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
		const title = collapseWhitespace(matchTag(block, "title"));
		const link = matchTag(block, "link") ?? "";
		const guid = matchTag(block, "guid");
		const externalId = idFrom(guid, link);
		const pubDate = matchTag(block, "pubDate");
		const announcedAt = pubDate ? toIso(pubDate) : undefined;
		if (!externalId || !title || !announcedAt) {
			malformed++;
			continue;
		}
		items.push({
			externalId,
			title,
			summary: stripAbstractPreamble(matchTag(block, "description")),
			link: link || `https://arxiv.org/abs/${externalId}`,
			announcedAt,
			announceType: matchTag(block, "arxiv:announce_type") ?? "unknown",
			// dc:creator carries the full author list, comma-separated.
			authors: splitCreators(matchTag(block, "dc:creator")),
			categories: Array.from(block.matchAll(/<category>([\s\S]*?)<\/category>/g)).map((m) =>
				decodeEntities((m[1] ?? "").trim()),
			),
		});
	}
	return { items, malformed };
}

/**
 * `oai:arXiv.org:2609.13151v1` -> `2609.13151v1`. The version suffix is kept:
 * a replacement really is a new announcement, and dropping the version would
 * make v2 collide with v1 and disappear as a duplicate.
 */
function idFrom(guid: string | undefined, link: string): string | undefined {
	const fromGuid = guid?.match(/([0-9]{4}\.[0-9]+(?:v[0-9]+)?)\s*$/)?.[1];
	if (fromGuid) return fromGuid;
	const fromLink = link.match(/abs\/(.+)$/)?.[1]?.trim();
	return fromLink && fromLink.length > 0 ? fromLink : undefined;
}

/**
 * Feed descriptions open with `arXiv:2609.13151v1 Announce Type: new` before
 * the abstract. That preamble is already structured elsewhere on the item, so
 * carrying it in the summary would only spend the curator's attention twice.
 */
function stripAbstractPreamble(description: string | undefined): string {
	const text = collapseWhitespace(description);
	const abstractAt = text.indexOf("Abstract:");
	if (abstractAt >= 0) return text.slice(abstractAt + "Abstract:".length).trim();
	return text.replace(/^arXiv:\S+\s+Announce Type:\s*\S+\s*/i, "").trim();
}

function splitCreators(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
}

/** RFC-822 (`Tue, 15 Sep 2026 00:00:00 -0400`) to ISO, so the watermark sorts. */
function toIso(pubDate: string): string | undefined {
	const ms = Date.parse(pubDate);
	return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function matchTag(block: string, tag: string): string | undefined {
	const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
	return m ? decodeEntities((m[1] ?? "").trim()) : undefined;
}

function collapseWhitespace(s: string | undefined): string {
	return (s ?? "").replace(/\s+/g, " ").trim();
}

function decodeEntities(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

export class ArxivCollector implements Collector {
	readonly id = "arxiv";
	readonly sourceType = "arxiv" as const;
	readonly requiredSecrets: readonly string[] = [];
	#categories: string[];
	#sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	/**
	 * Overridable so a test need not spend the real politeness interval waiting.
	 * It paces both the explicit gap between feeds and the token bucket, which
	 * would otherwise make the gap real again on the bucket's side.
	 */
	#intervalMs: number;

	#explicitCategories: string[] | undefined;

	constructor(opts?: {
		categories?: string[];
		sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
		minRequestIntervalMs?: number;
	}) {
		this.#explicitCategories = opts?.categories;
		this.#categories = opts?.categories ?? DEFAULT_CATEGORIES;
		this.#sleep = opts?.sleep ?? defaultSleep;
		this.#intervalMs = opts?.minRequestIntervalMs ?? MIN_REQUEST_INTERVAL_MS;
	}

	async check(_ctx: CollectorContext): Promise<{ ok: boolean; detail: string }> {
		return { ok: true, detail: "arxiv requires no credentials" };
	}

	async collect(ctx: CollectorContext): Promise<CollectorResult> {
		const startedAt = ctx.now().toISOString();
		const warnings: string[] = [];
		const items: CollectedItem[] = [];
		const budget = new RequestBudget(200);
		const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 / (this.#intervalMs / 1000) });
		const cursor = parseCursor(ctx.cursor);

		let error: string | undefined;
		let latestAnnounced = cursor.lastAnnounced;
		// A paper cross-listed in two watched categories is announced in both feeds.
		const seen = new Set<string>();
		let succeeded = 0;

		// The configured categories win over the constructor default, so the list the
		// user curates in config/watchlists.yaml is the one actually queried. The
		// constructor override stays for tests, which must not read the real config.
		const configured = ctx.watchlists?.arxiv_categories ?? [];
		const categories = this.#explicitCategories ?? (configured.length > 0 ? configured : this.#categories);

		try {
			let firstRequest = true;
			for (const category of categories) {
				if (!firstRequest) await this.#sleep(this.#intervalMs, ctx.signal);
				firstRequest = false;

				let xml: string;
				try {
					const res = await fetchWithRetry(
						`${RSS_BASE}/${encodeURIComponent(category)}`,
						{ headers: { "user-agent": USER_AGENT } },
						{
							fetchImpl: ctx.fetch,
							signal: ctx.signal,
							budget,
							bucket,
							// The ceiling is the one operators set in config/sources.yaml
							// rather than a constant buried here that no amount of config
							// editing could change.
							timeoutMs: ctx.sourceConfig.timeoutMs,
						},
					);
					xml = await res.text();
				} catch (err) {
					// One unavailable category is not the whole source failing: the
					// remaining feeds are independent and still worth having.
					warnings.push(`${category}: ${(err as Error).message}`);
					continue;
				}
				succeeded++;

				const { items: parsed, malformed } = extractItems(xml);
				if (malformed > 0) warnings.push(`${category}: dropped ${malformed} malformed item(s)`);

				for (const item of parsed) {
					if (cursor.lastAnnounced && item.announcedAt <= cursor.lastAnnounced) continue;
					if (seen.has(item.externalId)) continue;
					seen.add(item.externalId);
					items.push(toCollectedItem(item, startedAt));
					if (!latestAnnounced || item.announcedAt > latestAnnounced) latestAnnounced = item.announcedAt;
				}
			}
		} catch (err) {
			// Only an abort or a budget exhaustion reaches here; per-feed failures
			// are handled above.
			error = (err as Error).message;
		}

		/*
		 * A run that reached no feed at all is FAILED; one that reached some is
		 * DEGRADED. Distinguishing them matters because arXiv answering nothing is
		 * the shape this collector was rewritten to escape, and it must not be
		 * reported as the same thing as one category being briefly unavailable.
		 */
		const health: CollectorResult["health"] =
			error !== undefined || (succeeded === 0 && categories.length > 0)
				? "FAILED"
				: warnings.length > 0
					? "DEGRADED"
					: "OK";
		if (health === "FAILED" && error === undefined) {
			error = warnings[0] ?? "no arxiv category feed could be read";
		}

		const finishedAt = ctx.now().toISOString();
		const nextCursor: ArxivCursor = latestAnnounced ? { lastAnnounced: latestAnnounced } : {};
		return {
			collectorId: this.id,
			health,
			items,
			facts: [],
			cursor: JSON.stringify(nextCursor),
			itemsFetched: items.length,
			warnings,
			error,
			startedAt,
			finishedAt,
			latencyMs: Date.parse(finishedAt) - Date.parse(startedAt),
		};
	}
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
		}, { once: true });
	});
}

function toCollectedItem(item: ArxivItem, fetchedAt: string): CollectedItem {
	return CollectedItem.parse({
		sourceType: "arxiv",
		sourceName: "arxiv",
		externalId: item.externalId,
		title: item.title,
		summary: item.summary,
		url: item.link,
		author: item.authors[0],
		publishedAt: item.announcedAt,
		metadata: {
			authors: item.authors,
			categories: item.categories,
			// `new`, `cross` or `replace`. Kept rather than filtered on: deciding a
			// revision is not worth reading is the curator's call, not a collector's.
			announceType: item.announceType,
		},
		raw: { externalId: item.externalId, body: item, fetchedAt },
	});
}
