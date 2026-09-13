# Daily Intelligence — Phase 1 Intelligence Prototype

## What Phase 1 is

Phase 1 is not a product. It is an experiment with one question:

> Given a large, noisy, redundant day of feed items that continues stories from
> previous days, can a Pi agent scan **all** of it, deduplicate it, cluster it into
> real-world events, compare against history, judge what is actually new and
> important, and hand a second agent enough to write a brief worth reading every
> morning?

Everything here exists to answer that and nothing else. There is no database, no web
UI, no scheduler, no real collector and no internet access. The input is synthetic
and deterministic; the evaluation is deterministic; the only non-deterministic part
is the model, which is the thing under test.

What Phase 1 deliberately does **not** build: PostgreSQL, pgvector, Next.js, a
LaunchAgent, MCP, live web research, and any of the production collectors.

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The short version:

```
synthetic manifest → Pi Curator (restricted) → materials.json
                   → Pi Editor (separate fresh session) → brief.json → brief.md
                   → validator → evaluator
```

The Curator and Editor never share a session. Nothing durable lives inside a session.
Agent output is only accepted through a validating custom tool.

## Setup

```bash
pnpm install
```

Requires the Pi CLI already installed and authenticated (`pi auth check`). This
project reuses those OAuth logins read-only and changes nothing about the global Pi
configuration. See [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md) for the verified
versions and model IDs.

## How to generate fixtures

```bash
pnpm phase1:generate            # all three dates, fixed seed
pnpm phase1:generate --seed 42  # a different deterministic world
```

Writes `fixtures/generated/<date>/manifest.json` (agent-visible) and
`eval/gold/<date>.json` (never visible to the agent). Same seed, byte-identical
output.

## How to run the Curator

```bash
pnpm phase1:curate --date 2026-09-12
```

Runs the curator stage alone and stops at `materials.json`. Useful when iterating on
curation policy without paying for an editor run.

## How to run the Editor

```bash
pnpm phase1:edit --date 2026-09-12               # latest run for that date
pnpm phase1:edit --date 2026-09-12 --run-id <id> # a specific run
```

Builds a fresh editor session from an existing run's `materials.json`. Re-runnable:
each invocation starts from the materials, never from a previous editor conversation.

## How to run the full phase

```bash
pnpm phase1:run --date 2026-09-10
pnpm phase1:run --date 2026-09-11
pnpm phase1:run --date 2026-09-12
```

Curator → Editor → Validator → Evaluation, writing everything under
`runs/<date>/<run-id>/`. Exits non-zero when an acceptance gate fails.

**Run the dates in order.** Day N's novelty judgements depend on the story ledger
that day N−1 wrote; running 09-12 first means every story looks NEW.

## How evaluation works

```bash
pnpm eval:run --date 2026-09-12
```

The evaluator loads the run's artifacts and `eval/gold/<date>.json`, then matches
produced stories to gold events **by source-item overlap, never by title** — Jaccard
over item sets, with a rescue path when a story contains the event's primary item.
Title matching would reward the failure mode this whole project is trying to detect.

Gates (all must pass):

| Metric | Gate |
|---|---|
| Scan Coverage | 100% |
| Important Story Recall | ≥ 90% |
| Cluster F1 (pairwise) | ≥ 90% |
| Change Type Accuracy | ≥ 85% |
| Selected Story Precision | ≥ 85% |
| Noise Rejection | ≥ 95% |
| Fabricated source IDs | 0 |
| Invalid fact refs | 0 |
| Final duplicate stories | 0 |
| Final story count | 8–15 |
| Must Know count | 3–5 |
| Structured output valid after retry | 100% |

It also writes `MANUAL_REVIEW.md` with a deliberately empty human score block —
"would I read this every morning, 1–5", target ≥ 4. That field is filled in by a
person. Nothing in this repository ever writes it.

## How model fallback works

Fixed chain, implemented in this project rather than by any Pi extension (Pi has no
cross-provider fallback):

1. `github-copilot/gemini-3.8-flash`
2. `openai-codex/gpt-5.6-sol`
3. `opencode-go/deepseek-v4.1-flash`

Errors are classified by `status`/`code`/`name`/`cause` before message text, then:
transient (network, timeout, rate limit, 5xx) retries once then falls back; quota,
billing and model-unavailable fall back immediately; auth marks the provider degraded
for the rest of the run; invalid output gets one corrective retry; a tool loop gets
one resume; context overflow opens a fresh session on the **same** model; a programmer
error fails immediately.

A fallback never migrates a dying conversation. The next model reads the durable
state and continues from the first item that has no decision yet.

