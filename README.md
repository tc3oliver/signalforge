# SignalForge

> SignalForge reads the noise so you can read the signal.

SignalForge is a self-hosted AI intelligence pipeline that collects information
from multiple sources, groups duplicate reports into real-world events, tracks
how stories evolve over time, identifies emerging signals, and produces
source-grounded daily intelligence briefs.

Not another RSS summarizer. SignalForge reasons over **events and changes**,
not articles.

```text
Sources
  │
  ▼
Collectors
  │
  ▼
Normalized Items
  │
  ▼
Pi Curator  ──┬─ Deduplicate
              ├─ Cluster Events
              ├─ Compare History
              ├─ Judge Novelty
              └─ Select Material
  │
  ▼
Story Ledger
  │
  ▼
Fresh Pi Editor
  │
  ▼
Daily Brief
  │
  ▼
Validator
  │
  ▼
Web
```

## Why it exists

A feed reader gives you today's articles. That is the wrong unit.

Five outlets writing about one release is one event, not five things to read.
An article published today is frequently not new information — it is commentary
on something you were told last week, or a rumour that has now been confirmed,
or a number that moved in a direction you were already tracking. Sorting that
out is the work, and it is the work a summarizer does not do: summarizing five
articles gives you five summaries.

SignalForge is **event-centric, not article-centric**:

```text
5 articles about the same release
  → 1 Story
  → multiple supporting sources
```

and it records what each day actually changed about that story:

| | |
|---|---|
| `NEW` | First time this event has been seen |
| `UPDATE` | Genuinely new detail on a known story |
| `ESCALATION` | The situation got more serious |
| `RESOLUTION` | It concluded |
| `REVERSAL` | It went the other way |
| `CONFIRMATION` | A rumour or single-source report is now corroborated |
| `RUMOR` | Reported, but not yet from a source that settles it |
| `NO_MATERIAL_CHANGE` | Coverage happened; information did not |

A story marked `NO_MATERIAL_CHANGE` is recorded in the ledger and kept out of
your brief. That is the difference between tracking events and summarizing
articles.

## What it is

- **Multi-source collection** — RSS (via Miniflux), GitHub, Hacker News, arXiv,
  Semantic Scholar, Reddit, YouTube, SEC EDGAR, FRED, CoinGecko, plus scheduled
  web research.
- **Event-centric deduplication** — items are clustered into stories; duplicate
  coverage becomes supporting sources, not extra entries.
- **Cross-day story ledger** — every story persists, so today is compared
  against what was already known rather than judged in isolation.
- **Novelty and change tracking** — the eight change types above.
- **Emerging signal detection** — weak repeated patterns tracked across days
  before any single day would justify a story.
- **Personal interest configuration** — your topics and weights drive both what
  the curator looks for and how it scores what it finds.
- **Source-grounded writing** — every claim in a brief resolves to a collected
  item; fabricated source ids fail validation.
- **Deterministic validation** — a brief is checked by code, not by asking a
  model whether it did a good job.
- **Model-provider fallback** — a three-deep chain; a quota or outage on the
  primary continues on the next.
- **Production observability** — per-collector health, per-item decision
  traces, run state, and a reason for every rejection.
- **Web UI** — a local reader for briefs, story history, signals and search.
- **Self-hosted scheduling** — unattended daily runs, macOS LaunchAgent
  included.

## What it is not

- **Not a generic RSS reader or news aggregator.** It deliberately throws most
  of the day away. On a typical day well over 95% of collected items are
  rejected with a recorded reason.
- **Not a trading bot.** It tracks market series because they are context; it
  makes no recommendation and takes no action.
- **Not an autonomous browser agent.** The agent sessions have no shell, no
  filesystem beyond one narrowly-rooted policy reader, no arbitrary HTTP and no
  credentials.
- **Not multi-tenant.** One reader, one database. Multi-user is not a roadmap
  item.
- **Not publicly reachable by design.** Postgres and the web app both bind
  `127.0.0.1`. Exposing it to the Internet is unsupported.
