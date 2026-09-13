import type { Collector, CollectorContext, CollectorResult } from "./types.ts";
import { CollectedItem } from "./types.ts";
import { RequestBudget, TokenBucket, fetchWithRetry } from "./http.ts";

const API_BASE = "https://export.arxiv.org/api/query";
// arXiv's usage guidance asks for >= 3s between requests from a single client.
const MIN_REQUEST_INTERVAL_MS = 3_000;
const PAGE_SIZE = 50;
/*
 * arXiv asks clients to identify themselves. This one names the software, not
 * the operator: a personal account URL in a shipped default would be sent from
 * every installation, attributing everyone else's traffic to one person.
 * Operators who want their own contact on the header set ARXIV_USER_AGENT.
 */
const USER_AGENT =
	process.env["ARXIV_USER_AGENT"]?.trim() || "signalforge/0.1 (+https://github.com/tc3oliver/signalforge)";

const DEFAULT_CATEGORIES = ["cs.CL", "cs.LG", "cs.AI", "cs.DC"];

interface ArxivEntry {
	id: string;
	title: string;
	summary: string;
	published: string;
	updated: string;
	authors: string[];
	links: { href: string; rel?: string; type?: string }[];
	categories: string[];
}

/** Cursor: last successfully processed `updated` watermark plus the `start` offset for the in-progress page. */
interface ArxivCursor {
	lastUpdated?: string;
	nextStart: number;
}

function parseCursor(raw: string | undefined): ArxivCursor {
	if (!raw) return { nextStart: 0 };
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && typeof (parsed as ArxivCursor).nextStart === "number") {
			return parsed as ArxivCursor;
		}
	} catch {
		// Malformed cursor is treated as "start over" rather than fatal.
	}
	return { nextStart: 0 };
}

/**
 * Minimal, dependency-free Atom XML entry extractor. Deliberately narrow: it
 * only pulls the handful of fields this collector needs, tolerating
 * whitespace/attribute variation rather than being a general XML parser.
 */
function extractEntries(xml: string): ArxivEntry[] {
	const entries: ArxivEntry[] = [];
	const entryBlocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
	for (const block of entryBlocks) {
		const id = matchTag(block, "id");
		const title = collapseWhitespace(matchTag(block, "title"));
		const summary = collapseWhitespace(matchTag(block, "summary"));
		const published = matchTag(block, "published");
		const updated = matchTag(block, "updated");
		const authors = Array.from(block.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)).map((m) => decodeEntities((m[1] ?? "").trim()));
		const categories = Array.from(block.matchAll(/<category[^>]*term="([^"]*)"/g)).map((m) => m[1] ?? "");
		const links = Array.from(block.matchAll(/<link([^>]*)\/?>/g)).map((m) => {
			const attrs = m[1] ?? "";
			return {
				href: attrOf(attrs, "href") ?? "",
				rel: attrOf(attrs, "rel"),
				type: attrOf(attrs, "type"),
			};
		});
		if (!id || !title) continue; // malformed entry: dropped and counted by the caller
		entries.push({
			id,
			title,
			summary,
			published: published ?? "",
			updated: updated ?? published ?? "",
			authors,
			links,
			categories,
		});
	}
	return entries;
}

function matchTag(block: string, tag: string): string | undefined {
	const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
	return m ? decodeEntities((m[1] ?? "").trim()) : undefined;
}

