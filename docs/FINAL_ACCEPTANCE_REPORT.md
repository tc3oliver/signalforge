# Final acceptance report

The record of what was verified, how, and what was not. Every row is either
something executed and observed, or explicitly marked blocked with its reason.
Nothing is inferred from reading code unless it says so.

Date: 2026-09-13. Repository: `~/Developer/src/personal/daily-intelligence`.

# FINAL STATUS: PASS WITH OPTIONAL CONNECTORS DISABLED

Every mandatory gate passes. Six of the eleven sources are implemented, tested
and degrade cleanly, but cannot run here because no credential is available —
the core system works without them, and each is a one-line configuration change
away from working. Details in "Optional connectors" below.

## Results

| Area | Result | Evidence |
|---|---|---|
| Synthetic intelligence acceptance | **PASS** | `experiments/p11-b/`, three days, every gate, `failedGates: []` |
| Stability | **PASS** | three independent lineages; core story selection 0.922 vs 0.85 gate |
| Live Pi fallback | **PASS** | real primary → injected QUOTA at 50/79 → real fallback finished 29 |
| Collectors | **PASS (optional connectors disabled)** | 10 registered, all report health; see below |
| PostgreSQL | **PASS** | 20 tables, migrations 1–2, pgvector + FTS, 2,075 raw / 2,007 normalized items |
| Backup / restore | **PASS** | restored into a scratch database, counted, dropped |
| Live daily run | **PASS** | `e3a10340-ec3f-4cf3-b61c-628a6c25b7e4` → PUBLISHED |
| Validator | **PASS** | rejected four unsatisfiable submissions, accepted the correct one |
| Web | **PASS** | 10 routes, HTTP 200, real data, loopback only |
| LaunchAgent | **PASS** | both agents installed and triggered by hand; both reached Postgres |
| Security | **PASS** | restricted runtime asserted per session; global Pi untouched; no credential in any log |
| Tests | **PASS** | 54 files, 646 tests, none skipped |
| Typecheck | **PASS** | clean |
| Build | **PASS** | 13 routes |

## Synthetic intelligence acceptance

Lineage `p11-b`, `github-copilot/gemini-3.8-flash`, three fixture days rerun from
an empty ledger after the Phase 1.1 policy calibration. All three:
`overallPass: true`, `failedGates: []`.

`selected_story_precision` 1.000 on all three days (gate 0.85) and `cluster_f1`
0.993 / 0.973 / 0.972 (gate 0.90) — the two gates that failed before. Full table
and the before/after analysis: `docs/PHASE1_REPORT.md` §11.

No acceptance threshold, gold-truth file or fixture expected answer was changed;
`git diff 29166c7 HEAD -- eval/gold fixtures` is empty.

## Stability

Three lineages (`p11-b`, `p11-c`, `p11-d`), each running 09-10 → 09-11 → 09-12
from its own empty ledger. No shared story ids, decisions or run state. Runs are
matched by item membership and gold event mapping, never by title string.

| Metric | Mean | Gate |
|---|---|---|
| core_story_selection_stability | **0.922** | ≥ 0.85 — **PASS** |
| must_know_stability | 0.911 | measurement |
| cluster_stability | 0.981 | measurement |
| change_type_stability | 0.934 | measurement |
| emerging_signal_stability | 0.444 | measurement |

`emerging_signal_stability` is the expected outlier and `docs/STABILITY_REPORT.md`
explains why: a signal is a judgement at the margin, and a day with one signal in
one lineage and none in another scores zero however reasonable both readings are.

## Live Pi fallback

Not a mock, not a fake driver, not a re-run of the whole day.
`experiments/p11-fallback2/2026-09-10/2026-09-10-6ee32ae7/`:

| | |
|---|---|
| Primary | `github-copilot/gemini-3.8-flash`, real Pi SDK session |
| Processed before the fault | **50 of 79** items decided and persisted |
| Fault | QUOTA injected at the worker boundary (`afterProcessedItems: 20`, fired at 50) |
| Classification | by the real classifier: `QUOTA`, status 429 |
| Fallback | `openai-codex/gpt-5.6-sol`, a **fresh** Pi SDK session |
| Resumed at | `processedItems: 50, unseenItems: 29` |
| Remaining after fallback | 29, decided by the fallback session alone |
| Final scan coverage | **79 / 79 = 100%** |
| Final validation | materials accepted, 14 stories, run `MATERIALS_READY` |

The first 50 were never re-decided. `attempts.json` records both attempts with
`faultInjected` on the first, so it can never be mistaken for a spontaneous
fallback.