- **Not supported.** Published because the design may be useful to read and
  adapt, not because anyone is on call. See `CONTRIBUTING.md`.

## Quick start

```bash
git clone https://github.com/tc3oliver/signalforge.git && cd signalforge
pnpm install                             # also installs web/, via postinstall

cp .env.example .env
# Edit .env: replace the placeholder password with a locally generated one, in
# BOTH POSTGRES_PASSWORD and DATABASE_URL.

docker compose up -d                     # Postgres 17 + pgvector, 127.0.0.1 only
pnpm db:migrate

pnpm setup:check                         # tells you what is ready and what is missing
```

`pnpm setup:check` is read-only. It starts nothing, writes nothing, and prints
no credential value — only which names are configured.

> **A note on the name.** The project is SignalForge; several internal
> identifiers still say `daily-intelligence` — the Docker project and volume,
> the database name, the secrets-file directory, the scheduler labels. Those are
> not cosmetic strings: renaming the Compose project orphans the data volume,
> and renaming the secrets directory breaks an existing install. They are
> deliberately left alone. Nothing you read in the UI or the docs depends on
> them.

### See it work before configuring anything

```bash
pnpm demo                                # synthetic three-day history, "web-dev" lineage
DI_LINEAGE=web-dev pnpm run web:start    # then open http://127.0.0.1:3300
```

`pnpm demo` needs no model, no API key and no network. It writes into its own
lineage and can never touch `default`. `examples/` has the same output as static
files if you would rather just read it.

### Then make it yours

```bash
cp config/interests.yaml   config/interests.local.yaml
cp config/watchlists.yaml  config/watchlists.local.yaml
$EDITOR config/interests.local.yaml      # your topics, your weights
```

Every `config/*.yaml` in the repository is a **shipped example**. The file that
actually runs is `*.local.yaml`, which is gitignored and wins outright when
present. The shipped interests file is a demonstration of the shape, not a
recommendation — until you replace it, the brief reflects an example rather
than you.

Then configure a model chain (below), add any collector credentials you want,
and run:

```bash
pnpm collect                             # collection only; reports each source's health
pnpm daily                               # the full day, ending in a published brief
```

## Data sources

| Source | Credential | Without it |
|---|---|---|
| Hacker News | none | full function |
| arXiv | none | full function |
| CoinGecko | none | full function (public tier) |
| SEC EDGAR | none, but requires a contact User-Agent | disabled until you set one |
| GitHub | optional `GITHUB_TOKEN` | works unauthenticated at a much lower rate limit; some repos 403 |
| YouTube | optional `YOUTUBE_API_KEY` | RSS per channel still works; `@handle` resolution and discovery are skipped (`DEGRADED`) |
| Semantic Scholar | optional `SEMANTIC_SCHOLAR_API_KEY` | works at a lower rate limit |
| RSS / Miniflux | **required** `MINIFLUX_URL` + `MINIFLUX_API_KEY` | `DISABLED` |
| Reddit | **required** `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` | `DISABLED` |
| FRED | **required** `FRED_API_KEY` | `DISABLED` |
| Web research | **required** `TAVILY_API_KEY` (or `EXA_API_KEY`) | the `search_web` tool is not offered to the curator at all |

A missing credential is never an error. The collector reports `DISABLED`, the
run continues, and the brief is correspondingly thinner. Running with no
credentials at all is a supported configuration — it is just mostly Hacker News
and arXiv.

## Model providers

The model chain lives in `config/agent.yaml`, it is read at run time, and the
first entry is the primary with each later one a fallback:

```yaml
modelChain:
  - provider: anthropic
    model: claude-sonnet-5
  - provider: openai
    model: gpt-5.6
```

`provider` is whatever the installed Pi agent can authenticate as — run
`pi models` to see what is available to you. Authentication is Pi's, not this
project's: SignalForge reads existing Pi logins read-only and never stores a
model credential of its own.

