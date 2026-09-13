# Production Build Plan

Tracking document for taking Daily Intelligence from Phase 1 prototype to a
production system that runs itself every morning. Every row is closed by tests +
acceptance evidence, then committed.

Status values: `TODO` / `WIP` / `DONE` / `BLOCKED_EXTERNAL`

## Stage 0 — Foundation (in flight)

| # | Task | Status |
|---|---|---|
| 0.1 | Editorial policy calibration (Standalone Value Test, Event Identity Test) | DONE |
| 0.2 | `brief-validator` signal-scope fix (signals may cite unpublished materials) | DONE |
| 0.3 | Policy document regression tests | DONE |
| 0.4 | Policy behaviour regression tests (evaluator discriminates) | DONE |
| 0.5 | Experiment-scoped lineage (`resolvePaths(root, experiment)`) | DONE |
| 0.6 | Clean 3-day rerun, all gates PASS | DONE (p11-b, 3/3 PASS; p11-a exposed a recall regression, policy corrected) |
| 0.7 | Stability tooling + 3 lineages, selection Jaccard >= 0.85 | DONE (p11-b/c/d; 0.922) |
| 0.8 | Fault injection capability + live fallback validation | DONE (live: 50/79 on the primary, 29 on the fallback) |
| 0.9 | Initial git commit of verified prototype | DONE |

## Stage 1 — Contracts

| # | Task | Status |
|---|---|---|
| 1.1 | `config/*.yaml` + typed loader (interests, watchlists, sources, discovery, agent) | DONE |
| 1.2 | Collector contract (`src/collectors/types.ts`) | DONE |
| 1.3 | Untrusted-content tagging contract | DONE |

## Stage 2 — Data plane

| # | Task | Status |
|---|---|---|
| 2.1 | `compose.yaml` — Postgres + pgvector on OrbStack | DONE |
| 2.2 | Migration system + full schema | DONE |
| 2.3 | `PostgresStoryRepository` behind existing interface | DONE |
| 2.4 | Collectors: HN, GitHub, arXiv, Semantic Scholar | DONE |
| 2.5 | Collectors: CoinGecko, FRED, SEC, Reddit, YouTube, Miniflux | DONE |
| 2.6 | Web research: Tavily -> Exa routing, DEGRADED marking | DONE |
| 2.7 | Structured fact extraction from collected data | DONE |

## Stage 3 — Production pipeline

| # | Task | Status |
|---|---|---|
| 3.1 | Production run state machine (CREATED..PUBLISHED + failures) | DONE |
| 3.2 | `search_web` curator tool with budget limits | DONE |
| 3.3 | Emerging signal persistence + lifecycle state | DONE |
| 3.4 | Explainability trace (why an item did not reach the brief) | DONE (verified on live data) |
| 3.5 | Publish path into Postgres | DONE |

## Stage 4 — Web

| # | Task | Status |
|---|---|---|
| 4.1 | Next.js app + DB read layer (no LLM on request path) | DONE |
| 4.2 | `/`, `/brief/[date]`, `/story/[id]`, `/history`, `/signals`, `/search` | DONE |
| 4.3 | `/admin/runs`, `/admin/sources` | DONE (plus `/admin/item/[id]`) |
| 4.4 | FTS + pgvector search | PARTIAL — FTS only. The `vector(1536)` column and its index exist; nothing computes an embedding yet |

## Stage 5 — Operations

| # | Task | Status |
|---|---|---|
| 5.1 | LaunchAgent plist + install/uninstall scripts, `gui/<uid>` | DONE (installed and loaded) |
| 5.2 | Backup/restore scripts + proven restore | DONE (restore proven) |
| 5.3 | Health and observability surface | DONE (`/admin`, `/admin/runs`, `/admin/sources`) |

## Stage 6 — Acceptance

| # | Task | Status |
|---|---|---|
| 6.1 | Live end-to-end daily run on real sources | DONE — see `docs/reports/LIVE_RUN_REPORT.md` |
| 6.2 | Web acceptance | DONE — see `docs/reports/FINAL_ACCEPTANCE_REPORT.md` |
| 6.3 | LaunchAgent manual trigger acceptance | DONE — both agents kickstarted |
| 6.4 | `docs/reports/FINAL_ACCEPTANCE_REPORT.md` | DONE |

## Requires the user (collected here, raised at the end)

| Item | Why | Status |
|---|---|---|
| (to be filled as discovered) | | |
