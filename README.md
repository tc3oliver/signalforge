# Daily Intelligence

A personal daily-intelligence pipeline. Collectors gather the day's raw items into
Postgres; a restricted Pi "Curator" agent scans **every** item, deduplicates and
clusters them into stories, compares them against a cross-day story ledger, and
judges novelty and importance; a separate, fresh Pi "Editor" session writes the
morning brief from the curated materials; deterministic validators gate publication;
a Next.js reader renders what was published.

It runs on one machine, for one person, on a schedule.

## What it is not

- **Not a product, and not multi-tenant.** One reader, one machine, one database.
- **Not publicly reachable.** Postgres binds `127.0.0.1` only, the web app binds
  `127.0.0.1:3300`, and no public ingress of any kind is permitted — see `AGENTS.md`.
- **Not an autonomous agent with a shell.** The agent sessions have no bash, no
  filesystem (beyond one narrowly-rooted skill-reference reader), no arbitrary HTTP,
  and no credentials. See `docs/SECURITY.md`.
- **Not finished.** The synthetic acceptance harness passes (below), but the live
  end-to-end run on real sources, the stability sweep and the LaunchAgent install
  have **not** happened. `docs/PRODUCTION_PLAN.md` tracks what is left.
- **Not currently collecting from credentialed sources.** No collector credential is
  present in `.env` or the environment, so those sources report `DISABLED` or run in
  a degraded mode. See `docs/DATA_SOURCES.md` for the per-source status.

## Where it stands

`pnpm test` on this checkout: **47 test files passed, 5 skipped; 569 tests passed, 42
skipped.** The skipped suites are the ones guarded by `describe.skipIf(!probe.available)` —
they need a reachable Postgres (`db-items`, `db-migrations`, `db-story-repository`,
`pipeline-daily-run`, `web-queries`) or generated fixtures (`gold-isolation`).

Synthetic acceptance: the `p11-b` experiment lineage has `overallPass: true` and an
empty `failedGates` array for all three fixture days (2026-09-10, -11, -12), across
15 recorded metrics — see `experiments/p11-b/<date>/<run-id>/evaluation.json`.
`docs/PRODUCTION_PLAN.md` still carries this as WIP (0.6), and
`docs/PHASE1_REPORT.md` documents the earlier lineage that failed two gates and why
the policy was corrected; read both before treating the pass as settled.

## Prerequisites

| | |
|---|---|
| Node | ≥ 24 (`package.json` `engines`); v24.21.0 here, mise-managed |
| pnpm | 10.34.5, mise-managed |
| Docker | OrbStack, context `orbstack` |
| Pi CLI | 0.85.1, already installed and authenticated (`pi auth check`) |

This project reuses the existing Pi OAuth logins read-only via
`~/.pi/agent/auth.json` and changes nothing about the global Pi configuration. See
`docs/ENVIRONMENT.md` for every verified version and the model chain.

## First-time setup

```bash
pnpm install

cp .env.example .env
# then edit .env: replace the placeholder password with a locally generated one,
# in BOTH POSTGRES_PASSWORD and DATABASE_URL.

docker compose -p daily-intelligence up -d     # Postgres 17 + pgvector, 127.0.0.1 only
pnpm db:migrate
```

`.env` is gitignored. Never commit a real credential; see `docs/SECURITY.md` for
where credentials are allowed to live.

To add collector credentials, set the logical secret names from
`config/sources.yaml` as environment variables, or add a Keychain mapping in
`src/config/secrets.ts`. `pnpm collect` will report each source's health and name
the missing secrets.

## Running it

```bash
pnpm collect                   # collection pass only: providers -> Postgres
pnpm daily                     # the full day: collect -> curate -> write -> validate -> publish
pnpm db:reset                  # drop and re-migrate (destructive)
```

Both read `.env` via `tsx --env-file-if-exists=.env`.

The web reader:

```bash
pnpm web:dev                   # next dev on 127.0.0.1:3300
pnpm web:build
pnpm web:start                 # next start on 127.0.0.1:3300
pnpm web:seed                  # development seed data
```

A web request never invokes a language model. `tests/web-no-llm.test.ts` walks every
file under `web/` and fails if anything there imports the Pi SDK or the restricted
runtime. See `web/README.md` for the route list.

## Tests and acceptance

```bash
pnpm test                      # vitest, unit + integration
pnpm typecheck                 # tsc --noEmit
```

Integration tests drive the real tools, validators, repository and orchestrator
through a fake agent driver, so resume, cross-provider fallback, rejection handling,
gold-truth isolation and the run lifecycle are all covered without spending a token
on a model. DB-backed suites skip themselves when Postgres is not reachable, so a
clean `pnpm test` with 42 skips means "no database", not "nothing to run" — start the
container and re-run to exercise them.

The synthetic acceptance harness (fixtures + gold truth) is unchanged from Phase 1
and is not superseded by live data:

```bash
pnpm phase1:generate                        # all three dates, fixed seed
pnpm phase1:generate --seed 42              # a different deterministic world
pnpm phase1:curate  --date 2026-09-12       # curator stage alone
pnpm phase1:edit    --date 2026-09-12       # fresh editor from stored materials
pnpm phase1:run     --date 2026-09-10       # curator -> editor -> validator -> eval
pnpm eval:run       --date 2026-09-12       # evaluate an existing run
pnpm stability:run                          # stability sweep tooling
pnpm benchmark:models                       # resolve-only; free
```

