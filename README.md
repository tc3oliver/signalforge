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
- **Not rich, on a day with no credentials.** Everything runs, but what reaches the
  brief is bounded by which connectors have a key. On the first live run, six of ten
  sources were disabled for want of one and a seventh was rate-limited, so the day's
  material came almost entirely from Hacker News. See `docs/DATA_SOURCES.md`.
- **Not supported.** It is published because the design may be useful to read, not
  because anyone is on call for it. Expect to fix things yourself; see `LICENSE`.

## Where it stands

`pnpm verify`: typecheck, the full suite with **no suite permitted to skip**, and the
web build. The Postgres-backed suites run against the real database; `pnpm test`
loads `.env` so they can, and `pnpm verify` fails outright if they cannot — a green
run that silently skipped the whole data layer is worse than a red one.

- **Synthetic acceptance:** `p11-b` passes every gate on all three fixture days —
  `experiments/p11-b/<date>/<run-id>/evaluation.json`, and `docs/reports/PHASE1_REPORT.md`
  §11 for the before-and-after.
- **Stability:** three independent lineages, core story selection 0.922 against a
  0.85 gate — `docs/reports/STABILITY_REPORT.md`.
- **Model fallback:** validated live, not only in tests. A real primary session
  decided 50 of 79 items, a quota failure was injected at the worker boundary, and a
  fresh session on the second model finished the remaining 29.
- **Live run:** one real end-to-end day, triggered through the installed
  LaunchAgent — `docs/reports/LIVE_RUN_REPORT.md`.
- **Everything, in one table:** `docs/reports/FINAL_ACCEPTANCE_REPORT.md`.

## Prerequisites

| | |
|---|---|
| Node | ≥ 24 (`package.json` `engines`) |
| pnpm | 10.x |
| Docker | any Docker-compatible runtime that can run `compose.yaml` |
| Pi agent | `@earendil-works/pi-coding-agent` 0.85.1, installed and authenticated (`pi auth check`) |

The scheduler is a macOS **LaunchAgent**, so unattended operation as shipped is
macOS-only. Everything else — collection, curation, writing, the web reader — is
plain Node and Postgres and does not care what it runs on; on another platform,
drive `pnpm daily` from whatever scheduler you have.

Authentication is Pi's, not this project's: it reads the existing Pi logins from
`~/.pi/agent/auth.json` read-only and changes nothing about the global Pi
configuration. This project never stores a model credential of its own.
`docs/ENVIRONMENT.md` records the versions this was verified against.

## First-time setup

```bash
pnpm install

cp .env.example .env
# then edit .env: replace the placeholder password with a locally generated one,
# in BOTH POSTGRES_PASSWORD and DATABASE_URL.

docker compose -p daily-intelligence up -d     # Postgres 17 + pgvector, 127.0.0.1 only
pnpm db:migrate
```

### Choosing the models

`config/agent.yaml` holds the model chain: the first entry is tried first and
each later one is a cheaper fallback. The daily CLI reads that file, so changing
providers is a config edit, not a code edit.

```yaml
modelChain:
  - provider: anthropic
    model: claude-sonnet-5
  - provider: openai
    model: gpt-5.6
```

`provider` is whatever the installed Pi agent can authenticate as — run
`pi models` to see what is available to you. The chain committed here routes
through subscription-backed providers because that is what the machine it was
built on has; **if you are setting this up yourself you almost certainly want
direct-API providers instead.** Nothing in the pipeline depends on which
providers these are, only that the first is the most capable one you have.

One caveat worth stating plainly: the curator is asked to scan *every* item
collected that day, which on a busy day is over a thousand. That is a deliberate
product requirement rather than an oversight, and it makes the run's cost
proportional to the day's volume. Price the primary model accordingly.

### Credentials

Collector credentials go in **`~/.config/daily-intelligence/secrets.env`** —
outside this repository, mode `600` in a `700` directory. It is loaded at worker
startup, so both `pnpm collect`/`pnpm daily` and the scheduled LaunchAgents pick
it up with no extra wiring.

```sh
$EDITOR ~/.config/daily-intelligence/secrets.env    # one KEY=value per line
pnpm collect                                        # reports each source's health
```

A name left blank is treated as absent: the loader sets nothing, the Keychain
fallback still applies, and the collector that needs it stays `DISABLED` rather
than failing the run. A missing file is equally fine — the product is expected to
run with no credentials at all.

One entry in that file is not a credential: `MINIFLUX_URL`. A Miniflux instance
lives at a different address on every machine, and the key is useless without it,
so it overrides `rss.baseUrl` in `config/sources.yaml` rather than being checked
in. It is the only config key with an environment override.

Precedence is **explicit environment variable → `secrets.env` → Keychain**. An
existing Keychain mapping (`KEYCHAIN_MAPPINGS` in `src/config/secrets.ts`) keeps
working; a blank placeholder cannot shadow it. Set
`DAILY_INTELLIGENCE_SECRETS_FILE` to keep the file somewhere else.

Nothing about this reaches a log: startup records how many names were set and
which are still blank, never a value. `.env` (database settings only) is
gitignored; never commit a real credential. See `docs/SECURITY.md`.

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
| [`web/README.md`](web/README.md) | The reader: routes, the no-LLM rule, and how untrusted content is rendered |

Everything above is kept current. Dated evidence — acceptance, live runs, the
stability measurement, the quality review and the P0 fixes — lives under
[`docs/reports/`](docs/README.md#reports--point-in-time-not-maintained) and is
deliberately never updated after the fact.

## License

MIT — see [`LICENSE`](LICENSE).

The code is mine to license. What the pipeline *collects* is not: items come from
Hacker News, GitHub, arXiv, RSS feeds, FRED, CoinGecko and others, each under its
own terms, and a published brief quotes and links them. Nothing collected is
redistributed here — `runs/`, `briefs/` and `logs/` are gitignored, and the test
data committed under `experiments/` and `fixtures/` is synthetic. If you run this,
the collected content is yours to be responsible for.
