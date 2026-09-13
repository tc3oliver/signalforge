# P0 fix report

Scope: production correctness, reliability and data integrity only. No intelligence
policy, personalization, feedback loop or web UX was touched, and no skill, prompt,
threshold, gold file or interest profile was changed.

Date: 2026-09-13. Follows `docs/QUALITY_REVIEW.md`, which is where the evidence for
each of these came from.

---

## Summary

| # | Defect | Root cause | Status |
|---|---|---|---|
| 1 | A transient network error hard-failed the run, bypassing the three-model fallback chain | `TypeError` classified structurally before the cause chain was consulted | Fixed |
| 2 | `pnpm db:reset` could drop the schema by typo | Connectivity was checked; intent was not | Fixed |
| 3 | Every CoinGecko and FRED fact was silently discarded, every run | Facts were membership-tested against items they never claimed to come from | Fixed |
| 3b | CoinGecko grew new rows forever | The fetch timestamp was part of the identity | Fixed |
| 4 | A run where every collector succeeded with nothing counted as success | Emptiness was only a problem if something had also FAILED | Fixed |
| 5 | A broken collector rendered green forever | `consecutive_failures` reset on `DEGRADED` as well as on success | Fixed |
| 6 | The suite reported green with the whole DB layer and the security test skipped | Skipping was the only behaviour; there was no strict mode | Fixed |
| 7 | 920 GitHub items produced 0 stories | The raw `/events` firehose and tag-history backfill were collected wholesale | Fixed |

**Verification status: complete.** `pnpm verify` passes end to end — typecheck,
fixtures, the full suite with **no suite permitted to skip**, and the web build — and a
live collection confirmed every behavioural prediction on real data. Details in
"Verification" below. The OrbStack outage that blocked this for an hour turned out to
have a root cause worth recording; see "The OrbStack hang was not OrbStack".

---

## 1. Transient network failures bypassed the fallback chain

