import type { Collector, CollectorContext, CollectorResult } from "./types.ts";
import { CollectedItem } from "./types.ts";
import { HttpError, RequestBudget, TokenBucket, fetchWithRetry } from "./http.ts";

const API_BASE = "https://api.github.com";

/**
 * Mechanical "important" thresholds for issues/PRs — never an editorial call
 * about whether the content is interesting. Anything below these is simply
 * not surfaced by this collector; the curator, not this collector, judges interest.
 */
const IMPORTANT_REACTION_THRESHOLD = 10;
const IMPORTANT_LABELS = new Set(["security", "breaking-change", "critical"]);

interface GhRelease {
	id: number;
	tag_name: string;
	name: string | null;
	html_url: string;
	body: string | null;
	published_at: string | null;
	author?: { login?: string };
}

interface GhTag {
	name: string;
	commit: { sha: string };
}

interface GhEvent {
	id: string;
	type: string;
	created_at: string;
	actor?: { login?: string };
	payload?: unknown;
}

interface GhIssue {
	id: number;
	number: number;
	title: string;
	body: string | null;
	html_url: string;
	state: string;
	user?: { login?: string };
	created_at: string;
	updated_at: string;
	labels?: Array<{ name?: string } | string>;
	reactions?: { total_count?: number };
	pull_request?: unknown;
}

/** Per-repo cursor: ETags for conditional requests plus a `since` watermark. */
interface RepoCursor {
	releasesEtag?: string;
	tagsEtag?: string;
	eventsEtag?: string;
	issuesSince?: string;
}
type GithubCursor = Record<string, RepoCursor>;

function parseCursor(raw: string | undefined): GithubCursor {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object") return parsed as GithubCursor;
	} catch {
		// Malformed cursor is treated as "no cursor" rather than fatal.
	}
	return {};
}

export class GitHubCollector implements Collector {
	readonly id = "github";
	readonly sourceType = "github" as const;
	readonly requiredSecrets: readonly string[] = [];
	/** Explicit override, used by tests for hermetic fixtures; production defaults to ctx.watchlists.github_repos. */
	#repos?: string[];

	constructor(opts?: { repos?: string[] }) {
		this.#repos = opts?.repos;
	}

	async check(ctx: CollectorContext): Promise<{ ok: boolean; detail: string }> {
		const hasToken = await ctx.hasSecret("GITHUB_TOKEN");
		return {
			ok: true,
			detail: hasToken ? "GITHUB_TOKEN present; authenticated rate limits" : "no GITHUB_TOKEN; unauthenticated rate limits apply",
		};
	}