```bash
pnpm benchmark:models                                              # resolve-only, free
pnpm benchmark:models --models gemini,gpt,deepseek --dates 2026-09-12 --repeat 1
```

The no-argument form only proves each model resolves. A real sweep is opt-in because
each cell is a full curator+editor run over ~85 items and costs real subscription
quota.

## Fault injection (test-only — never use in a production run)

`src/runtime/fault-injection.ts` lets a test synthesize a real, classifier-real
provider failure at a chosen point in a chosen stage, to exercise the fallback path
above without waiting for an actual quota exhaustion or outage. **It must never be
enabled for a live run.** An injected fallback is not evidence of production
fallback behaviour — it is a manufactured one, and the run artifacts record it as
such (see below) so a report can never conflate the two.

It is controlled by a single environment variable, `DAILY_INTELLIGENCE_FAULT_INJECTION`,
carrying a JSON spec:

```bash
DAILY_INTELLIGENCE_FAULT_INJECTION='{"stage":"curator","model":"primary","afterProcessedItems":20,"failureClass":"RATE_LIMIT"}'
```

| Field | Meaning |
|---|---|
| `stage` | `curator` or `editor` |
| `model` | `primary` / `secondary` / `tertiary` (chain position), or a full `provider/model` key |
| `afterProcessedItems` | Curator: fires once at least this many items have been recorded. Editor: the editor stage has no "items processed" concept of its own, so this is interpreted as "after this many tool calls" — the nearest honest equivalent of stage progress. |
| `failureClass` | Any value from the 14 `FailureClass`es in `src/schemas/run.ts` |

Behaviour:

- **Off by default.** Absent or empty env var — zero behavioural change, zero
  overhead on the normal path.
- **Explicit opt-in only.** Never triggered by `NODE_ENV`, test mode, or any config
  file — env var only, and the parser rejects invalid JSON or an unknown field at
  startup with a clear error rather than silently running as if disabled.
- **Fires at most once per run**, so the fallback model can actually complete the
  work.
- The synthesized error is a real error object (`status`, `code`, or `name`, as
  appropriate) run through the actual `classifyError` in `error-classifier.ts` —
  there is no special-case bypass in the classifier for it.
- Every attempt record it produces carries a `faultInjected` field
  (`{ stage, model, failureClass, afterProcessedItems, firedAtProcessedItems }`) in
  `attempts.json`, distinguishing it permanently from a spontaneous failure.

Note: with a transient class like `RATE_LIMIT` or `NETWORK`, `decideAction` retries
once on the *same* model before falling back (see "How model fallback works" above);
since the fault fires only once, that retry will succeed and no fallback will occur.
Use a class that falls back immediately on first failure — `QUOTA`, `BILLING`,
`MODEL_UNAVAILABLE`, or `AUTH` — to force a fallback in one shot.

## Where run artifacts live

```
runs/<date>/<run-id>/
    manifest.json          exactly what the agent saw
    run-state.json         lifecycle status and failure reason
    attempts.json          every model attempt with failure class
    events.jsonl           append-only trace of tool calls and transitions
    item-decisions.json    the scan-coverage evidence
    story-ledger.json      the clustering
    materials.json         curator → editor handoff
    brief.json / brief.md  the output
    validation.json        post-submit check
    evaluation.json / evaluation.md / MANUAL_REVIEW.md
    restricted-runtime.json  tool names actually active per stage
    summary.md

runs/_ledger/<date>/       the cross-day story ledger (shared by all runs)
```

## How to inspect a failed run

1. `runs/<date>/<run-id>/run-state.json` — `status` says which stage failed and
   `failureReason` says why.
2. `attempts.json` — one record per model attempt with `failureClass`,
   `fallbackReason` and sanitized `errorMeta`. This distinguishes "the provider was
   out of quota" from "the model produced an invalid payload".
3. `events.jsonl` — every tool call in order. A curator that stalled shows as
   repeated calls with no growth in `processedItems`.
4. `item-decisions.json` vs `manifest.json` — a `CURATION_FAILED` run is almost
   always an incomplete scan; diff the id sets to see what it never reached.
5. `validation.json` — for `VALIDATION_FAILED`, the exact referential errors.
6. `evaluation.json` — `failedGates` plus each metric's `detail`, which carries the
   raw counts rather than just a ratio.

## Tests

```bash
pnpm test        # unit + integration
pnpm typecheck
```

Integration tests drive the real tools, validators and repository through a fake
agent runner, so the whole orchestration — resume, fallback, rejection handling, run
lifecycle — is covered without spending a token on a model.
