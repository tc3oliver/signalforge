# Connector enablement report

What changed when the operator supplied credentials, and what was measured rather
than assumed. Every number below is read from the database, a live provider
response or a test run; no value of any credential appears here or in any log.

## Credential state

Read from `~/.config/daily-intelligence/secrets.env` (mode `600`, in a `700`
directory, outside this repository). Names and states only.

| Key | State |
|---|---|
| `TAVILY_API_KEY` | SET |
| `EXA_API_KEY` | SET |
| `GITHUB_TOKEN` | SET |
| `FRED_API_KEY` | SET |
| `MINIFLUX_URL` | SET |
| `MINIFLUX_API_KEY` | SET |
| `YOUTUBE_API_KEY` | SET |
| `SEMANTIC_SCHOLAR_API_KEY` | EMPTY |
| `REDDIT_CLIENT_ID` | EMPTY |
| `REDDIT_CLIENT_SECRET` | EMPTY |
| `SEC_USER_AGENT` | EMPTY |

No key is MISSING: all eleven placeholders are present in the file.

## Live credential tests

Each ran against the real provider, through the production code path where one
exists. Responses are summarised by shape and count; nothing from a response body
that could carry credential metadata is reproduced.

| Test | Result |
|---|---|
| Tavily search, via `createTavilyProvider` and the real resolver | 3 results returned |
| Tavily Keychain item (`pi-tavily`) | still unreadable — `/usr/bin/security` exits 36 |
| GitHub `/rate_limit`, authenticated | HTTP 200, core limit 5000, 5000 remaining |
| FRED `series/observations` for `FEDFUNDS` | HTTP 200, observations returned |
| Miniflux `/v1/me` and `/v1/entries` | HTTP 200 and HTTP 200, 5602 entries on the instance |
| YouTube `channels?forHandle` and `search` | HTTP 200 both; 3 of 4 watchlist handles resolve |
| Semantic Scholar, anonymous | HTTP 429 — the public tier is rate-limited, which is what a key would fix |

**Tavily works from `secrets.env`, not from the Keychain.** Both facts were
established in the same run: the search succeeded while
`security find-generic-password -s pi-tavily -a oliver -w` still exited 36. The
Keychain item's ACL was not altered and no macOS security control was weakened;
the environment simply wins the resolution order that `src/config/secrets.ts`
has always had.

## What this changed in the code

Four defects surfaced that only a credentialed run could expose.

1. **Miniflux had no way to learn its own address.** `MINIFLUX_API_KEY` is
   useless without the instance URL, and that URL is per-machine, so it cannot
   live in `config/sources.yaml`. `MINIFLUX_URL` now overrides `rss.baseUrl`
   (`applyEnvOverrides`, `src/config/loader.ts`). Without this the collector
   would have authenticated against `http://localhost:8080` and reported a
   connection failure with a correct key in hand.

2. **The YouTube watchlist held @handles; the feed endpoint takes ids.** Every
   handle would have produced a 404 and a collector that looked like it ran.
   Handles are now resolved through the Data API first, and skipped with a stated
   reason when there is no key to resolve them with.

3. **FRED called a quiet day a failure.** Its health rule degraded on any
   warning, and "no new observations since <date>" was a warning. Most economic
   series do not print on most days, so a correctly authenticated FRED reported
   `FAILED` on its first successful run. Problems and notes are now separate, and
   only problems decide health. The same change made a genuinely malformed
   payload detectable: it had been indistinguishable from an empty one, because a
   missing `observations` key defaulted to `[]`.

4. **Re-running a day destroyed the previous brief on disk.** The database keeps
   every draft (`daily_brief_drafts.draft_no`); the files did not. The previous
   pair is now retired to `<date>.v<n>.json` / `.md` before the new one is
   written.

`@sst_dev` in `config/watchlists.yaml` matches no channel. It has been left in
place and YouTube reports `DEGRADED` because of it: a watchlist entry that
quietly contributes nothing should stay visible until it is fixed or removed.

## Collector health, after enablement

Read from `collection_runs` for the production run
`08cf0475-54bc-4930-a1eb-c2e5aa5ef2c0`. "Items fetched" for that run is
incremental — the first authenticated run of the day had already consumed the
backlog, and those figures are given in the last column.

| Source | Enabled | Credential state | Mode | Live test | Items fetched | Health | Reason |
|---|---|---|---|---|---|---|---|
| rss (Miniflux) | yes | SET (URL + key) | authenticated | PASS | 0 this run, 83 on the first | HEALTHY | up to date; cursor already past the backlog |
| github | yes | SET | authenticated | PASS | 209 this run, 1018 on the first | HEALTHY | 5000 req/h |
| hackernews | yes | none needed | public | PASS | 1 | HEALTHY | incremental |
| coingecko | yes | none needed | public | PASS | 6 | HEALTHY | public tier |
| fred | yes | SET | authenticated | PASS | 0 facts | HEALTHY | no configured series printed a new observation today |
| youtube | yes | SET | RSS + Data API | PASS | 55 | DEGRADED | `@sst_dev` matches no channel |
| semantic-scholar | yes | EMPTY | anonymous | PASS (429) | 0 | DEGRADED | no key; public tier throttles, and arXiv produced no ids to enrich |
| arxiv | yes | none needed | public | FAIL | 0 | FAILED | provider answered 429; external back-pressure, unchanged from before |
| sec | no | EMPTY | — | not run | 0 | DISABLED | disabled in config; needs a real contact `SEC_USER_AGENT` |
| reddit | no | EMPTY (both) | — | not run | 0 | DISABLED | disabled in config; needs both client id and secret |
| web (Tavily) | n/a | SET | curator tool | PASS | n/a | HEALTHY | not a collector; reached during curation |