**Run the fixture dates in order.** Day N's novelty judgements depend on the ledger
day N−1 wrote; running 09-12 first makes every story look NEW.

Evaluation matches produced stories to gold events **by source-item overlap, never by
title** — Jaccard over item sets with a primary-item rescue path. Title matching
would reward the exact failure mode this project exists to detect. Gate thresholds
are not negotiable: a failing gate gets a fixed policy or implementation, never a
lowered bar (`AGENTS.md`).

`MANUAL_REVIEW.md` carries a deliberately empty human score — "would I read this every
morning, 1–5", target ≥ 4. Nothing in this repository ever writes it.

## Fault injection (test-only — never in a production run)

`src/runtime/fault-injection.ts` synthesizes a real, classifier-real provider failure
at a chosen point in a chosen stage, so the fallback path can be exercised without
waiting for an actual outage. **It must never be enabled for a live run.** An
injected fallback is not evidence of production fallback behaviour.

Single env var, JSON spec:

```bash
DAILY_INTELLIGENCE_FAULT_INJECTION='{"stage":"curator","model":"primary","afterProcessedItems":20,"failureClass":"QUOTA"}'
```

| Field | Meaning |
|---|---|
| `stage` | `curator` or `editor` |
| `model` | `primary` / `secondary` / `tertiary`, or a full `provider/model` key |
| `afterProcessedItems` | Curator: fires once this many items have a recorded decision. Editor: interpreted as tool calls, the nearest honest equivalent of stage progress |
| `failureClass` | Any `FailureClass` from `src/schemas/run.ts` |

Off by default; never keyed off `NODE_ENV` or a config file; an invalid spec throws at
startup rather than silently disabling itself; fires at most once per run; the
synthesized error goes through the real `classifyError`; every attempt it produces
carries a `faultInjected` record in `attempts.json`.

Note: a transient class like `RATE_LIMIT` retries once on the *same* model first, and
since the fault fires only once that retry succeeds and no fallback occurs. Use
`QUOTA`, `BILLING`, `MODEL_UNAVAILABLE` or `AUTH` to force a fallback in one shot.

## Where things live

| Path | What is actually there |
|---|---|
| `runs/<date>/<run-id>/` | Per-run artifacts for the default lineage: `manifest.json`, `run-state.json`, `attempts.json`, `events.jsonl`, `item-decisions.json`, `story-ledger.json`, `materials.json`, `brief.json`/`brief.md`, `validation.json`, `evaluation.json`/`evaluation.md`/`MANUAL_REVIEW.md`, `restricted-runtime.json`, `summary.md`. Currently holds 2026-09-10/-11/-12 |
| `runs/_ledger/<date>/` | The cross-day ledger for that lineage |
| `experiments/<lineage>/` | The same tree, namespaced by `DI_LINEAGE`, so experimental runs never collide with production rows. Currently `p11-a`, `p11-b`, `p11-c`, `p11-d`, `p11-fallback` |
| `fixtures/generated/<date>/` | Agent-visible synthetic manifests |
| `eval/gold/<date>.json` | Gold truth. Read by the evaluator and by nothing else |
| `agent/skills/daily-intelligence/` | `SKILL.md` plus nine reference documents |
| `logs/` | LaunchAgent stdout/stderr, once the agents are installed. Currently empty |
| `backups/` | `pg_dump` output from `scripts/backup-db.sh`, gzipped and timestamped. Currently holds one dump |
| `db/migrations/` | `001_init.sql`, `002_run-status-and-degraded.sql` |
| `config/` | `interests.yaml`, `watchlists.yaml`, `sources.yaml`, `discovery.yaml`, `agent.yaml` |
| `launchd/` | The two plist templates |

## Inspecting a failed run

1. `run-state.json` — `status` says which stage failed, `failureReason` says why.
2. `attempts.json` — one record per model attempt with `failureClass`,
   `fallbackReason` and sanitized `errorMeta`. This distinguishes "the provider was
   out of quota" from "the model produced an invalid payload".
3. `events.jsonl` — every tool call in order. A stalled curator shows as repeated
   calls with no growth in `processedItems`.
4. `item-decisions.json` vs `manifest.json` — a `CURATION_FAILED` run is almost
   always an incomplete scan; diff the id sets.
5. `validation.json` — for `VALIDATION_FAILED`, the exact referential errors.
6. `evaluation.json` — `failedGates` plus each metric's `detail`, which carries raw
   counts rather than just a ratio.

`/admin/runs` in the web reader shows the same thing over the database.

## Documentation

| Document | One line |
|---|---|
| [`AGENTS.md`](AGENTS.md) | The binding project rules; read this first |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Why the system is shaped this way, and where each guarantee is enforced |
| [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md) | Verified versions, model IDs, config surface and environment variables |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model and the code and tests that enforce it |
| [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md) | Per-collector endpoints, credentials, incrementality and current status |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Day-to-day operation of the running system |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Incident procedures |
| [`docs/PRODUCTION_PLAN.md`](docs/PRODUCTION_PLAN.md) | Staged build plan and per-task status |
| [`docs/PHASE1_REPORT.md`](docs/PHASE1_REPORT.md) | The prototype's measured results and known limitations |
| [`web/README.md`](web/README.md) | The reader: routes, the no-LLM rule, and how untrusted content is rendered |