**The committed chain is an example, and probably the wrong one for you.** It
names subscription-backed providers because that is what the machine this was
built on had. Nothing in the pipeline depends on which providers these are,
only that there is at least one and that the first is the most capable. Any
provider Pi supports — direct API key, subscription, or an OpenAI-compatible
endpoint you host yourself — works the same way here; whether a given one is
reachable is a question for `pi auth check`, not for this project.

**Budget for volume, not for requests.** The curator is required to scan *every*
item collected that day, which on a busy day is well over a thousand. That is a
deliberate product requirement — a story that is never looked at cannot be
judged — and it means cost scales with how much you collect, not with how much
reaches your brief. Price the primary model accordingly, and treat a large
watchlist as a recurring cost.

## Security model

Detail and the tests that enforce each boundary are in
[`docs/SECURITY.md`](docs/SECURITY.md); reporting is
[`.github/SECURITY.md`](.github/SECURITY.md).

- **External content is untrusted.** Everything collected is treated as hostile
  input and marked as such before an agent sees it. Prompt injection through a
  collected item is an in-scope vulnerability.
- **The agent runtime is restricted.** No shell, no filesystem beyond one
  narrowly-rooted policy reader, no arbitrary HTTP, no credentials. Asserted per
  run, not just configured.
- **Secrets live outside the repository** — `~/.config/daily-intelligence/secrets.env`
  or the OS keychain — and are resolved server-side. Values are never logged,
  never placed in a command argument, and never included in an error message.
- **The agent never holds a credential.** Collectors and the research layer run
  server-side and hand the agent content, never keys.
- **Third-party providers are a trust boundary.** Item text goes to whichever
  provider you configure, under their terms.

## Limitations

Stated plainly, because they determine whether this is worth your time.

- **Brief quality is bounded by your model and your source coverage.** The
  pipeline is deterministic where it can be; the judgement is not. A weaker
  primary model produces a visibly weaker brief.
- **The curator is expensive by design.** Scanning every item is the product
  requirement that makes historical comparison possible, and it is also the
  single largest cost.
- **Personalization is keyword and weight driven.** It does not learn from what
  you actually read. There is no feedback loop yet; interest weights are
  something you tune by hand.
- **Historical awareness is only as old as your ledger.** A fresh install has no
  history, so everything is `NEW` for the first few days and change tracking
  only becomes useful once days accumulate.
- **Several connectors are optional and off by default**, so a default install
  sees much less than a configured one.
- **Unattended scheduling as shipped is macOS-only.** See Prerequisites.
- **Emerging signal detection is the least mature part** of the pipeline and the
  part most likely to change.

## Where it stands

`pnpm verify` is the command that decides whether a change is good: typecheck,
the full suite with **no suite permitted to skip**, and the web build.

- **Synthetic acceptance:** passes every gate on all three fixture days —
  `docs/reports/PHASE1_REPORT.md` §11.
- **Stability:** three independent lineages, core story selection 0.922 against
  a 0.85 gate — `docs/reports/STABILITY_REPORT.md`.
- **Model fallback:** validated live. A real primary session decided 50 of 79
  items, a quota failure was injected at the worker boundary, and a fresh
  session on the second model finished the remaining 29.
- **Live run:** real end-to-end days through the installed scheduler —
  `docs/reports/LIVE_RUN_REPORT.md`.
- **Honest self-assessment:** `docs/reports/QUALITY_REVIEW.md` is a critical
  review of this project by its own author, scoring intelligence quality well
  below engineering quality and saying why. Read it before deciding this is
  finished software.

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

## Credentials

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

Both bind loopback by default. `WEB_HOST` and `WEB_PORT` override that, so
`WEB_HOST=0.0.0.0 pnpm web:start` serves the reader to your LAN. There is no
authentication in front of it and every route is read-only, so bind it to a
network you trust and never expose it to the Internet.

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

## Repository topics

Suggested, for anyone cataloguing this: `ai`, `agents`, `llm`, `intelligence`,
`news-aggregator`, `rss`, `self-hosted`, `daily-brief`, `knowledge-management`,
`typescript`, `postgresql`.