No collector reports HEALTHY without having done the work: the two DEGRADED rows
each name what is wrong, and the two DISABLED rows name what is missing.

## The production run

| | |
|---|---|
| Run id | `08cf0475-54bc-4930-a1eb-c2e5aa5ef2c0` |
| Lineage | `default` |
| Kind | real data, no fixture, no gold truth, no fake driver |
| Curator | `github-copilot/gemini-3.8-flash`, 1 attempt, no fallback |
| Editor | `github-copilot/gemini-3.8-flash`, fresh session, 1 attempt, no rejection |
| Items available | **1295** (github 920, hackernews 287, rss 70, coingecko 12, youtube 6) |
| Scan coverage | **1295 / 1295 = 100%**, 0 unseen |
| Dispositions | 1279 IRRELEVANT, 9 CANDIDATE, 7 DUPLICATE |
| Materials | **8 stories** (4 tier A, 4 tier B), all `NEW` |
| Brief | **8 stories, 3 Must Know**, 1 emerging signal |
| Validation | PASSED (draft 5) |
| State | **PUBLISHED** (degraded: arXiv 429) |

### Against the Hacker-News-only brief

The previous brief is kept, not overwritten: drafts 1-3 remain in
`daily_brief_drafts` under the old run id, and the files were retired to
`briefs/2026-09-13/2026-09-13.v1.json` / `.v1.md` before the new pair was written.

| | Previous (`e3a10340`) | New (`08cf0475`) |
|---|---|---|
| Items to scan | 771 | 1295 |
| Sources contributing | github, hackernews, rss(7), coingecko, fred | github, hackernews, rss(70), coingecko, youtube |
| Materials | 4 | 8 |
| Brief stories | 4 | 8 |
| Must Know | 2 | 3 |
| Emerging signals | 0 | 1 |

Four stories are new, and **every one of them came in through Miniflux**:

| New story | Sources |
|---|---|
| `ai-leaders-call-to-slow-down-development` | 3 rss items |
| `zhipu-ai-5-billion-funding-glm` | 1 rss item |
| `github-outage-database-replication-latency` | 1 rss + 1 hackernews |
| `clarity-act-trump-ethics-clauses` | 1 rss item |

Two of the four carried-over stories also gained rss corroboration
(`altman-rules-out-2026-ipo`, `revolut-fake-edr-data-breach`), so the added
sources improved the sourcing of stories they did not themselves introduce. The
single emerging signal is drawn from the new AI-governance cluster, which did not
exist in the previous day's materials at all.

GitHub contributed 920 of the 1295 items and no stories — the same pattern as
before. Watchlist repository events are rarely daily-brief material; the value of
authenticating it is that the 920 were actually scanned rather than lost to a 403.

### Deterministic validation of the published brief

No LLM judged this. Each check compares the brief against the database or the
network.

| Check | Result |
|---|---|
| Distinct storyIds | PASS — 8 of 8 |
| Every storyId drawn from the materials | PASS — 8 of 8 |
| Every sourceItemId resolves in `normalized_items` | PASS — 15 of 15 |
| Fabricated source ids | PASS — none |
| Duplicate source id within a story | PASS — none |
| factRefs valid | PASS — 0 used, 0 invalid |
| `date` matches the run | PASS |
| `producedAt` matches the DB row | PASS |
| Story count within today's bound | PASS — 8 stories, 8 materials |
| Must Know count within bound | PASS — 3 |
| Required analysis fields | PASS — dailyAnalysis 418 chars, 3 watchNext |
| Source URLs well formed | PASS — 15 of 15 |
| Source URLs reachable | **14 of 15** |

The one unreachable URL is a Reuters article that answers 401 to any
unauthenticated request, with a browser User-Agent as well as without. It is not
fabricated: it is the target of a real Hacker News submission whose raw payload is
stored. A publisher paywall is not a defect in the brief, and it is recorded as a
caveat rather than rounded up to a pass.

### Web

All eight routes served this run's data from a production build on
`127.0.0.1:3300`: `/`, `/brief/2026-09-13`, `/story/zhipu-ai-5-billion-funding-glm`,
`/history`, `/signals`, `/search`, `/admin/runs`, `/admin/sources` — HTTP 200 each.
`/admin/sources` shows the new miniflux and youtube rows with their real health.

### Leakage check

Every non-blank value in `secrets.env` was searched for across all eighteen log
files and brief artifacts. Zero occurrences. Startup logs counts and names only.