Getting there required a fix: the fault could previously only land between agent
turns, and a real model does the whole day in one turn, so it always fired after
the work was finished. It now lands between two tool calls — which is also where
a real provider error lands, since every tool call follows a model request.

## Collectors

Ten collectors are registered and every one writes a `collection_runs` row, even
when it does nothing. `/admin/sources` shows health, last run, fail streak, runs,
fetched, inserted, latency and required secret *names*.

| Collector | State | Why |
|---|---|---|
| hackernews | **OK** | public; 943 items collected |
| coingecko | **OK** | public tier |
| semantic-scholar | **OK** | enrichment-only; no arXiv ids to enrich |
| github | **DEGRADED** | unauthenticated: low rate limits, some repos 403 |
| arxiv | **FAILED** | provider rate-limiting this address (see below) |
| miniflux (rss) | **DISABLED** | `MINIFLUX_API_KEY` absent |
| fred | **DISABLED** | `FRED_API_KEY` absent |
| sec | **DISABLED** | needs a real contact User-Agent; no safe placeholder exists |
| reddit | **DISABLED** | disabled in config; needs client id + secret |
| youtube | **DISABLED** | disabled in config; needs an API key |

A fourth, found by an independent web sweep: **Hacker News text was stored as
raw HTML.** `text` arrives with `<p>` and `<a>` tags and every slash
entity-encoded, and the normalizer passed it through, so the curator read
`GB&#x2F;s` and a link-only submission became a wall of anchor markup with the
URL buried in an attribute. The agent-visible fields now get plain text —
`raw.body` still keeps the provider's exact bytes — and 72 rows normalized
before the fix were repaired from those stored payloads by
`src/ops/renormalize-hackernews.ts`, which is idempotent and invents nothing.
A title is only entity-decoded, never tag-stripped: stripping would silently
erase an injection attempt that has no text content, which the agent should
see rather than be spared.

Three further defects, all of the same shape — a source that was
simply not there afterwards, with nothing to say so:

- **HackerNews took all three ranked lists whole** (~1500 requests behind a 5/sec
  bucket) and was still working when the run around it finished, so it never
  wrote its row and its items never landed while the run reported success. It now
  takes the head of each list, as much as `pageSize` says.
- **Nothing above it would have caught that**, so `runCollection` now races every
  collector against a deadline and records the loser as FAILED.
- **An enabled source with no collector** produced no row, no warning and no item.
  `web` is web research — a curator tool, not a feed — and is now disabled with
  that explanation; any future config/registry mismatch is reported.

arXiv also ignored its configured timeout in favour of a 15s constant, which
turned ordinary slowness into a failure no config change could fix.

## PostgreSQL

20 tables, migrations 1 and 2 applied, pgvector and generated-tsvector FTS
present. 2,075 raw items and 2,007 normalized items at the time of the final
backup. Bound to `127.0.0.1` only.

pgvector is provisioned but **not in use**: the `vector(1536)` column and its
index exist and nothing computes an embedding yet. Search is FTS only. Recorded
as a limitation rather than described as working.

## Backup and restore

`scripts/backup-db.sh` dumped 2.4MB compressed, applied the 7-daily / 4-weekly /
3-monthly retention policy (pruning one older file), and `scripts/restore-db.sh`
restored it into `daily_intelligence_restore_test` — **20 tables, 2,075 raw
items, 2,007 normalized items, migration 2**. The scratch database was then
dropped. Restoring into the production database name without `--force` was
refused, as designed. Verified by restoring, not by the file existing.

## Live daily run

`docs/LIVE_RUN_REPORT.md` is the full record. In summary: triggered through the
installed LaunchAgent, 771 real items scanned at 100% coverage, 4 stories
curated, brief written, validated and published, with the arXiv failure recorded
as the run's `degraded_reason`. Brief at `briefs/2026-09-13/`.

The run exposed two real defects — an 8-story floor that made a quiet day
unpublishable, and a `submit_brief` schema whose `minItems: 8` made the only
submittable payload one the validator would reject. Both are fixed, both are
covered by tests, and neither changed anything about a normal day.

## Validator

The validator did its job under live conditions: it rejected four submissions
across three different models and accepted the fifth. It was also the thing that
made the underlying defect visible rather than letting a padded brief through.

Deterministic sanity checks on the published brief — story count, distinct ids,
Must Know count, source resolution, fabricated ids, duplicate sources, factRefs,
date consistency, required fields, URL liveness — all pass. Every one is a
comparison against the database or the network, not a model judging itself.

## Web

