# Live run report

> **Superseded in part.** This describes the first production run, made before the
> operator supplied credentials — its brief is kept as
> `briefs/2026-09-13/2026-09-13.v1.*` and as drafts 1-3 in the database. The run
> made with Miniflux, GitHub, FRED, YouTube and Tavily enabled is
> `docs/CONNECTOR_ENABLEMENT_REPORT.md`, which doubles the day's stories from four
> to eight. Everything below remains accurate as a record of what was true then.

The first end-to-end production run: real collectors, real Postgres, real Pi
sessions, no fixture and no gold truth. Triggered by hand through the installed
LaunchAgent rather than waited for, so the scheduled path is the path that was
tested.

Everything below is read out of the database and the run logs. Where a number
could not be obtained it says so rather than being estimated.

## Identity

| | |
|---|---|
| Date | 2026-09-13 |
| Run id | `e3a10340-ec3f-4cf3-b61c-628a6c25b7e4` |
| Lineage | `default` |
| Triggered by | `launchctl kickstart -k gui/501/com.dailyintelligence.daily` at 09:58:29 UTC |
| Collection window | 2026-09-13 00:00:00Z — 2026-09-14 00:00:00Z (UTC day, by `published_at`) |

The uid in that command is what `id -u` resolved to on this machine. No script
contains it; see `docs/RUNBOOK.md`.

## Collection

Ten collectors ran. One row per collector was written to `collection_runs`,
including for the ones that did nothing — which is the point: a source that is
unavailable has to be visible as unavailable.

| Collector | Health | Items fetched | Latency | Why |
|---|---|---|---|---|
| coingecko | OK | 6 | 10.2s | public tier, no key needed |
| hackernews | OK | 1 | 1.7s | incremental; the bulk had been collected minutes earlier |
| semantic-scholar | OK | 0 | 0ms | enrichment-only, and arXiv produced no ids to enrich |
| github | DEGRADED | 0 | 2.7s | unauthenticated: some watchlist repos answer 403, rate limits are low |
| arxiv | FAILED | 0 | 383s | `Timeout` — the export API is rate-limiting this address |
| miniflux | DISABLED | 0 | 0ms | `MINIFLUX_API_KEY` absent |
| fred | DISABLED | 0 | 0ms | `FRED_API_KEY` absent |
| sec | DISABLED | 0 | 0ms | disabled in `config/sources.yaml`; needs a real contact User-Agent |
| reddit | DISABLED | 0 | 0ms | disabled in `config/sources.yaml` |
| youtube | DISABLED | 0 | 0ms | disabled in `config/sources.yaml` |

`daily_runs.degraded_reason` for this run reads `arxiv unavailable: Timeout`.
The run continued, which is the intended behaviour: one provider being down
degrades a day, it does not end it.

**Items available to the curator: 771 normalized items** in the day window
(550 github, 215 hackernews, 7 rss, 3 coingecko, 1 fred), built by
`buildManifestFromDb` from what previous incremental runs had already stored.
Reading rather than re-collecting is what makes the later stages retryable.

**One discrepancy, recorded rather than explained away.** arXiv's row shows 383s,
above the 180s per-collector ceiling added earlier the same afternoon. The
ceiling is covered by two tests — against a collector that never settles and
against one that returns far too late — and both pass. The live row does not
match them and the cause was not established. Nothing was harmed: arXiv reported
FAILED with its reason and the run went on. Worth re-checking on the next
scheduled run.

## Curation

| | |
|---|---|
| Model | `github-copilot/gemini-3.8-flash` (primary, first attempt) |
| Attempts | 1, SUCCESS. No fallback, no corrective retry. |
| Duration | 454s (7m 34s) |
| Scan coverage | **771 / 771 = 100%** |

Dispositions:

| Disposition | Count |
|---|---|
| IRRELEVANT | 766 |
| CANDIDATE | 4 |
| DUPLICATE | 1 |

A 99% rejection rate is the honest shape of this particular day, not a
malfunction. 550 of the 771 items are individual GitHub repository events from
the watchlist, which are almost never daily-brief material, and the sources that
would have carried actual news — Miniflux, Reddit, YouTube, SEC, arXiv, and web
research through Tavily — were all unavailable for want of a credential or
because of provider back-pressure. The curator scanned every item and said why
it rejected each one; `/admin/item/<id>` shows that reason for any of them.

**Materials: 4 stories** (2 tier A, 2 tier B), all `changeType: NEW` — there was
no prior ledger history in this lineage to continue.

| Story id | Tier |
|---|---|
| `altman-rules-out-2026-ipo` | A |
| `homebrew-7-0-0-release` | A |
| `bengio-agents-deception-alignment` | B |
| `revolut-fake-edr-data-breach` | B |