	async collect(ctx: CollectorContext): Promise<CollectorResult> {
		const startedAt = ctx.now().toISOString();
		const warnings: string[] = [];
		const items: CollectedItem[] = [];
		const budget = new RequestBudget(500);
		const bucket = new TokenBucket({ capacity: 10, refillPerSecond: 1 });
		const cursor = parseCursor(ctx.cursor);
		const nextCursor: GithubCursor = { ...cursor };

		const token = (await ctx.hasSecret("GITHUB_TOKEN")) ? await ctx.secret("GITHUB_TOKEN") : undefined;
		const headers: Record<string, string> = {
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
		};
		if (token) headers["authorization"] = `Bearer ${token}`;

		const repos = this.#repos ?? ctx.watchlists.github_repos;
		let health: CollectorResult["health"] = "OK";
		let error: string | undefined;
		let sawRateLimit = false;

		if (repos.length === 0) {
			warnings.push("no watched repos configured");
		}

		for (const repo of repos) {
			const repoCursor: RepoCursor = cursor[repo] ?? {};
			try {
				const releases = await fetchConditional(ctx, `${API_BASE}/repos/${repo}/releases`, headers, repoCursor.releasesEtag, budget, bucket);
				if (releases.status === 429 || releases.rateLimited) sawRateLimit = true;
				if (releases.body) {
					for (const r of releases.body as GhRelease[]) {
						items.push(releaseToItem(repo, r, startedAt));
					}
				}
				if (releases.etag) nextCursor[repo] = { ...nextCursor[repo], releasesEtag: releases.etag };

				const tags = await fetchConditional(ctx, `${API_BASE}/repos/${repo}/tags`, headers, repoCursor.tagsEtag, budget, bucket);
				if (tags.body) {
					for (const t of tags.body as GhTag[]) {
						items.push(tagToItem(repo, t, startedAt));
					}
				}
				if (tags.etag) nextCursor[repo] = { ...nextCursor[repo], tagsEtag: tags.etag };

				const events = await fetchConditional(ctx, `${API_BASE}/repos/${repo}/events`, headers, repoCursor.eventsEtag, budget, bucket);
				if (events.body) {
					for (const e of events.body as GhEvent[]) {
						items.push(eventToItem(repo, e, startedAt));
					}
				}
				if (events.etag) nextCursor[repo] = { ...nextCursor[repo], eventsEtag: events.etag };

				const since = repoCursor.issuesSince ?? ctx.since.toISOString();
				const issuesUrl = `${API_BASE}/repos/${repo}/issues?state=all&sort=updated&direction=desc&since=${encodeURIComponent(since)}&per_page=100`;
				const issuesRes = await fetchWithRetry(issuesUrl, { headers }, {
					fetchImpl: ctx.fetch,
					signal: ctx.signal,
					budget,
					bucket,
					timeoutMs: 10_000,
				}).catch((err) => {
					if (err instanceof HttpError && err.status === 429) {
						sawRateLimit = true;
						warnings.push(`${repo}: rate limited fetching issues`);
						return undefined;
					}
					throw err;
				});
				if (issuesRes) {
					const remainingHeader = issuesRes.headers.get("x-ratelimit-remaining");
					if (remainingHeader !== null && Number(remainingHeader) <= 1) sawRateLimit = true;
					const body = (await issuesRes.json()) as unknown;
					if (Array.isArray(body)) {
						for (const raw of body as GhIssue[]) {
							if (!isMechanicallyImportant(raw)) continue;
							items.push(issueToItem(repo, raw, startedAt));
						}
					} else {
						warnings.push(`${repo}: unexpected issues payload shape (dropped)`);
					}
				}
				nextCursor[repo] = { ...nextCursor[repo], issuesSince: ctx.now().toISOString() };
			} catch (err) {
				warnings.push(`${repo}: ${(err as Error).message}`);
			}
		}

		if (sawRateLimit) health = "DEGRADED";
		if (!token && repos.length > 0) {
			// Unauthenticated GitHub access degrades rather than fails, per contract.
			health = health === "OK" ? "DEGRADED" : health;
			warnings.push("running unauthenticated: GITHUB_TOKEN not set, lower rate limits apply");
		}

		const finishedAt = ctx.now().toISOString();
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

interface ConditionalResult {
	body: unknown[] | undefined;
	etag: string | undefined;
	status: number;
	rateLimited: boolean;
}

/** GET with If-None-Match; a 304 means "nothing new" and is not an error. */
async function fetchConditional(
	ctx: CollectorContext,
	url: string,
	headers: Record<string, string>,
	etag: string | undefined,
	budget: RequestBudget,
	bucket: TokenBucket,
): Promise<ConditionalResult> {
	const reqHeaders = { ...headers, ...(etag ? { "if-none-match": etag } : {}) };
	try {
		// 304 is not in the retry/ok path of fetchWithRetry (fetch resolves it as a
		// normal, non-ok-but-non-retried response only for real errors); handle it here.
		const res = await ctx.fetch(url, { headers: reqHeaders, signal: ctx.signal });
		if (res.status === 304) {
			return { body: undefined, etag, status: 304, rateLimited: false };
		}
		if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
			// Fall back to the retrying path for transient failures.
			const retried = await fetchWithRetry(url, { headers: reqHeaders }, {
				fetchImpl: ctx.fetch,
				signal: ctx.signal,
				budget,
				bucket,
				timeoutMs: 10_000,
			});
			const body = (await retried.json()) as unknown;
			return {
				body: Array.isArray(body) ? body : [],
				etag: retried.headers.get("etag") ?? etag,
				status: retried.status,
				rateLimited: Number(retried.headers.get("x-ratelimit-remaining") ?? "1") <= 1,
			};
		}
		if (!res.ok) {
			throw new HttpError(`request failed with status ${res.status}`, res.status);
		}
		// Absence of the header (e.g. some conditional-request paths) is not evidence of
		// throttling; only a header that is actually present and near zero counts.
		const remainingHeader = res.headers.get("x-ratelimit-remaining");
		const body = (await res.json()) as unknown;
		return {
			body: Array.isArray(body) ? body : [],
			etag: res.headers.get("etag") ?? undefined,
			status: res.status,
			rateLimited: remainingHeader !== null && Number(remainingHeader) <= 1,
		};
	} catch (err) {
		budget.consume();
		throw err;
	}
}

/** Mechanical importance rule only: state/label/reaction thresholds, never editorial judgement. */
function isMechanicallyImportant(issue: GhIssue): boolean {
	const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? ""));
	if (labels.some((l) => IMPORTANT_LABELS.has(l.toLowerCase()))) return true;
	if ((issue.reactions?.total_count ?? 0) >= IMPORTANT_REACTION_THRESHOLD) return true;
	if (issue.pull_request && issue.state === "closed") return true;
	return false;
}

