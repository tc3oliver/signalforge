# Data sources

Eleven source families are defined in `config/sources.yaml` (one per `SourceType` in
`src/schemas/item.ts`, which the config schema enforces). Ten of them have a
collector registered in `src/pipeline/collection.ts`. The eleventh, `web`, is
different and is covered at the end.

Everything below was read out of the collector source, `config/sources.yaml` and
`config/watchlists.yaml`. Nothing is inferred from a provider's documentation.

## Current status, in one table

| Source | Credential | Required? | Enabled | Status |
|---|---|---|---|---|
| rss (Miniflux) | `MINIFLUX_API_KEY` (+ `baseUrl`) | Required | true | **DISABLED** — no credential present |
| web (Tavily) | `TAVILY_API_KEY` | Required | true | **Not a collector.** Reached only via the `search_web` curator tool; degrades to Exa, then unavailable. No credential present |
| github | `GITHUB_TOKEN` | Optional | true | **DEGRADED** — runs unauthenticated at lower rate limits |
| hackernews | — | None | true | **OK** |
| arxiv | — | None | true | **OK** |
| semantic-scholar | `SEMANTIC_SCHOLAR_API_KEY` | Optional | true | **OK (throttled)** — keyless public tier; enrichment-only, needs arXiv ids |
| coingecko | `COINGECKO_API_KEY` | Optional | true | **OK** — public tier, no demo key present |
| fred | `FRED_API_KEY` | Required | true | **DISABLED** — no credential present |
| sec | — (`userAgent`, not a secret) | None, but `userAgent` is mandatory | false | **DISABLED** — disabled in config *and* no `userAgent` set |
| reddit | `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` | Optional | false | **DISABLED** — disabled in config |
| youtube | `YOUTUBE_API_KEY` | Optional | true *(see note)* | **DISABLED** — disabled in config |

**Read the Status column as current fact, not as a hypothetical.** At the time of
writing, `.env` and the process environment contain only `POSTGRES_USER`,
`POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`, `DATABASE_URL` and
`DI_LINEAGE`. No collector credential of any kind is present, and the only Keychain
mapping the code knows about is `TAVILY_API_KEY → (service "pi-tavily", account
"oliver")` (`KEYCHAIN_MAPPINGS` in `src/config/secrets.ts`). So every
credential-requiring source reports `DISABLED`, and every credential-*optional*
source runs in its reduced, unauthenticated mode. None of them are "working" in the
full sense until the operator supplies secrets.

*(Note on `youtube`: `config/sources.yaml` sets `enabled: false`, which is what
governs. The row above reflects config.)*

## How "required" is decided, and what happens when a secret is missing

`Collector.requiredSecrets` (`src/collectors/types.ts`) is "logical secret names this
collector needs; empty for public sources". Before invoking a collector,
`src/pipeline/collection.ts` checks each name with `hasSecret()` — which never reads
the value — and if any is missing, short-circuits to:

```
health: "DISABLED", warnings: ["missing required secret(s): …"]
```

The comment in the pipeline states the intent: **a missing credential is an
operational fact, not a run failure.** A disabled collector does not fail the day; it
is excluded from the active set and recorded in `collection_runs` /
`daily_runs.degraded_reason` so `/admin/sources` can show credential-blocked sources.

Note the asymmetry between the two lists: `config/sources.yaml` names the secrets an
operator is *expected* to supply, while `Collector.requiredSecrets` in the code is
what is *enforced*. Three collectors (`github`, `reddit`, `youtube`) list secrets in
YAML but declare `requiredSecrets: []` in code, because each has a genuine degraded
mode. `semantic-scholar` and `coingecko` likewise treat their key as optional. That
is deliberate, but it does mean the YAML column is a hint and the code column is the
contract.

Secrets are resolved env-first, then the login Keychain (`resolveSecret()` in
`src/config/secrets.ts`). See `docs/SECURITY.md`.

## Cross-cutting network behaviour

Every collector goes through `fetchWithRetry` in `src/collectors/http.ts`, which owns
the concerns no collector should reimplement:

- **Timeout** per attempt (default 15s; `config/sources.yaml` `timeoutMs` per source).
- **Retry** with full-jitter exponential backoff (default 3 attempts, 250ms base,
  10s cap) for transport errors, 5xx and 429. A 429 honours `Retry-After`
  (seconds or HTTP-date). **Any other 4xx is never retried** — it reflects a request
  the caller must fix, not a transient condition.
- **Rate limiting** via `TokenBucket`, per collector, with per-collector capacity and
  refill (listed below). `take()` sleeps rather than rejecting; ending the wait is
  the timeout's and `AbortSignal`'s job.
- **`RequestBudget`**, a bounded per-run request counter so a runaway collector
  cannot hammer an API. Exhaustion throws `BudgetExhaustedError`; callers stop
  collecting rather than retry.

Cursors are opaque per-collector strings persisted by the collection store and handed
back as `ctx.cursor` next run. Every collector treats a malformed cursor as "no
cursor" / "start over" rather than as a fatal error.

Item ids are deterministic: `itemIdFor(sourceType, externalId)` is a SHA-1 prefix, so
re-collecting the same record upserts rather than duplicating.

---

## rss — Miniflux

**What it collects.** Entries from a self-hosted Miniflux instance — the operator's
whole RSS subscription set, whatever that is. This is the one source whose content is
configured entirely outside this repo.

**Endpoints.** `GET {baseUrl}/v1/entries` with
`order=id&direction=asc&limit={pageSize}&offset={n}`, plus `after_entry_id={cursor}`
and `changed_after={unix seconds}`. `baseUrl` comes from `config/sources.yaml`
(`http://localhost:8080`).

**Credential.** **Required** — `MINIFLUX_API_KEY`, sent as the `X-Auth-Token` header.
`requiredSecrets: ["MINIFLUX_API_KEY"]`. A missing key *or* a missing `baseUrl` short
-circuits to `health: "DISABLED"` with the error "a baseUrl and MINIFLUX_API_KEY are
both required and not fully configured".

**Incrementality.** Two mechanisms at once: the cursor is the highest entry id
consumed (`after_entry_id`), and `changed_after` is derived from `ctx.since`. The
cursor is only advanced past what was actually consumed, so a page that breaks
midway does not skip the remainder on the next run.

**Rate limits.** `TokenBucket{capacity: 5, refillPerSecond: 5}`; 15s timeout, 3
attempts.

**Health.** Warnings degrade: `DEGRADED` if some items came through, `FAILED` if none
did.

**Enabled:** `true`. **Current status: DISABLED** (no `MINIFLUX_API_KEY`).

---

## web — Tavily

**This source has no collector.** There is no `tavily.ts` in `src/collectors/` and no
`web` entry in the collector registry in `src/pipeline/collection.ts`. The
`config/sources.yaml` `web` block therefore configures nothing in the collection
pass.

Web research instead reaches the system through the `search_web` **curator tool**
(`src/curator/tools.ts`), routed by `ResearchRouter` (`src/research/router.ts`):

- **Endpoints.** `POST https://api.tavily.com/search` with an
  `authorization: Bearer …` header (`src/research/providers/tavily.ts`); on any
  failure, `POST https://api.exa.ai/search` with an `x-api-key` header
  (`src/research/providers/exa.ts`).
- **Credential.** Tavily: `TAVILY_API_KEY`. Exa: `EXA_API_KEY`. Both **required by
  their own provider**; a missing key produces `ProviderCredentialError`, which the
  router maps to the `TAVILY_CREDENTIAL_MISSING` degraded reason rather than an
  exception.
- **Incrementality.** None — it is query-driven, not a feed.
- **Budgets instead of rate limits.** `ResearchBudgetTracker` enforces
  `maxQueryLength: 400`, `maxResults: 5`, `maxCallsPerStory: 3`, `maxCallsPerRun: 20`
  and `timeoutMs: 15000` from `config/agent.yaml`. Over-budget is a clean `REFUSED`
  outcome.
- **Degradation.** Tavily failure → Exa, with `degraded: true` and a reason tag
  (`TAVILY_AUTH_FAILED`, `TAVILY_RATE_LIMITED`, `TAVILY_TIMEOUT`,
  `TAVILY_MALFORMED_RESPONSE`, `TAVILY_UNAVAILABLE`). Both failing → the tool rejects
  with an instruction to proceed from existing evidence and lower confidence. A
  research outage degrades the brief; it never fails the run.
