import type { Collector, CollectorContext, CollectorResult } from "./types.ts";
import { CollectedItem } from "./types.ts";
import { COLLECTOR_CONCURRENCY, HttpError, RequestBudget, TokenBucket, fetchWithRetry, mapWithConcurrency } from "./http.ts";

const API_BASE = "https://api.github.com";

/**
 * Mechanical "important" thresholds for issues/PRs — never an editorial call
 * about whether the content is interesting. Anything below these is simply
 * not surfaced by this collector; the curator, not this collector, judges interest.
 */
const IMPORTANT_REACTION_THRESHOLD = 10;
const IMPORTANT_LABELS = new Set(["security", "breaking-change", "critical"]);

/**
 * A tag only becomes a candidate signal if it looks like a version. Watched repos
 * also carry `nightly`, `latest`, `base`, dated build tags and CI markers, none of
 * which are a publication event. This is a shape test, not a judgement about the
 * release's contents.
 */
const VERSION_TAG = /^v?\d+(\.\d+){1,3}(-[0-9A-Za-z.-]+)?$/;

/**
 * Cap on how many tag names are carried in the cursor. /tags returns the newest
 * page (30 by default), so remembering a few pages' worth is enough to tell
 * "new tag" from "tag we have already seen" without the cursor growing forever.
 */
const MAX_REMEMBERED_TAGS = 120;

/**
 * The /events firehose is deliberately NOT collected.
 *
 * It was the single largest source of agent-invisible noise: WatchEvent (someone
 * starred the repo), ForkEvent, PushEvent, IssueCommentEvent and CreateEvent were
 * normalized into items whose entire agent-visible content was the string
 * "<repo>: <EventType>" — no url, no summary, nothing the curator could judge, so
 * every one of them could only be dispositioned, never read.
 *
 * The two event types that do carry signal are already covered better elsewhere:
 * ReleaseEvent duplicates /releases (which additionally carries the release notes
 * and a real published_at), and PublicEvent announces a repo becoming public —
 * which cannot happen to a repo that is already on the watchlist. Nothing in the
 * remaining types survives the "could the curator read this?" test, so the whole
 * endpoint is dropped rather than allowlisted, which also returns one request per
 * repo per run to the budget.
 */

interface GhRelease {
	id: number;
	tag_name: string;
	name: string | null;
	html_url: string;
	body: string | null;
	published_at: string | null;
	draft?: boolean;
	prerelease?: boolean;
	author?: { login?: string };
}

interface GhTag {
	name: string;
	commit: { sha: string };
}

interface GhCommit {
	commit?: { committer?: { date?: string }; author?: { date?: string } };
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

/**
 * Per-repo cursor: ETags for conditional requests, a `since` watermark for issues,
 * plus the two pieces of state that let this collector tell a genuinely new
 * publication from a re-read of history — the newest release publication date it
 * has already emitted, and the tag names it has already seen.
 */
interface RepoCursor {
	releasesEtag?: string;
	tagsEtag?: string;
	issuesSince?: string;
	/** Newest release `published_at` already emitted for this repo. */
	releasesLatestPublishedAt?: string;
	/** Tag names observed on an earlier run; the first run seeds this and emits nothing. */
	knownTags?: string[];
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

		const repos = this.#repos ?? ctx.watchlists?.github_repos ?? [];
		let health: CollectorResult["health"] = "OK";
		let error: string | undefined;
		let sawRateLimit = false;
		let repoFailures = 0;

		if (repos.length === 0) {
			warnings.push("no watched repos configured");
		}