function attrOf(attrs: string, name: string): string | undefined {
	const m = attrs.match(new RegExp(`${name}="([^"]*)"`));
	return m ? decodeEntities(m[1] ?? "") : undefined;
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

function totalResultsOf(xml: string): number {
	const m = xml.match(/<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/);
	return m?.[1] ? Number(m[1]) : 0;
}

export class ArxivCollector implements Collector {
	readonly id = "arxiv";
	readonly sourceType = "arxiv" as const;
	readonly requiredSecrets: readonly string[] = [];
	#categories: string[];
	#sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

	#explicitCategories: string[] | undefined;

	constructor(opts?: { categories?: string[]; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }) {
		this.#explicitCategories = opts?.categories;
		this.#categories = opts?.categories ?? DEFAULT_CATEGORIES;
		this.#sleep = opts?.sleep ?? defaultSleep;
	}

	async check(_ctx: CollectorContext): Promise<{ ok: boolean; detail: string }> {
		return { ok: true, detail: "arxiv requires no credentials" };
	}

	async collect(ctx: CollectorContext): Promise<CollectorResult> {
		const startedAt = ctx.now().toISOString();
		const warnings: string[] = [];
		const items: CollectedItem[] = [];
		const budget = new RequestBudget(200);
		const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 / (MIN_REQUEST_INTERVAL_MS / 1000) });
		const cursor = parseCursor(ctx.cursor);

		let health: CollectorResult["health"] = "OK";
		let error: string | undefined;
		let start = cursor.nextStart;
		let latestUpdated = cursor.lastUpdated;
		let fetchedThisRun = 0;
		let firstRequest = true;

		// The configured categories win over the constructor default, so the list the
		// user curates in config/watchlists.yaml is the one actually queried. The
		// constructor override stays for tests, which must not read the real config.
		const configured = ctx.watchlists?.arxiv_categories ?? [];
		const categories = this.#explicitCategories ?? (configured.length > 0 ? configured : this.#categories);
		const searchQuery = categories.map((c) => `cat:${c}`).join(" OR ");

		try {
			for (;;) {
				if (!firstRequest) await this.#sleep(MIN_REQUEST_INTERVAL_MS, ctx.signal);
				firstRequest = false;

				const url = `${API_BASE}?search_query=${encodeURIComponent(searchQuery)}&sortBy=lastUpdatedDate&sortOrder=descending&start=${start}&max_results=${PAGE_SIZE}`;
				const res = await fetchWithRetry(url, { headers: { "user-agent": USER_AGENT } }, {
					fetchImpl: ctx.fetch,
					signal: ctx.signal,
					budget,
					bucket,
					// arXiv's export API answers slowly when it is busy -- a 16s
					// response is normal, not a fault -- so the ceiling is the one
					// operators set in config/sources.yaml rather than a constant
					// buried here that no amount of config editing could change.
					timeoutMs: ctx.sourceConfig.timeoutMs,
				});
				const xml = await res.text();
				const total = totalResultsOf(xml);
				const entries = extractEntries(xml);

				let stop = false;
				for (const entry of entries) {
					if (cursor.lastUpdated && entry.updated <= cursor.lastUpdated) {
						// Reached entries already seen last run: incremental cutoff.
						stop = true;
						break;
					}
					items.push(toCollectedItem(entry, startedAt));
					if (!latestUpdated || entry.updated > latestUpdated) latestUpdated = entry.updated;
				}
				fetchedThisRun += entries.length;
				start += entries.length;

				if (stop || entries.length === 0 || start >= total || fetchedThisRun >= 500) break;
			}
		} catch (err) {
			health = "FAILED";
			error = (err as Error).message;
		}

		const finishedAt = ctx.now().toISOString();
		const nextCursor: ArxivCursor = { lastUpdated: latestUpdated ?? cursor.lastUpdated, nextStart: 0 };
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

function toCollectedItem(entry: ArxivEntry, fetchedAt: string): CollectedItem {
	const arxivId = entry.id.replace(/^https?:\/\/arxiv\.org\/abs\//, "");
	const absLink = entry.links.find((l) => l.rel === "alternate")?.href ?? entry.id;
	return CollectedItem.parse({
		sourceType: "arxiv",
		sourceName: "arxiv",
		externalId: arxivId,
		title: entry.title,
		summary: entry.summary,
		url: absLink,
		author: entry.authors[0],
		publishedAt: entry.published || fetchedAt,
		metadata: {
			authors: entry.authors,
			categories: entry.categories,
			updated: entry.updated,
		},
		raw: { externalId: arxivId, body: entry, fetchedAt },
	});
}