- Results are converted to the collector item shape and carry
  `trust: UNTRUSTED_EXTERNAL_CONTENT`.

**Enabled:** `true` in config, but with no collector to enable. **Current status: no
`TAVILY_API_KEY` and no `EXA_API_KEY` present**, so `search_web` — when configured at
all — would immediately report `TAVILY_CREDENTIAL_MISSING` and then find Exa equally
unavailable.

---

## github

**What it collects.** Per watched repo (`config/watchlists.yaml` `github_repos`):
releases, tags, repo events, and issues updated since a watermark. Warns "no watched
repos configured" rather than silently collecting nothing.

**Endpoints.** `https://api.github.com/repos/{repo}/releases`, `/tags`, `/events`,
and `/issues?state=all&sort=updated&direction=desc&since={iso}&per_page=100`.

**Credential.** **Optional** — `GITHUB_TOKEN`. `requiredSecrets: []` in code. Without
it the collector runs against unauthenticated rate limits, pushes the warning
"running unauthenticated: GITHUB_TOKEN not set, lower rate limits apply" and marks
itself `DEGRADED`.

**Incrementality.** The richest of the set: a per-repo cursor object holding an
**ETag per endpoint** (`releasesEtag`, `tagsEtag`, `eventsEtag`) plus an
`issuesSince` watermark. Conditional GETs send `if-none-match`; a **304 means
"nothing new" and is not an error**. The issues call uses `since`, falling back to
`ctx.since`.

**Rate limits.** `RequestBudget(500)`, `TokenBucket{capacity: 10, refillPerSecond:
1}`. `x-ratelimit-remaining` is read from responses; `<= 1` or a 429 sets
`sawRateLimit`, which degrades the collector's health.

**Enabled:** `true`. **Current status: DEGRADED** — no `GITHUB_TOKEN`, so it runs
unauthenticated.

---

## hackernews

**What it collects.** Items from three lists — `topstories`, `beststories`,
`newstories` — deduplicated, then each new id fetched individually.

**Endpoints.** `https://hacker-news.firebaseio.com/v0/{list}.json` and
`https://hacker-news.firebaseio.com/v0/item/{id}.json`. Item URLs fall back to
`https://news.ycombinator.com/item?id={id}` when the story has no outbound link.

**Credential.** **None.** `requiredSecrets: []`; `check()` returns "hackernews
requires no credentials".

**Incrementality.** A seen-id set in the cursor: candidate ids already seen are
skipped. The set is trimmed to the most recent `MAX_SEEN_IDS = 5000` (HN ids are
monotonically increasing) so the cursor stays bounded.

**Rate limits.** `RequestBudget(2000)`, `TokenBucket{capacity: 10, refillPerSecond:
5}`, item fetches at `FETCH_CONCURRENCY = 8`.

**Enabled:** `true`. **Current status: OK.**

---

## arxiv

**What it collects.** Papers in the categories from `config/watchlists.yaml`
(`arxiv_categories`), as `cat:X OR cat:Y`, newest-updated first. The configured
categories win over the constructor default, so the list the operator curates is the
one actually queried; the constructor override exists only so tests never read the
real config.

**Endpoints.** `https://export.arxiv.org/api/query?search_query=…&sortBy=
lastUpdatedDate&sortOrder=descending&start={n}&max_results={PAGE_SIZE}`, Atom XML,
parsed without a dependency. Sent with an explicit descriptive `user-agent`.

**Credential.** **None.** `requiredSecrets: []`.

**Incrementality.** The cursor holds `lastUpdated` (the last successfully processed
`updated` watermark) and `nextStart`. Pagination walks `start` until `totalResults`
is reached or an entry with `updated <= lastUpdated` appears — that is the
incremental cutoff, and it stops the page walk immediately.

**Rate limits.** `RequestBudget(200)` and a token bucket sized from
`MIN_REQUEST_INTERVAL_MS`, with an explicit sleep of at least that interval between
paginated requests. Two tests cover this: it "paginates using start/max_results until
totalResults is reached" and "waits at least the configured interval between
paginated requests".

