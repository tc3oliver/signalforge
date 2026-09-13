# Development

How to run, test and inspect SignalForge while working on it. The binding
rules are in [`AGENTS.md`](../AGENTS.md); this is the practical companion.

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
pnpm web:seed                  # development seed data (same as `pnpm demo`)
```

Both bind loopback by default. `WEB_HOST` and `WEB_PORT` override that, so
`WEB_HOST=0.0.0.0 pnpm web:start` serves the reader to your LAN. Every route is
read-only and there is no authentication in front of any of them, so what you
bind to decides who can read your briefs. Putting it on the public Internet is a
deliberate choice to publish them; put a reverse proxy and TLS in front if you
make it.

The `/admin` section — run status, model fallbacks, collector health, per-item
trace — is off unless `SIGNALFORGE_ADMIN=1` is set. Without it those routes 404
and nothing links to them, so a reader you expose to other people shows briefs
and nothing about how the deployment is configured or what it failed at.

A web request never invokes a language model. `tests/web-no-llm.test.ts` walks
every file under `web/` and fails if anything there imports the Pi SDK or the
restricted runtime. See [`../web/README.md`](../web/README.md) for the route
list and how untrusted content is rendered.

## Tests and acceptance

```bash
pnpm test                      # fast: unit + integration, skips what needs Postgres
pnpm test:integration          # same suite, but skipping is a failure
pnpm verify                    # typecheck -> fixtures -> test:integration -> build
```

**`pnpm verify` is the command that decides whether a change is good.** `pnpm test`
is the fast one you run while working, and it is allowed to skip the database-backed
suites so it stays usable on a machine with no Postgres up. That convenience was a
trap: a run with no database reported `622 passed | 42 skipped`, exit 0, green — with
the entire DB layer, the pipeline state machine, and the gold-isolation *security*
test silently absent, and nothing in the output recording which of the two runs had
happened. "The tests pass" meant less than it looked like.

So there are two commands with two contracts. Under `pnpm verify` (and
`pnpm test:integration`, which it calls) the environment variable
`DI_REQUIRE_INTEGRATION=1` is set, and anything that would skip for want of
infrastructure throws instead: no Postgres is a hard failure naming the container to
start, and missing generated fixtures is a hard failure naming `pnpm phase1:generate`.
Never report a verification result from `pnpm test` alone.

Integration tests drive the real tools, validators, repository and orchestrator
through a fake agent driver, so resume, cross-provider fallback, rejection handling,
gold-truth isolation and the run lifecycle are all covered without spending a token
on a model.

The web reader's components are rendered to static HTML under the same test
runner (`tests/web-dashboard-render.test.ts`, `tests/web-full-brief-render.test.ts`),
which is why `vitest.config.ts` aliases React to `web/node_modules`: the
dashboard's ordering, empty states and "nothing long-form on Today" rules are
behavioural assertions, not snapshots.

### Synthetic acceptance harness

The fixture + gold-truth harness is unchanged from Phase 1 and is not superseded
by live data:

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
| `runs/<date>/<run-id>/` | Per-run artifacts for the default lineage: `manifest.json`, `run-state.json`, `attempts.json`, `events.jsonl`, `item-decisions.json`, `story-ledger.json`, `materials.json`, `brief.json`/`brief.md`, `validation.json`, `evaluation.json`/`evaluation.md`/`MANUAL_REVIEW.md`, `restricted-runtime.json`, `summary.md`. Gitignored |
| `runs/_ledger/<date>/` | The cross-day ledger for that lineage |
| `experiments/<lineage>/` | The same tree, namespaced by `DI_LINEAGE`, so experimental runs never collide with production rows |
| `fixtures/generated/<date>/` | Agent-visible synthetic manifests |
| `eval/gold/<date>.json` | Gold truth. Read by the evaluator and by nothing else |
| `agent/skills/daily-intelligence/` | `SKILL.md` plus its reference documents |
| `logs/` | LaunchAgent stdout/stderr, once the agents are installed |
| `backups/` | `pg_dump` output from `scripts/backup-db.sh`, gzipped and timestamped |
| `db/migrations/` | Numbered SQL migrations, applied in order by `pnpm db:migrate` |
| `config/` | Shipped example config: `interests.yaml`, `watchlists.yaml`, `sources.yaml`, `discovery.yaml`, `agent.yaml`. The `*.local.yaml` twin, gitignored, is what actually runs |
| `launchd/` | The two plist templates |
| `docs/assets/` | Screenshots used by the README, taken from the synthetic `web-dev` lineage |

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

`/admin/runs` in the web reader shows the same thing over the database, when
`SIGNALFORGE_ADMIN=1` is set.

## Packages

The repo root and `web/` are two separately installed packages, each with its
own lockfile; the root `postinstall` runs the web install so `pnpm install`
once is enough. They are deliberately **not** a pnpm workspace: the reader
imports `../src` through Next's `externalDir`, the root test runner aliases
React into `web/node_modules`, and the production install on the machine that
runs the daily job is this tree. Converting would rewrite both lockfiles and
require re-installing that production tree, which is not worth doing during an
observation window. Revisit when there is a reason beyond tidiness.