**Root cause.** `src/runtime/error-classifier.ts` mapped `TypeError`,
`ReferenceError`, `SyntaxError` and `RangeError` to `PROGRAMMER_ERROR`, and
`model-router.ts` maps `PROGRAMMER_ERROR` to `FAIL` — no retry, no fallback. undici
(Node's `fetch`) reports *ordinary transport failures* as `TypeError: fetch failed`
and hangs the real reason off `cause`. Because structural classification ran over the
whole chain before the message heuristics, the outer `TypeError` always won, so a
socket reset killed the day without the three-model chain ever being consulted.

A second ordering bug sat beside it: `/abort/i` mapped to `USER_ABORT` (also `FAIL`)
and was tested *before* the NETWORK rule, so any provider error whose text merely
contained "request aborted" terminated the run.

**Change.** A built-in error name now declines to classify when it carries a `cause`
or matches undici's own `fetch failed` wording, letting the next link in the cause
chain answer instead. A genuine programmer `TypeError` has neither, so it still fails
fast. `USER_ABORT` now requires an explicit statement that a user or caller cancelled;
an abort whose message says it timed out classifies as `TIMEOUT`. Added
`UND_ERR_SOCKET`, `ECONNABORTED` (NETWORK) and `UND_ERR_CONNECT_TIMEOUT` (TIMEOUT) to
the code table.

**Regression tests** (`tests/error-classifier.test.ts`, `tests/model-router.test.ts`),
using real error shapes: `TypeError: fetch failed` with `cause` set to each of
`ECONNRESET`, `ENOTFOUND`, `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`,
`UND_ERR_SOCKET` is retryable, not a programmer error; a message containing "request
aborted" is not `USER_ABORT`; a genuine `TypeError: undefined is not a function` with
no cause still fails fast; and a router-level test proving a transport error retries
on the primary model and then moves to the second and third models in the chain.

**Before → after.** A single socket reset ended the run. It now retries on the primary
and, if the primary stays unreachable, falls through the chain as designed.

---

## 2. `pnpm db:reset` is no longer reachable by typo

**Root cause.** `resetSchema()` runs `drop schema public cascade` and `main()`
triggered it on a bare `--reset` argv flag, one character from `pnpm db:migrate`.
`assertReachable()` checks connectivity, which is not intent.

**Change.** The decision is now a pure exported function, `decideReset({ argv, isTTY,
resolvedDbName, host })`, and `main()` only executes what it returns. Default is fail
closed. A non-loopback host is refused outright — the same philosophy as
`scripts/lib-db-env.sh`, which exists because this machine runs several other Docker
stacks in one engine. Interactively, the operator must type the target database name.
Non-interactively (CI, scripts) `--yes-drop-database=<name>` is required and must match
the database actually resolved from the connection.

**Regression tests** (`tests/db-reset-guard.test.ts`): the whole refusal matrix — no
flag, wrong name, non-loopback host, unresolvable database name, TTY vs non-TTY, and
the one path that proceeds.

---

## 3. The numeric layer was silently empty

**Root cause.** `src/pipeline/collection.ts` kept only facts whose `sourceItemId`
appeared among the items collected in the same run. The intent was right — a dangling
citation must not reach the agent. But `sourceExternalId` is set by exactly one
collector (`sec.ts`); FRED returns `items: []` by design and CoinGecko emits facts with
no anchoring item, so **every CoinGecko and FRED fact failed a membership test it was
never meant to take, on every run, with no warning.** `structured_facts` held 3 rows,
all seed data, and every material and brief story carried `fact_refs = {}`. FRED was
enabled yesterday with a working credential and contributed nothing for this reason,
not because the world was quiet.

**Change.** Only a fact that *names* a source item is membership-tested; one that names
none is stored, since `toStructuredFact` already derives a self-reference for it. A
named anchor that does not resolve is still dropped — but now with a warning on the
run instead of in silence.

**3b — CoinGecko identity.** Every fact and the trending item carried the fetch
timestamp in the external id (`coingecko-trending-${fetchedAt}`), so the unique key it
was meant to collapse against never matched: five runs a day produced five new rows per
asset, forever, and no row was "today's price". Identity is now the reading's UTC day;
`asOf` still carries the precise time, so freshness is not lost. FRED was already
correct (`fred-${series}-${obs.date}`) and now has a test so it stays that way.

**Regression tests.** `tests/pipeline-collection.test.ts`: an unanchored fact is
stored; an anchored fact whose item did arrive is stored; an anchored fact whose item
did not arrive is dropped *and named in the warnings*.
`tests/collector-coingecko.test.ts`: two runs in the same UTC day produce identical
external ids; the next day differs; no identity contains a fetch timestamp.
`tests/collector-fred.test.ts`: a fact is keyed by its observation date across runs.

**Before → after.** 0 facts persisted per run → every CoinGecko and FRED reading
persisted, idempotently, one row per reading per day.

> **Known follow-up, not fixed here (out of P0 scope):** the manifest selects facts by
> `as_of` inside the UTC day window. FRED's `as_of` is the *observation* date, which
> for a monthly series is often weeks old, so those facts will persist correctly and
> still not appear in a given day's manifest. That is a separate design question about
> what "today's facts" should mean, and changing it would be an intelligence-policy
> change.

---

## 4. Collection success semantics

**Root cause.** `if (summary.empty && summary.degraded)` — `empty` means every
collector fetched nothing, `degraded` means at least one FAILED. Requiring a *failure*
in order to notice *emptiness* inverts the logic: the ways a pipeline goes quietly
blind (an expired token answering `200 []`, every request answered `304`, a watermark
stuck ahead of now) all produce collectors that succeed and return nothing, and those
were waved straight through into an empty manifest.

Separately, `store.registerCollector(...)` sat outside every `try` in the per-collector
task, and `pool()` does not catch — so one transient database blip aborted all ten
collectors, left the in-flight ones half-persisted, and produced **no row at all** for
any of them. It was also the first await, so the source simply was not in the run.

**Change.**
- The whole registration step is now guarded: a failure becomes a `FAILED` outcome for
  that collector with its error, and the other collectors still run. No enabled
  collector can vanish from a run without a record.
- `suspiciousReason` is set when every active collector returned zero, or when nothing
  was enabled, and `degraded` follows it. `daily-run.ts` now transitions to
  `COLLECTION_FAILED` on `suspiciousReason` rather than on `empty && degraded`.
- Source-aware, so a quiet source is not a false alarm: `MAY_BE_QUIET` covers `fred`
  (most series do not print on most days), `semantic-scholar` (enrichment-only, nothing
  to do without arXiv ids) and `sec` (filings only on filing days). A healthy zero from
  any *other* source is recorded in `silentCollectors` and surfaced in the run's
  degraded reason — deliberately not a run failure, because an incremental collector
  can legitimately be quiet in a narrow window. The signal that actually means
  something is the same collector doing it run after run, which is item 5.

**Regression tests** (`tests/pipeline-collection.test.ts`): an all-healthy, all-zero run
is suspicious and degraded; a quiet FRED / Semantic Scholar does not raise anything; a
healthy-but-zero GitHub is named in `silentCollectors` without failing the run; a
registration failure yields a FAILED outcome for that collector while the others still
collect and persist.

---

## 5. Collector health stopped erasing failure history

**Root cause.** `consecutive_failures = case when $3 = 'FAILED' then
consecutive_failures + 1 else 0 end` — `OK` *and* `DEGRADED` both reset the counter.
Combined with a collector that reports `OK` while every watched repo failed, a broken
collector reset its own failure count, refreshed `last_run_at`, and rendered green on
`/admin/sources` indefinitely. A permanently degraded collector never escalated either.

**Change.** Migration `003_collector-health-history.sql` (additive, `if not exists`,
no existing data touched) adds `last_success_at`, `last_failure_at` and `last_error`
alongside the existing `consecutive_failures` and `last_health`. The transition is a
pure exported function, `nextHealthState(previous, outcome)`, so the escalation matrix
is testable without Postgres; the SQL applies what it returns. `consecutive_failures`
resets on a genuine success and on nothing else — `DEGRADED` no longer resets it.
`DISABLED` is neither success nor failure: it stamps `last_run_at` and leaves the
history standing, so the counter is still there when the source is switched back on.

Deliberately, item count is **not** part of success: FRED on a day with no new
observations has done its job, and making quiet collectors noisy would train the
operator to ignore the health column.

**Regression tests** (`tests/collector-health-state.test.ts`, plus DB-backed coverage in
`tests/db-collector-health.test.ts`): FAILED increments, DEGRADED does not reset, OK
resets, a successful zero-item run does not increment, `last_success_at` and
`last_failure_at` move independently, and recovery after N failures.

---

## 6. The test suite can no longer report a false green

**Root cause.** `describe.skipIf(!probe.available)` silently removed five DB-backed
files, and `tests/integration/gold-isolation.test.ts` — the suite asserting gold truth
is unreachable from inside the agent sandbox — skipped on missing fixtures with no
announcement at all. Measured:

```
$ pnpm test                    → Test Files 55 passed | Tests 664 passed
$ DATABASE_URL= pnpm test      → Test Files 50 passed | 5 skipped
                                 Tests 622 passed | 42 skipped      EXIT=0
```

So "664 tests pass" was not a reproducible claim, and nothing in the output recorded
which of the two runs had happened.

**Change.** Two commands with two contracts.

| Command | Contract |
|---|---|
| `pnpm test` | Fast loop. May skip what needs infrastructure; prints why. |
| `pnpm test:integration` | Same suite with `DI_REQUIRE_INTEGRATION=1`. Skipping is a failure. |
| `pnpm verify` | typecheck → `phase1:generate` → `test:integration` → build. **The command that decides.** |

Under `DI_REQUIRE_INTEGRATION=1`, `announceSkip` throws with the suite name, the reason
and the fix (`docker compose up -d`), and the new `announceMissingFixtures` does the
same for the gold-isolation suite (`pnpm phase1:generate`). Fixture generation is
deterministic from a fixed seed — verified that running it leaves `eval/gold/`
byte-identical, so `pnpm verify` does not modify gold.

**Verified both directions:**

```
$ DATABASE_URL= pnpm vitest --run tests/db-migrations.test.ts
  Test Files 1 skipped        EXIT=0
$ DATABASE_URL= DI_REQUIRE_INTEGRATION=1 pnpm vitest --run tests/db-migrations.test.ts
  Test Files 1 failed         EXIT=1
```

**Regression tests** (`tests/verification-gate.test.ts`): the flag's parsing matrix, and
that `announceSkip` / `announceMissingFixtures` skip quietly by default and throw an
actionable message under the strict flag.

**Documented** in `README.md` ("Tests and acceptance") and `docs/RUNBOOK.md`
("Verifying a change before you trust it"), both stating plainly that a result from
`pnpm test` alone is not a verification result.

---

## 7. GitHub collector narrowed

### The 920 items, analysed

Production evidence (`docs/QUALITY_REVIEW.md`): 920 GitHub items decided, **0
candidates, 0 stories** — about 71% of the day's corpus for zero output — and the
curator's rejection reasons collapsed into ~119 templated strings in per-repo blocks of
exactly 30, i.e. it stopped reading them individually.

Measured live against the real API across all 16 watched repos, one cold run:

| Endpoint | Items | What they are |
|---|---|---|
| `/events` | 468 | WatchEvent 179 (someone starred), IssueCommentEvent 104, ForkEvent 50, IssuesEvent 42, PullRequestEvent 42, PullRequestReviewEvent 19, PushEvent 16, PullRequestReviewCommentEvent 6, ReleaseEvent 5, CreateEvent 3, DeleteEvent 1, DiscussionEvent 1 |
| `/tags` | 362 | Whole tag history per repo, re-dated to now |
| `/releases` | 360 | Whole release history per repo |
| `/issues` | 506 | Pre-filter |
| **Total emitted** | **1,694** | |

`eventToItem` produced items whose entire agent-visible content was
`"<repo>: <EventType>"` — no url, no summary, nothing a curator could read. Those could
only be dispositioned, never judged, which is exactly what the templated reasons show.

### Changes

- **`/events` dropped entirely.** The only two types carrying signal are covered better
  elsewhere: `ReleaseEvent` duplicates `/releases` (which also carries the notes and a
  real `published_at`), and `PublicEvent` cannot happen to a repo already on the
  watchlist. This also returns one request per repo per run to the budget.
- **Releases are watermarked** by the newest `published_at` already emitted, so an ETag
  change no longer re-emits the whole history. Drafts and unpublished releases are
  skipped. A release published today is emitted on the first run, which is what keeps
  the vLLM case working.
- **Tags are a fallback, not a firehose.** `/tags` carries no date, so the old code
  stamped every tag with the fetch time — and with `published_at = excluded.published_at`
  on upsert, every ancient tag re-floated to the top of recency views on *every run*.
  Now: the first run seeds a `knownTags` set and emits nothing; afterwards only a
  genuinely new, version-shaped tag qualifies, its real date is resolved from its commit,
  and a tag that merely mirrors a release already collected is not a second item. A tag
  whose date cannot be resolved is deferred rather than emitted with a fabricated date.
- **A closed pull request is no longer automatically important.** This was the largest
  remaining source of noise after the firehose was dropped — measured live, it admitted
  every CI tweak and test-size adjustment. A PR now clears the same bar as an issue: a
  `security` / `breaking-change` / `critical` label, or the reaction threshold. What
  actually shipped is collected from `/releases`.
- **`issuesSince` no longer advances past unfetched issues** — the cursor write moved
  inside `if (issuesRes)`. After a swallowed 429 that window was previously skipped
  forever.
- **The request budget is no longer inverted.** `fetchConditional`'s first attempt was a
  bare `ctx.fetch` with no timeout, no token bucket and no budget; `budget.consume()`
  ran only in the `catch`. The primary path now pays the same toll, under a real
  timeout that honours the collector's abort signal.
- **Health reflects repo failures.** A per-repo `catch` previously swallowed everything
  into warnings while health stayed `OK`, so all 16 repos could 401 and the collector
  reported a healthy zero. Now: some repos failing is `DEGRADED`, all failing is
  `FAILED`, and `error` is populated (it was declared and never assigned).

### Before → after, measured live

| | Items per cold run | Steady state (with cursor) |
|---|---|---|
| Before | **1,694** | ~1,690 (tags and releases re-emitted every run) |
| After | **25** | **0** |

A 98.5% reduction in volume, and — more to the point — every one of the 25 is something
a curator can read: releases with notes and URLs, labelled or well-reacted issues, and
PRs that somebody marked breaking or critical. Example output includes
`[release] v2.1.270`, `[issue] Feature Request: Add NVFP4 quantization support for KV
cache`, `[pull_request] llama : stream MoE routed experts from disk`.

**Regression fixture and tests** (`tests/collector-github.test.ts`, 14 tests): the
required one is *"collects a major watched-repo release (vLLM v0.27.1) while dropping
the release history around it"* — built from the real `vllm-project/vllm v0.27.1` shape.
Plus: generic events are never emitted and `/events` is never even requested; a release
already reported is not re-emitted; tag history is backfill on the first run and only a
genuinely new tag is reported afterwards; the issues watermark does not advance when the
fetch was rate-limited, and does advance when the window was read; a closed CI pull
request is excluded while a `breaking-change` one is included; all repos failing reports
FAILED rather than OK.

**Residual, accepted deliberately:** `ggml-org/llama.cpp` cuts a GitHub release per CI
build (`b10931`…`b10941`), so ~9 of the 25 are rolling build releases. They are left in:
a release is a deliberate publication event with notes and a URL that a curator can
reject in one line, and filtering releases by name shape is precisely the heuristic that
would eventually eat a real one. This is a watchlist-tuning question, not a collector
bug.

---

## Verification

Run against the final code state, after OrbStack was recovered and migration 003 applied:

| Check | Result |
|---|---|
| `pnpm typecheck` | **PASS** |
| `pnpm verify` | **PASS**, exit 0 (typecheck → fixtures → strict suite → build) |
| `pnpm test:integration` | **59 files, 732 tests, 0 skipped** |
| `pnpm build` | **PASS**, 13 routes |
| `pnpm db:migrate` | `003_collector-health-history.sql` applied |
| Live collection (`pnpm collect`) | **PASS**, see below |
| Live GitHub before/after | 1,694 → 25 items against the real API |

**The strict suite is the headline.** Before this pass, `pnpm test` on a machine with no
database reported `53 passed | 6 skipped` / `687 passed | 45 skipped`, exit 0, green. It
now runs **59 of 59 files and 732 of 732 tests with nothing skipped**, including all six
Postgres-backed suites and the gold-isolation security test — the first time those have
actually executed rather than silently vanished.

(The two `skipped —` lines that appear in that run's output come from
`tests/verification-gate.test.ts`, which deliberately exercises the skip path with the
flag unset. They are assertions about the gate, not suites being skipped.)

### Live collection, 2026-09-13 13:52 UTC

```
github          OK        fetched 8      inserted 1
hackernews      OK        fetched 38     inserted 38
youtube         DEGRADED  fetched 55     inserted 5
coingecko       OK        fetched 6      inserted 1
miniflux        OK        fetched 0      (incremental, nothing new)
fred            OK        fetched 0      (quiet day — correctly OK, not FAILED)
semantic-scholar OK       fetched 0      (nothing to enrich)
arxiv           FAILED    429
sec / reddit    DISABLED
```

Credentials loaded `set: 7, blank: 4` — the `set: 0, blank: 11` reading recorded in the
quality review was a transient state while the operator was editing the file, not a
context problem.

**Each fix confirmed on production data:**

| Fix | Evidence |
|---|---|
| GitHub narrowed (item 7) | **8 items fetched**, where the same collector previously pulled ~1,400 per run. Through the real pipeline, not a harness. |
| Fact anchoring (item 3) | `structured_facts` for lineage `default` went **0 → 11** — the first rows the numeric layer has ever persisted. Real readings: BTC 76,809 USD, ETH 2,479.11 USD, plus market cap, 24h volume and the two global facts. Exactly one set (3 assets × 3 + 2 global), so the day-keyed identity is collapsing correctly rather than duplicating. |
| CoinGecko identity (item 3b) | 11 facts after a run, not 11 × runs-so-far. |
| Collector health (item 5) | `last_success_at` / `last_failure_at` / `last_error` all populated. **arxiv now shows `consecutive_failures = 14`** — the counter accumulates instead of being wiped, which is precisely the silent-degradation signal that did not exist before. **youtube shows `DEGRADED, consecutive_failures = 1`**: DEGRADED increments now rather than resetting to 0. |
| Quiet sources not punished (item 4) | `fred` fetched 0 and reports **OK** with `consecutive_failures = 0` and a fresh `last_success_at`. A quiet macro day is a working day. |
| Run semantics (item 4) | The run is `degraded: true` for the right reason — arXiv FAILED — and not empty, so it was not treated as suspicious. |

---

## The OrbStack hang was not OrbStack

This blocked verification for an hour and the diagnosis is worth keeping, because it
also explains the three earlier "OrbStack hangs" recorded in `docs/QUALITY_REVIEW.md`.

**Root cause: the host was configured to sleep after 1 minute idle on AC**
(`pmset -g custom` → `sleep 1`). The chain:

1. Host sleeps → OrbStack suspends the Linux VM (`vmgr.log`: `msg=sleep` at 21:03:45).
2. macOS subsequently only *DarkWakes* (maintenance wakes). OrbStack resumes the VM
   only on a real user wake, so **no matching `msg=wake` was ever logged**.
3. Every `docker` call blocks forever against a suspended guest.

**Three separate liveness signals lied during this**, which is the part worth
remembering:

- The host-side **port forwarder kept accepting TCP**, so `nc -z 127.0.0.1 55432`
  succeeded while the Postgres handshake timed out.
- **`orb status` reported `Running`** throughout — the control plane was healthy; the
  guest was not.
- The VM did **not** recover on user interaction, contrary to the obvious expectation.
  Only `orb stop && orb start` brought it back.

`probeDatabase` in this repo gets it right because it follows the TCP probe with a real
`select 1`. **Any preflight added later must do the same and must not trust a port, a
`docker` exit code, or `orb status`.**

Fixed at the source, outside this repo: `~/Developer/setup` now carries
`scripts/power-settings.sh`, a `System sleep` check in `health.sh`, and Runbook §1.6.
`sleep` is now `0`. The 05:30 LaunchAgent could not have fired on time before this —
a `StartCalendarInterval` job does not wake a sleeping Mac and does not schedule a wake.

---

## Not done, deliberately

Per the scope of this pass: no intelligence policy, no personalization, no feedback
loop, no web UX. `config/interests.yaml` is still dead config, the
`find_history` → `changeType` invariant is still unenforced, emerging signals are still
ungated, and there is still no claim-level grounding. Those are P0-3, P0-5, P1-3 and
P1-7 in `docs/QUALITY_REVIEW.md` and are intentionally untouched here.

arXiv remains FAILED with a 429 and now carries 14 consecutive failures. That is P1-9
and is left for after the freeze.

The 5-day observation freeze begins now: no intelligence policy, model or source
configuration changes, only production evidence.