**Enabled:** `true`. **Current status: OK.**

---

## semantic-scholar

**What it collects.** Citation/venue/abstract enrichment for arXiv ids. It is
explicitly an **enrichment collector with no independent discovery feed** — the ids
are passed in by the pipeline (seeded from the arXiv collector's output, which is why
the registry is built after arXiv has run). With no ids it warns "no arXiv ids
provided for enrichment" and returns nothing.

**Endpoints.** `POST https://api.semanticscholar.org/graph/v1/paper/batch?fields=…`
with `{ ids: ["ArXiv:<id>", …] }`, batched.

**Credential.** **Optional** — `SEMANTIC_SCHOLAR_API_KEY`, sent as `x-api-key`.
`requiredSecrets: []`. `check()` reports "no API key; public tier rate limits apply"
when absent.

**Incrementality.** A `seenArxivIds` set in the cursor; ids already enriched are
filtered out, and the set is trimmed to stay bounded.

**Rate limits.** `RequestBudget(200)`, and the bucket is sized by key presence:
`{capacity: 5, refillPerSecond: 2}` with a key, `{capacity: 1, refillPerSecond: 0.2}`
without — the keyless tier is throttled hard, so burst is capped at 1. Partial
failures set `DEGRADED` rather than failing.

**Enabled:** `true`. **Current status: OK but throttled** — keyless public tier, and
it only does anything on a run where arXiv produced ids.

---

## coingecko

**What it collects.** Three things for the crypto assets in `config/watchlists.yaml`:
per-asset price with market cap, 24h volume and 24h change (emitted as
`CollectedFact`s of kind `crypto`, not prose); the global market snapshot; and the
trending list (emitted as items).

**Endpoints.** `https://api.coingecko.com/api/v3/simple/price?ids=…&vs_currencies=usd
&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true`,
`/api/v3/global`, `/api/v3/search/trending`.

**Credential.** **None required.** `requiredSecrets: []`. If `COINGECKO_API_KEY`
happens to be present it is appended as `x_cg_demo_api_key`; otherwise the public
tier is used.

**Incrementality.** None, by nature — these are current-value snapshots, and each run
records the value as of that moment. Facts are keyed by a deterministic external id
so re-collection upserts.

**Rate limits.** Token bucket derived from `rateLimitPerMinute` in
`config/sources.yaml` (30/min). URLs are redacted in warning text before being
surfaced.

**Health.** Any warning degrades the collector to `DEGRADED`.

**Enabled:** `true`. **Current status: OK** on the public tier.

---

## fred

**What it collects.** Observations for the macro series listed in
`config/watchlists.yaml`, emitted as `CollectedFact`s of kind `macro`.

**Endpoints.** `https://api.stlouisfed.org/fred/series/observations?series_id=…&
observation_start=…&file_type=json&api_key=…`.

**Credential.** **Required** — `FRED_API_KEY`. `requiredSecrets: ["FRED_API_KEY"]`,
and `collect()` short-circuits to `health: "DISABLED"` when it is absent. Note that
FRED takes the key as a query parameter; the URL is redacted (`redactUrl`) before it
appears in any warning.

**Incrementality.** A per-series cursor holding the last observed date. Next run
requests `observation_start` = the day *after* it; if nothing new came back the
cursor — and therefore the window — does not move. Falls back to
`ctx.since` (date only) when there is no cursor for a series.

**Rate limits.** `TokenBucket{capacity: 2, refillPerSecond: 2}`.

**Health.** Warnings degrade: `DEGRADED` if any facts came through, `FAILED` if none
did.

**Enabled:** `true`. **Current status: DISABLED** (no `FRED_API_KEY`).

---

## sec

**What it collects.** Recent filings for the watchlisted companies that have a CIK on
file, as items plus a `filing`-kind fact per filing. Companies with no CIK are
skipped with a warning.

**Endpoints.** `https://data.sec.gov/submissions/CIK{cik}.json`. Item URLs point at
`https://www.sec.gov/Archives/edgar/data/{cik}/{accession}/{primaryDoc}`, falling back
to the EDGAR browse URL when the primary document is unknown.