		// Each repo is an independent set of requests (releases, tags, issues). A few run at
		// once; their output is folded back in watchlist order, so items, warnings and the
		// cursor are identical to the sequential version.
		const perRepo = await mapWithConcurrency(repos, COLLECTOR_CONCURRENCY, async (repo) => {
			const repoCursor: RepoCursor = cursor[repo] ?? {};
			const outItems: CollectedItem[] = [];
			const outWarnings: string[] = [];
			let outCursor: RepoCursor | undefined = cursor[repo];
			let outRateLimited = false;
			let outFailed = false;
			try {
				// --- Releases: the primary signal. A release carries notes, a url and a real
				// publication date, so it is the one endpoint whose payload the curator can read.
				const releases = await fetchConditional(ctx, `${API_BASE}/repos/${repo}/releases`, headers, repoCursor.releasesEtag, budget, bucket);
				if (releases.status === 429 || releases.rateLimited) outRateLimited = true;
				// An ETag change returns the whole page, history included. Only publications newer
				// than the high-water mark are new; the rest is the same backfill re-read, which is
				// what previously made a same-day release indistinguishable from tag-history noise.
				let releaseWatermark = repoCursor.releasesLatestPublishedAt ?? ctx.since.toISOString();
				const releaseTagsOnPage = new Set<string>();
				if (releases.body) {
					for (const r of releases.body as GhRelease[]) {
						releaseTagsOnPage.add(r.tag_name);
						if (r.draft) continue;
						// A draft or otherwise unpublished release has no publication event yet.
						if (!r.published_at) continue;
						if (Date.parse(r.published_at) <= Date.parse(releaseWatermark)) continue;
						outItems.push(releaseToItem(repo, r, startedAt));
					}
					for (const r of releases.body as GhRelease[]) {
						if (!r.published_at || r.draft) continue;
						if (Date.parse(r.published_at) > Date.parse(releaseWatermark)) releaseWatermark = r.published_at;
					}
				}
				outCursor = { ...outCursor, releasesLatestPublishedAt: releaseWatermark };
				if (releases.etag) outCursor = { ...outCursor, releasesEtag: releases.etag };

				// --- Tags: a fallback for repos that tag without cutting a GitHub release.
				// /tags carries no date at all, so the old code stamped every tag with the fetch
				// time; combined with `published_at = excluded.published_at` on upsert that made
				// every ancient tag re-float to the top of recency views on every single run.
				const tags = await fetchConditional(ctx, `${API_BASE}/repos/${repo}/tags`, headers, repoCursor.tagsEtag, budget, bucket);
				if (tags.status === 429 || tags.rateLimited) outRateLimited = true;
				if (tags.body) {
					const page = (tags.body as GhTag[]).filter((t) => typeof t?.name === "string");
					const known = repoCursor.knownTags;
					const seeding = known === undefined;
					const suppressed = new Set([...(known ?? []), ...releaseTagsOnPage]);
					const unresolved = new Set<string>();
					if (!seeding) {
						const fresh = page.filter((t) => !suppressed.has(t.name) && VERSION_TAG.test(t.name));
						for (const t of fresh) {
							// The tag's real date lives on its commit. One extra request per genuinely
							// new tag is affordable precisely because "genuinely new" is now rare, and
							// it is the only way to avoid inventing a publication date.
							const publishedAt = await resolveTagDate(ctx, repo, t, headers, budget, bucket);
							if (!publishedAt) {
								// Leave it out of knownTags so the next run retries it, rather than
								// emitting it with a fabricated date or losing it permanently.
								unresolved.add(t.name);
								outWarnings.push(`${repo}: could not resolve commit date for tag ${t.name} (deferred)`);
								continue;
							}
							if (Date.parse(publishedAt) < Date.parse(ctx.since.toISOString())) {
								// Old tag that simply had not been observed before (e.g. first run after
								// a cursor reset): seen, remembered, but not reported as news.
								continue;
							}
							outItems.push(tagToItem(repo, t, publishedAt, startedAt));
						}
					}
					const remembered = [...page.map((t) => t.name).filter((n) => !unresolved.has(n)), ...(known ?? [])];
					outCursor = { ...outCursor, knownTags: dedupe(remembered).slice(0, MAX_REMEMBERED_TAGS) };
				}
				if (tags.etag) outCursor = { ...outCursor, tagsEtag: tags.etag };

				const since = repoCursor.issuesSince ?? ctx.since.toISOString();
				const issuesUrl = `${API_BASE}/repos/${repo}/issues?state=all&sort=updated&direction=desc&since=${encodeURIComponent(since)}&per_page=100`;
				// Captured BEFORE the request goes out. Anything GitHub updates from this
				// instant onwards cannot be in the response we are about to read, so this is
				// the latest moment the watermark may ever fall back to.
				const issuesRequestedAt = ctx.now().toISOString();
				const issuesRes = await fetchWithRetry(issuesUrl, { headers }, {
					fetchImpl: ctx.fetch,
					signal: ctx.signal,
					budget,
					bucket,
					timeoutMs: 10_000,
				}).catch((err) => {
					if (err instanceof HttpError && err.status === 429) {
						outRateLimited = true;
						outWarnings.push(`${repo}: rate limited fetching issues`);
						return undefined;
					}
					throw err;
				});
				if (issuesRes) {
					const remainingHeader = issuesRes.headers.get("x-ratelimit-remaining");
					if (remainingHeader !== null && Number(remainingHeader) <= 1) outRateLimited = true;
					// Read the response's own clock before the body, so the watermark cannot be
					// contaminated by however long parsing and scheduling take.
					const serverDate = issuesRes.headers.get("date");
					const body = (await issuesRes.json()) as unknown;
					if (Array.isArray(body)) {
						for (const raw of body as GhIssue[]) {
							if (!isMechanicallyImportant(raw)) continue;
							outItems.push(issueToItem(repo, raw, startedAt));
						}
						// The watermark advances only when the window was actually read. Advancing it
						// after a swallowed 429 silently skipped that window's issues forever.
						outCursor = {
							...outCursor,
							issuesSince: nextIssuesSince(serverDate, body as GhIssue[], issuesRequestedAt),
						};
					} else {
						outWarnings.push(`${repo}: unexpected issues payload shape (dropped)`);
					}
				}
			} catch (err) {
				outFailed = true;
				outWarnings.push(`${repo}: ${(err as Error).message}`);
			}
			return { repo, outItems, outWarnings, outCursor, outRateLimited, outFailed };
		});

