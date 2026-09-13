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
| 0.4 | Policy behaviour regression tests (evaluator discriminates) | WIP |
| 0.5 | Experiment-scoped lineage (`resolvePaths(root, experiment)`) | DONE |
| 0.6 | Clean 3-day rerun, all gates PASS | WIP |
| 0.7 | Stability tooling + 3 lineages, selection Jaccard >= 0.85 | WIP |
| 0.8 | Fault injection capability + live fallback validation | WIP |
| 0.9 | Initial git commit of verified prototype | TODO |

## Stage 1 — Contracts

| # | Task | Status |
|---|---|---|
| 1.1 | `config/*.yaml` + typed loader (interests, watchlists, sources, discovery, agent) | TODO |
| 1.2 | Collector contract (`src/collectors/types.ts`) | TODO |
| 1.3 | Untrusted-content tagging contract | TODO |

## Stage 2 — Data plane

| # | Task | Status |
|---|---|---|
| 2.1 | `compose.yaml` — Postgres + pgvector on OrbStack | TODO |
| 2.2 | Migration system + full schema | TODO |
| 2.3 | `PostgresStoryRepository` behind existing interface | TODO |
| 2.4 | Collectors: HN, GitHub, arXiv, Semantic Scholar | TODO |
| 2.5 | Collectors: CoinGecko, FRED, SEC, Reddit, YouTube, Miniflux | TODO |
| 2.6 | Web research: Tavily -> Exa routing, DEGRADED marking | TODO |
| 2.7 | Structured fact extraction from collected data | TODO |

## Stage 3 — Production pipeline

| # | Task | Status |
|---|---|---|
| 3.1 | Production run state machine (CREATED..PUBLISHED + failures) | TODO |
| 3.2 | `search_web` curator tool with budget limits | TODO |
| 3.3 | Emerging signal persistence + lifecycle state | TODO |
| 3.4 | Explainability trace (why an item did not reach the brief) | TODO |
| 3.5 | Publish path into Postgres | TODO |

## Stage 4 — Web

| # | Task | Status |
|---|---|---|
| 4.1 | Next.js app + DB read layer (no LLM on request path) | TODO |
| 4.2 | `/`, `/brief/[date]`, `/story/[id]`, `/history`, `/signals`, `/search` | TODO |
| 4.3 | `/admin/runs`, `/admin/sources` | TODO |
| 4.4 | FTS + pgvector search | TODO |

## Stage 5 — Operations

| # | Task | Status |
|---|---|---|
| 5.1 | LaunchAgent plist + install/uninstall scripts, `gui/<uid>` | TODO |
| 5.2 | Backup/restore scripts + proven restore | TODO |
| 5.3 | Health and observability surface | TODO |

## Stage 6 — Acceptance

| # | Task | Status |
|---|---|---|
| 6.1 | Live end-to-end daily run on real sources | TODO |
| 6.2 | Web acceptance | TODO |
| 6.3 | LaunchAgent manual trigger acceptance | TODO |
| 6.4 | `docs/FINAL_ACCEPTANCE_REPORT.md` | TODO |

## Requires the user (collected here, raised at the end)

| Item | Why | Status |
|---|---|---|
| (to be filled as discovered) | | |