**Credential.** **None** — `requiredSecrets: []`. But it has a hard non-secret
prerequisite: `SEC_USER_AGENT`, read through `ctx.config` (which resolves
`config/sources.yaml`'s SEC-only `userAgent` field), **not** through `ctx.secret`.
The code comment explains the distinction: the contact User-Agent is mandated by SEC
policy but is a public, loggable string, not a credential. Without it, `collect()`
returns `health: "DISABLED"` with "SEC_USER_AGENT is required (SEC policy mandates a
descriptive contact UA) and not configured".

**Incrementality.** A date watermark: filings with `filingDate < ctx.since` (date
only) are skipped. No stored cursor.

**Rate limits.** `TokenBucket{capacity: 10, refillPerSecond: 10}` — the code notes
SEC's stated limit is 10 req/sec across all their endpoints.

**Enabled:** `false`, and `config/sources.yaml` says why: EDGAR requires a real
"Name email@example.com" on every request and will rate-limit or block an IP that
omits or fakes one, so there is no safe placeholder to ship. Set `userAgent`, then
flip `enabled: true`. **Current status: DISABLED** on both counts.

---

## reddit

**What it collects.** New posts from the subreddits in `config/watchlists.yaml`
(`subreddits`), plus a set of keyword searches held as a module constant — there is
no schema field for keyword searches yet, and the code says so.

**Endpoints.** With OAuth: `https://oauth.reddit.com/r/{sub}/new.json?limit=25` and
`/search.json?q=…&sort=new&limit=25`. Without: the same paths on
`https://www.reddit.com`. The token itself comes from
`POST https://www.reddit.com/api/v1/access_token` with HTTP Basic client credentials.

**Credential.** **Optional, and paired** — `REDDIT_CLIENT_ID` +
`REDDIT_CLIENT_SECRET`. `requiredSecrets: []`. `check()` flags the half-configured
case explicitly ("only one of REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET is set; falling
back to public .json endpoints"). A failed token request warns "degrading to public
.json endpoints" and continues.

**Incrementality.** None via cursor: each run reads the current `new` listing and
search results, then deduplicates. Idempotency comes from the deterministic item id,
not from a resume token.

**Rate limits.** `TokenBucket{capacity: 1, refillPerSecond: 1}` with OAuth, `0.5`
without.

**Enabled:** `false`. **Current status: DISABLED** — disabled in config, and no OAuth
credentials present either.

---

## youtube

**What it collects.** Two passes. First, per-channel RSS for the channels in
`config/watchlists.yaml` (`youtube_channels`) — always attempted, no key needed.
Second, Data API keyword discovery — only when a key is present. Results are
deduplicated across both. Warns "no YouTube channels configured" when the watchlist
is empty.

**Endpoints.** `https://www.youtube.com/feeds/videos.xml?channel_id={id}` and, with a
key, `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date
&q=…`.

**Credential.** **Optional** — `YOUTUBE_API_KEY`. `requiredSecrets: []`. `check()`
reports "RSS + Data API discovery enabled" or "RSS only (YOUTUBE_API_KEY absent, Data
API discovery disabled)".

**Incrementality.** None via cursor; deduplication plus deterministic item ids.

**Rate limits.** `TokenBucket{capacity: 2, refillPerSecond: 2}`, 15s timeout, 3
attempts.

**Enabled:** `false`. **Current status: DISABLED** — disabled in config. Were it
enabled, it would run RSS-only, since no `YOUTUBE_API_KEY` is present.

---

## What to do about it

To move a source from DISABLED to OK, supply its secret (env var or Keychain — see
`docs/SECURITY.md` for the resolution order) and, for `sec`, `reddit` and `youtube`,
flip `enabled: true` in `config/sources.yaml`. For `sec`, set `userAgent` to a real
contact string first; leaving it blank is the reason it ships disabled.

Every collector implements `check(ctx)`, which probes configuration and credentials
without doing a full collection, and `/admin/sources` in the web reader surfaces
collector health, throughput, latency and credential-blocked sources.