## What the live run found that tests did not

The editor required a brief of 8 to 15 stories. On this day there were four.
That combination made a quiet morning unpublishable — the pipeline would have
exhausted the model chain and failed the day for the sole reason that the world
had been quiet, which is a worse outcome than a short brief.

The floor now follows the material count: eight when there is enough for eight,
otherwise all of it, with fifteen still the ceiling. A normal day is unchanged,
and the synthetic acceptance gate on `final_story_count` was not touched. The
editor stage was then re-run against the already-curated day with
`pnpm daily --resume <run-id> --stage write`, which is the documented resume
path: no re-collection, no re-curation, no second pass over 771 items.

## Writing, validation and publication

| | |
|---|---|
| Model | `github-copilot/gemini-3.8-flash` |
| Attempts on the accepted run | 1, SUCCESS, no rejection and no fallback |
| Brief stories | **4** (2 Must Know) |
| Emerging signals | 0 |
| Validation | PASSED |
| State | **PUBLISHED** (degraded: arXiv) |

Brief:

- `briefs/2026-09-13/2026-09-13.json`
- `briefs/2026-09-13/2026-09-13.md`
- `daily_briefs` row, lineage `default`, run `e3a10340-ec3f-4cf3-b61c-628a6c25b7e4`,
  produced 11:52:40 UTC

| Story | Section | Must Know |
|---|---|---|
| `altman-rules-out-2026-ipo` | COMPANIES | yes |
| `homebrew-7-0-0-release` | DEVELOPER_OSS | yes |
| `bengio-agents-deception-alignment` | RESEARCH | no |
| `revolut-fake-edr-data-breach` | DEVELOPER_OSS | no |

### Deterministic sanity checks

No gold truth exists for a live day, so the brief was checked against what can
be verified mechanically. Every check passed:

| Check | Result |
|---|---|
| Story count within today's bound | 4 of 4 materials |
| Distinct storyIds | 4 of 4 — no repeats |
| Must Know count | 2, within 2–4 for a four-story brief |
| Source item ids resolve | 5 of 5 exist in `normalized_items` |
| Fabricated source ids | 0 |
| Duplicate source id inside one story | 0 |
| factRefs valid | 0 used, 0 invalid |
| `date` matches the run's date | yes |
| `producedAt` matches the DB row | yes |
| Required analysis fields present | dailyAnalysis (302 chars), watchNext (3) |
| Source URLs reachable | spot-checked, HTTP 200 by both HEAD and ranged GET |

None of this is a model judging its own work: every check is a comparison
against the database or the network.

### Four attempts were thrown away first, and why

The accepted run above was preceded by four failed editor attempts across all
three models in the chain. Every one of them wrote each of the four stories
twice and was rejected for duplication. That looked like a model failure and
was not: `submit_brief`'s own parameter schema declared `minItems: 8`.

That schema is the contract a model must satisfy to call the tool at all. With
four stories in the materials, the only payload that could be submitted was one
the validator would then reject — an unsatisfiable pair of rules, and the models
were obeying the half that was enforced first. Three independent models
producing the identical wrong shape was the clue; a genuine editorial failure
would not have been that uniform.

The floor now lives only in `validateBrief`, which knows the material count, and
the tool advertises today's real range. The next attempt submitted four stories
and published on its first try, with no rejection and no fallback.

Two of those four wasted attempts were also invisible at first: the daily CLI
passed no `onEvent` handler, so the rejection text never reached the log and the
run recorded only a failure count. That is fixed too — the diagnosis above was
only possible after it was.

## Explainability, on this run's data

`/admin/item/hackernews-71ced03515c0d9ac` answers "why did this item not reach
the brief?" for a real Hacker News item collected in this run:

- **scanned** — collected by `hackernews` and stored as a normalized item
- **decided** — curator decision `IRRELEVANT`, with the curator's own recorded
  reason: 「地緣政治與網路審查新聞,非讀者核心技術/決策範疇」
- **story** — none: the item was judged out of scope, so no story was opened

The same page shows the day's scan coverage (766 / 4 / 1). The trace works on
production data, not only on fixtures.

## Web

Verified against this run's data on a loopback-only production server
(`next start -H 127.0.0.1 -p 3300`); see `docs/FINAL_ACCEPTANCE_REPORT.md` for
the route-by-route results.

## Untouched

`~/.pi/agent/auth.json`, `models-store.json` and `settings.json` were last
modified hours before this work began and are unchanged by it. No Pi extension
was installed; every session asserted zero extensions loaded. No credential
value appears in `logs/daily.out.log`, `logs/daily.err.log`,
`logs/incremental.*.log` or any run artifact.