function releaseToItem(repo: string, r: GhRelease, fetchedAt: string): CollectedItem {
	return CollectedItem.parse({
		sourceType: "github",
		sourceName: repo,
		externalId: `${repo}#release-${r.id}`,
		title: r.name || r.tag_name,
		summary: r.body ?? "",
		url: r.html_url,
		author: r.author?.login,
		publishedAt: r.published_at ?? fetchedAt,
		metadata: { kind: "release", repo, tag: r.tag_name },
		raw: { externalId: `${repo}#release-${r.id}`, body: r, fetchedAt },
	});
}

function tagToItem(repo: string, t: GhTag, fetchedAt: string): CollectedItem {
	return CollectedItem.parse({
		sourceType: "github",
		sourceName: repo,
		externalId: `${repo}#tag-${t.name}`,
		title: `${repo} tag ${t.name}`,
		summary: "",
		url: `https://github.com/${repo}/releases/tag/${t.name}`,
		publishedAt: fetchedAt,
		metadata: { kind: "tag", repo, sha: t.commit.sha },
		raw: { externalId: `${repo}#tag-${t.name}`, body: t, fetchedAt },
	});
}

function eventToItem(repo: string, e: GhEvent, fetchedAt: string): CollectedItem {
	return CollectedItem.parse({
		sourceType: "github",
		sourceName: repo,
		externalId: `${repo}#event-${e.id}`,
		title: `${repo}: ${e.type}`,
		summary: "",
		author: e.actor?.login,
		publishedAt: e.created_at,
		metadata: { kind: "event", repo, eventType: e.type },
		raw: { externalId: `${repo}#event-${e.id}`, body: e, fetchedAt },
	});
}

function issueToItem(repo: string, issue: GhIssue, fetchedAt: string): CollectedItem {
	const isPr = Boolean(issue.pull_request);
	return CollectedItem.parse({
		sourceType: "github",
		sourceName: repo,
		externalId: `${repo}#${isPr ? "pr" : "issue"}-${issue.number}`,
		title: issue.title,
		summary: issue.body ?? "",
		url: issue.html_url,
		author: issue.user?.login,
		publishedAt: issue.updated_at,
		metadata: {
			kind: isPr ? "pull_request" : "issue",
			repo,
			state: issue.state,
			labels: (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")),
			reactionCount: issue.reactions?.total_count ?? 0,
		},
		raw: { externalId: `${repo}#${isPr ? "pr" : "issue"}-${issue.number}`, body: issue, fetchedAt },
	});
}