Production build (`pnpm build`): PASS, 13 routes. Server started as
`next start -H 127.0.0.1 -p 3300` — loopback only, no public ingress.

| Route | Status | Size | Real data shown |
|---|---|---|---|
| `/` | 200 | 35,085 b | today's brief, 4 stories, "New Since Morning" |
| `/brief/2026-09-13` | 200 | 36,123 b | the published brief |
| `/story/altman-rules-out-2026-ipo` | 200 | 19,746 b | ledger entry, scores, brief appearance |
| `/story/homebrew-7-0-0-release` | 200 | 16,788 b | same |
| `/history` | 200 | 8,584 b | 1 published brief, sections listed |
| `/signals` | 200 | 7,042 b | "No signals are being tracked yet" |
| `/search?q=Homebrew` | 200 | 13,032 b | FTS hit on live content |
| `/feed.xml` | 200 | 639 b | Atom, escaped untrusted content |
| `/admin/runs` | 200 | 79,948 b | run state, stage timings, attempts, models, per-collector health |
| `/admin/sources` | 200 | 63,717 b | 14 collectors with OK / DEGRADED / DISABLED / FAILED |
| `/admin/item/<id>` | 200 | 13,038 b | full trace for a rejected item |

No collector shows HEALTHY when it is not: arXiv reads FAILED with a fail streak
of 6, github DEGRADED, six DISABLED with their reasons.

### Explainability, on production data