		for (const result of perRepo) {
			items.push(...result.outItems);
			warnings.push(...result.outWarnings);
			if (result.outCursor !== undefined) nextCursor[result.repo] = result.outCursor;
			if (result.outRateLimited) sawRateLimit = true;
			if (result.outFailed) repoFailures += 1;
		}

		if (sawRateLimit) health = "DEGRADED";
		// A repo that threw contributed nothing. Reporting OK while every repo 401s was the
		// worst available failure shape: a silent zero that looks like a quiet news day.
		if (repoFailures > 0) {
			health = repoFailures === repos.length ? "FAILED" : "DEGRADED";
			error = `${repoFailures}/${repos.length} watched repos failed to collect`;
		}
		if (!token && repos.length > 0) {
			// Unauthenticated GitHub access degrades rather than fails, per contract.
			health = health === "OK" ? "DEGRADED" : health;
			warnings.push("running unauthenticated: GITHUB_TOKEN not set, lower rate limits apply");
		}
		if (!error && health === "DEGRADED") {
			error = sawRateLimit ? "GitHub rate limit reached during collection" : warnings[warnings.length - 1];
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

/**
 * The `since` watermark the next run will use. It must never be ahead of what this
 * run actually read: re-reading an issue costs nothing (ingest is idempotent on
 * `(source_type, external_id)`), skipping one loses it forever.
 *
 * The old code stamped `ctx.now()` *after* awaiting the response body, so every
 * issue GitHub updated between generating that page and that line was skipped on the
 * next run. The gap is not theoretical: the per-repo fan-out can deschedule this task
 * between the response and the cursor write, and skew between GitHub's clock and this
 * machine's widens it in either direction.
 *
 * In preference order:
 *  1. The response's `Date` header. That is GitHub's own clock at the moment it built
 *     the page, so it is exact and immune to local skew.
 *  2. The newest `updated_at` on the page. Every issue in the window is at or below
 *     it, so nothing newer than what was read can be stepped over.
 *  3. The time captured before the request was issued. Nothing GitHub changed from
 *     then on can have been in the response, so it is always safe, only wasteful.
 *
 * Never a timestamp taken after the body was read.
 */
function nextIssuesSince(serverDate: string | null, page: readonly GhIssue[], requestedAt: string): string {
	const fromHeader = serverDate === null ? Number.NaN : Date.parse(serverDate);
	if (!Number.isNaN(fromHeader)) return new Date(fromHeader).toISOString();

	let newest = Number.NaN;
	for (const issue of page) {
		const updated = Date.parse(issue?.updated_at ?? "");
		if (!Number.isNaN(updated) && (Number.isNaN(newest) || updated > newest)) newest = updated;
	}
	if (!Number.isNaN(newest)) return new Date(newest).toISOString();

	return requestedAt;
}

function dedupe(names: readonly string[]): string[] {
	return [...new Set(names)];
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
	// The conditional GET is a real request against the same API, so it pays the same
	// budget and rate-limit toll as any other. Charging it only on the error path (as
	// this used to) inverted the budget: the cheap path was unmetered and the failing
	// path was billed twice.
	budget.consume();
	await bucket.take(ctx.signal);
	const res = await withTimeout(ctx, (signal) => ctx.fetch(url, { headers: reqHeaders, signal }), 10_000);
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
}

/** Bound a single request in time, honouring the collector's own abort signal. */
async function withTimeout(ctx: CollectorContext, run: (signal: AbortSignal) => Promise<Response>, timeoutMs: number): Promise<Response> {
	ctx.signal?.throwIfAborted();
	const controller = new AbortController();
	const onOuterAbort = () => controller.abort(ctx.signal?.reason);
	ctx.signal?.addEventListener("abort", onOuterAbort, { once: true });
	const timer = setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), timeoutMs);
	try {
		return await run(controller.signal);
	} finally {
		clearTimeout(timer);
		ctx.signal?.removeEventListener("abort", onOuterAbort);
	}
}

/**
 * Resolve a tag's real publication date from the commit it points at. Returns
 * undefined when the date cannot be established — the caller then defers the tag
 * rather than stamping it with the fetch time.
 */
async function resolveTagDate(
	ctx: CollectorContext,
	repo: string,
	tag: GhTag,
	headers: Record<string, string>,
	budget: RequestBudget,
	bucket: TokenBucket,
): Promise<string | undefined> {
	const sha = tag.commit?.sha;
	if (!sha) return undefined;
	try {
		const res = await fetchWithRetry(`${API_BASE}/repos/${repo}/commits/${sha}`, { headers }, {
			fetchImpl: ctx.fetch,
			signal: ctx.signal,
			budget,
			bucket,
			timeoutMs: 10_000,
		});
		const body = (await res.json()) as GhCommit;
		const date = body?.commit?.committer?.date ?? body?.commit?.author?.date;
		return typeof date === "string" && !Number.isNaN(Date.parse(date)) ? date : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Mechanical importance rule only: label and reaction thresholds, never
 * editorial judgement.
 *
 * A pull request used to qualify on being closed alone, which reads as "a merged
 * PR is a shipped change" and is true only of a minority of them. On a busy
 * watched repo it admitted every CI tweak, every test-size adjustment and every
 * typo fix -- measured live, that single clause was most of what survived after
 * the event firehose was dropped. What actually shipped is already collected
 * from /releases, with notes and a real publication date.
 *
 * So a PR now clears the same bar as an issue: somebody labelled it security,
 * breaking-change or critical, or enough people reacted to it. Both are facts
 * about the record rather than an opinion about the content, which keeps this
 * the collector's decision to make.
 */
function isMechanicallyImportant(issue: GhIssue): boolean {
	const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? ""));
	if (labels.some((l) => IMPORTANT_LABELS.has(l.toLowerCase()))) return true;
	if ((issue.reactions?.total_count ?? 0) >= IMPORTANT_REACTION_THRESHOLD) return true;
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
		metadata: { kind: "release", repo, tag: r.tag_name, prerelease: Boolean(r.prerelease) },
		raw: { externalId: `${repo}#release-${r.id}`, body: r, fetchedAt },
	});
}

function tagToItem(repo: string, t: GhTag, publishedAt: string, fetchedAt: string): CollectedItem {
	return CollectedItem.parse({
		sourceType: "github",
		sourceName: repo,
		externalId: `${repo}#tag-${t.name}`,
		title: `${repo} tag ${t.name}`,
		summary: "",
		url: `https://github.com/${repo}/releases/tag/${t.name}`,
		publishedAt,
		metadata: { kind: "tag", repo, sha: t.commit.sha },
		raw: { externalId: `${repo}#tag-${t.name}`, body: t, fetchedAt },
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