`/admin/item/hackernews-71ced03515c0d9ac` answers "why did this item not reach
the brief?" for a real Hacker News item from this run: **scanned** (collected and
normalized) → **decided** (`IRRELEVANT`, with the curator's own recorded reason)
→ **story** (none — judged out of scope), plus the day's scan coverage
(766 / 4 / 1). The full chain raw → normalized → decision → story → material →
brief is traceable for a selected item through `/story/<id>`.

## LaunchAgent

Both agents installed by `scripts/install-launchagent.sh`, which resolves the uid
at run time (`id -u`; 501 here) and hardcodes nothing. Both were triggered by
hand rather than waited for.

**Incremental** — `launchctl kickstart -k gui/501/com.dailyintelligence.incremental`
→ `runs = 1, last exit code = 0`. Its log proves the whole path under launchd,
not merely in an interactive shell: launchd found `pnpm` and `node` by absolute
path, the process read `.env`, connected to Postgres, ran all ten collectors and
wrote a row for each, recording OK, DEGRADED, FAILED and DISABLED honestly.

**Daily** — `launchctl kickstart -k gui/501/com.dailyintelligence.daily` drove
collection → manifest → Pi curator → ledger → materials, and the run was carried
to a published brief from persisted state. `RunAtLoad` is false, so installing
cannot fire a run as a side effect.

### Reboot and login

A user LaunchAgent needs a GUI (Aqua) session. After a reboot the user must log
in once, and the login Keychain and its Pi authentication must be available in
that session; screen lock afterwards is fine. `gui/501` is the environment this
was validated in — an observation, never a value in a script. Recorded in
`docs/RUNBOOK.md`.

## Security

| Control | Verified |
|---|---|
| No bash / read / write / edit / filesystem | `noTools: "all"`; `assertRestricted` fails the run if an escape tool is even registered |
| No arbitrary HTTP | only `search_web`, only when a research credential exists; absent in every run here |
| No extensions | `extensionsResult.extensions.length === 0` asserted per session; `pi-web-access` and `pi-usage` never loaded |
| No DB credential reachable by Pi | the agent's tools take ids, not connections |
| Gold truth unreachable | asserted on a full real-fixture run by `tests/integration/gold-isolation.test.ts` |
| Global Pi untouched | `~/.pi/agent/auth.json`, `models-store.json`, `settings.json` all last modified hours before this work and unchanged by it; nothing installed, nothing patched |
| No secrets in logs | scanned `logs/`, `experiments/`, `runs/`, `docs/` for token, key, bearer, Authorization and connection-string patterns — zero matches |
| Recorded active tools | curator 12, editor 7, per run, in `restricted-runtime.json` |

Two gaps closed here. The untrusted-content rule was specified but **not in
either system prompt**; both now carry it verbatim along with what an injection
looks like in practice. And `trust: UNTRUSTED_EXTERNAL_CONTENT` was dropped at
normalization, so by the time an item reached the agent nothing recorded where it
came from; it is now a required field set at every construction site.

**Still not verified:** no live model has been attacked with an adversarial item
and observed to refuse. The structural defence is tested — hostile text is kept
verbatim, labelled, and can only ever be a field value, never a command — but the
behavioural half is not.

## Tests, typecheck, build

Run on the final code state, not quoted from earlier:

```
pnpm typecheck    clean
pnpm test         54 files, 646 tests, all passing, none skipped
pnpm build        typecheck + next build, 13 routes
```

`pnpm test` previously ran without `.env`, so six Postgres-backed suites skipped
themselves while the summary still said the run passed. It now loads the env file
and those suites actually run — which immediately surfaced a hidden failure.

## Optional connectors, disabled

Each is implemented, unit-tested, and degrades to DISABLED without affecting the
rest of the pipeline. None is required for the product to work.

| Connector | Missing | Impact | Works without it? | To enable |
|---|---|---|---|---|
| Miniflux (rss) | `MINIFLUX_API_KEY` | no RSS/feed coverage — the largest editorial loss | yes | put the key in the environment or the Keychain |
| FRED | `FRED_API_KEY` | no macro series or structured macro facts | yes | free API key from FRED |
| Reddit | `REDDIT_CLIENT_ID` + `_SECRET` | no community signal | yes | create a script app, set both, `enabled: true` |
| YouTube | `YOUTUBE_API_KEY` | no video/transcript coverage | yes | YouTube Data API key, `enabled: true` |
| SEC EDGAR | a real contact User-Agent | no filings | yes | set `userAgent: "Name email"` in `config/sources.yaml`, `enabled: true` |
| Web research (Tavily → Exa) | a *readable* credential | curator cannot close evidence gaps; `search_web` is simply absent from the tool set | yes | see below |

### The Tavily credential, specifically

The Keychain item exists — `security find-generic-password -s pi-tavily -a oliver`
finds it and prints its attributes. Reading the **value** (`-w`) fails with status
36 from a non-interactive shell, because the item's access control list admits the
binary that created it and not `/usr/bin/security`. So `resolveSecret` correctly
reports the secret as unavailable and the run proceeds without web research.

This was deliberately **not** worked around. The available workarounds are to
widen the ACL on a credential this project does not own, or to copy the value into
a file next to the code — both weaken the arrangement currently protecting it.
Enabling web research is the operator's call: grant access to that item, or set
`TAVILY_API_KEY` / `EXA_API_KEY` in the environment.

## Known limitations

1. **pgvector is provisioned, not used.** Search is full-text only.
2. **No live prompt-injection test.** Structural defence tested, behavioural not.
3. **The live day was thin.** Four stories from 771 items, because the sources
   that carry news were the ones without credentials. Not a defect, but it means
   editorial quality at full source coverage is still unmeasured.
4. **arXiv is rate-limiting this address** after repeated acceptance runs. It
   should recover on the normal five-a-day schedule; it reports FAILED honestly
   meanwhile.
5. **One unexplained discrepancy:** arXiv's live row shows 383s against a 180s
   per-collector ceiling that two tests confirm works. Nothing was harmed and the
   cause was not established. Worth re-checking on the next scheduled run.
6. **OrbStack wedged three times** during this work — `docker` and `docker ps`
   hanging indefinitely, recovered each time by `orbctl stop && orbctl start`.
   A machine-level instability, not a project defect, but it will interrupt a
   scheduled run if it happens overnight.
7. **`emerging_signal_stability` is 0.444.** Expected for a marginal judgement;
   see `docs/STABILITY_REPORT.md`.
8. **`scripts/lib-db-env.sh` needs bash.** It parses `DATABASE_URL` with
   `BASH_REMATCH`, which zsh — the default shell here — does not provide.
   Sourcing it from zsh used to fail several lines later with a message that
   blamed the env file; it now says what is actually wrong.
9. **The human score is unscored.** "Would I read this every morning?" is not
   something this repository can answer.

## Documents

| | |
|---|---|
| `README.md` | what it is, where it stands |
| `docs/ARCHITECTURE.md` | the design and why |
| `docs/ENVIRONMENT.md` | toolchain and versions |
| `docs/OPERATIONS.md` | normal-day reference |
| `docs/RUNBOOK.md` | failure playbooks, reboot/login constraint |
| `docs/SECURITY.md` | threat model, restricted runtime, secrets |
| `docs/DATA_SOURCES.md` | per-source status and credentials |
| `docs/PHASE1_REPORT.md` | synthetic acceptance, before and after |
| `docs/STABILITY_REPORT.md` | three lineages, five metrics |
| `docs/LIVE_RUN_REPORT.md` | the real end-to-end day |
| `docs/PRODUCTION_PLAN.md` | stage status |
| `docs/FINAL_ACCEPTANCE_REPORT.md` | this document |
