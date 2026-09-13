# Phase 1 Report

Run date: 2026-09-13. All numbers below come from artifacts under `runs/`; nothing
here is estimated or reconstructed.

---

## 1. Implemented architecture

```
fixtures/generated/<date>/manifest.json   (79–82 synthetic items + 10–13 facts)
      │
      ▼
Pi Curator session  — restricted runtime, 12 custom tools, no builtins
      │  writes item-decisions.json + story-ledger.json through tools
      │  submit_materials: rejected until scan coverage == 100%
      ▼
materials.json
      │
      ▼
Pi Editor session   — a separate session, 7 custom tools, cannot mutate the ledger
      │              and cannot reach the raw inventory
      │  submit_brief: Zod + referential validation
      ▼
brief.json ──► renderer (facts printed from the store) ──► brief.md
      │
      ▼
validator (again, post-submit) ──► evaluator ──► evaluation.json / MANUAL_REVIEW.md
```

The design rationale is in `docs/ARCHITECTURE.md`. The load-bearing decisions:

- **No durable state inside a Pi session.** Decisions and stories live in
  `runs/_ledger/<date>/`, so a model that dies at item 50 is replaced by one that
  starts at item 51.
- **Scan coverage is a precondition, not a metric.** `submit_materials` compares
  recorded decisions against the manifest and refuses while any item is undecided.
- **Output only via validating tools.** No assistant message is ever parsed for JSON.
- **Numbers come from the fact store.** The renderer prints `StructuredFact` values by
  `factRef`; a model cannot get an invented number into `brief.md`.

## 2. Actual Pi SDK / package versions

| Package | Version | Note |
|---|---|---|
| `@earendil-works/pi-coding-agent` | 0.85.1 | direct dependency |
| `@earendil-works/pi-ai` | 0.85.1 | transitive, nested under pi-coding-agent |
| `typebox` | 1.3.7 | **not** `@sinclair/typebox` |
| Node | 24.21.0 | mise |
| pnpm | 10.34.5 | mise |
| Pi CLI | 0.85.1 | `pi --version` |

`pi-ai` does not resolve from this project because npm-shrinkwrap nests it inside
`pi-coding-agent/node_modules`. The `Model` type is therefore taken from
`ReturnType<ModelRuntime["getModel"]>` rather than imported.

## 3. Model IDs successfully resolved

`pnpm benchmark:models` (resolve-only mode), 2026-09-13:

```
OK   github-copilot/gemini-3.8-flash
OK   openai-codex/gpt-5.6-sol
OK   opencode-go/deepseek-v4.1-flash
```

All three resolve through the restricted runtime's `ModelRuntime`, and a session was
successfully constructed on each. `gemini-3.8-flash` served every live run below.

**One non-obvious requirement:** `ModelRuntime.create({ refreshOnCreate: false })`
skips cached-catalog restoration, not just the network refresh. With it false, only
statically-bundled models resolve and `opencode-go/deepseek-v4.1-flash` fails. The
runtime uses `refreshOnCreate: true` with `allowModelNetwork: false` — cache restored,
network still off.

## 4. Restricted runtime verification

Recorded per run in `restricted-runtime.json`; identical across all three days.

**Built-in tools: none.** `assertRestricted()` fails the run if `bash`, `powershell`,
`read`, `write`, `edit`, `grep`, `find` or `ls` is even *registered*, let alone active.
It did not fire.

**Extensions: none.** `extensionsResult.extensions.length === 0` on every session.
The globally installed `pi-web-access` 0.29.0 and `@narumitw/pi-usage` 0.60.8 were not
loaded — the project supplies its own `ResourceLoader`, so `DefaultResourceLoader`
(which performs that discovery) is never constructed.

**Curator active tools (12):**
`find_history`, `get_daily_inventory`, `get_item_detail`, `get_story`,
`get_structured_facts`, `list_today_stories`, `list_unseen_items`,
`read_skill_reference`, `record_item_decisions`, `search_items`, `submit_materials`,
`upsert_story`

**Editor active tools (7):**
`find_history`, `get_materials`, `get_source_items`, `get_story_detail`,
`get_structured_facts`, `read_skill_reference`, `submit_brief`

**Skill loading.** The `daily-intelligence` skill (SKILL.md + 9 references, 1,175
lines) is discovered by Pi's own `loadSkillsFromDir`, frontmatter validated, zero
diagnostics.

A finding worth recording: **Pi's skill mechanism does not work in a restricted
runtime.** `buildSystemPrompt` only emits `formatSkillsForPrompt(...)` when `read` or
`bash` is active, because the advertisement tells the model to open `SKILL.md` itself:

```js
const skillFileReadTool = ["read", "bash"].find((tool) => tools.includes(tool));
if (skillFileReadTool && skills.length > 0) prompt += formatSkillsForPrompt(...)
```

With no filesystem tool the skill would silently not load at all. This project keeps
Pi's discovery and validation and replaces only the transport: `SKILL.md` is inlined
into the system prompt, the nine references stay lazy behind `read_skill_reference` —
a tool rooted at the skill directory that rejects absolute paths and resolves symlinks
before comparing. Evidence the skill is actually in effect: the curator produced
semantic slug storyIds and called `find_history` before assigning changeTypes without
being told to in the task prompt.

**Global Pi integrity.** `~/.pi/agent/models-store.json` is byte-identical before and
after (`diff -q`, verified). `settings.json` and `auth.json` mtimes unchanged.
`~/.config/pi/web-search.json` untouched. No extension installed, no package patched.

## 5. Test results

```
pnpm typecheck   clean
pnpm test        17 files, 223 tests, all passing
```

| Suite | Tests |
|---|---|
| error-classifier | 47 |
| model-router | 31 |
| run-state | 26 |
| fixtures | 22 |
| eval-metrics | 20 |
| json-repository | 12 |
| brief-validator | 11 |
| materials-validator | 10 |
| eval-matching | 9 |
| logger | 9 |
| markdown-renderer | 7 |
| **integration** (6 files) | **19** |

Integration tests drive the real tools, validators, repository and orchestrator
through a fake `AgentDriver`, so resume, fallback, rejection handling and the run
lifecycle are all covered without a model call. Covered scenarios: partial curator run
→ resume; model failure → fallback; four distinct invalid-material submissions;
curation-incomplete rejection; editor invalid-brief retry; unknown source id;
invalid factRef; editor sandbox escape; run-state transitions; tool-loop detection;
artifact completeness; gold-truth unreachability.

No test was weakened to pass. The integration worker reported finding **zero**
production bugs in the scenarios it tested.

## 6. Live run results

Three sequential days, `github-copilot/gemini-3.8-flash`, no fallback triggered.

| Date | Run id | Items | Coverage | Ledger stories | Materials (A/B/C) | Brief stories | Must Know | Tool calls | Model time |
|---|---|---|---|---|---|---|---|---|---|
| 2026-09-10 | `2026-09-10-c4be93e1` | 79 | 79/79 | 15 | 4/8/3 | 12 | 4 | 65 | 319 s |
| 2026-09-11 | `2026-09-11-e0cb6a5b` | 82 | 82/82 | 14 | 4/6/4 | 10 | 4 | 146 | 511 s |
| 2026-09-12 | `2026-09-12-622d9987` | 81 | 81/81 | 15 | 4/8/3 | 12 | 4 | 88 | 444 s |

Item dispositions were well spread rather than degenerate — e.g. day 1:
24 CANDIDATE / 27 DUPLICATE / 28 IRRELEVANT.

**Cross-day continuity worked.** `find_history` returned hits on 32 of 74 calls on
day 2 and 8 of 18 on day 3, and storyIds persisted across days with change types
tracing the intended arcs:

| storyId | d1 → d2 → d3 |
|---|---|
| `sable-orm-v62-batch-upsert-data-loss` | NEW → **ESCALATION** → **RESOLUTION** |
| `meridian-long-context-enterprise-model` | RUMOR → **NO_MATERIAL_CHANGE** → **CONFIRMATION** |
| `corvid-robotics-talos-acquisition-rumor` | — → RUMOR → **REVERSAL** |
| `one-bit-optimizer-state-adamw-parity` | — → NEW → **UPDATE** |
| `basalt-engine-v7-revenue-share-rumor` | RUMOR → NO_MATERIAL_CHANGE → NO_MATERIAL_CHANGE |

The emerging-signal arc was also found: on day 1 the editor named
「算力擴張的實體基礎設施硬約束」, which no single item states — it exists only in
aggregate across five sources and three days. That was the hardest thing in the
fixture and the model got it.

Briefs: `runs/2026-09-10/2026-09-10-c4be93e1/brief.md`,
`runs/2026-09-11/2026-09-11-e0cb6a5b/brief.md`,
`runs/2026-09-12/2026-09-12-622d9987/brief.md`.

## 7. Evaluation metrics

| Metric | Gate | 09-10 | 09-11 | 09-12 |
|---|---|---|---|---|
| scan_coverage | = 1.00 | **1.000** | **1.000** | **1.000** |
| important_story_recall | ≥ 0.90 | 0.909 | 0.909 | 0.909 |
| selected_story_precision | ≥ 0.85 | **0.833 ✗** | 1.000 | **0.833 ✗** |
| cluster_precision | — | 1.000 | 1.000 | 0.818 |
| cluster_recall | — | 0.986 | 0.987 | 0.986 |
| cluster_f1 | ≥ 0.90 | 0.993 | 0.993 | **0.894 ✗** |
| change_type_accuracy | ≥ 0.85 | 0.933 | 0.857 | 0.867 |
| noise_rejection_rate | ≥ 0.95 | 1.000 | 1.000 | 1.000 |
| fabricated_source_ids | = 0 | 0 | 0 | 0 |
| invalid_fact_refs | = 0 | 0 | 0 | 0 |
| final_duplicate_stories | = 0 | 0 | 0 | 0 |
| final_story_count | 8–15 | 12 | 10 | 12 |
| must_know_count | 3–5 | 4 | 4 | 4 |
| schema_validity | = 1 | 1 | 1 | 1 |
| structured_output_after_retry | = 1 | 1 | 1 | 1 |
| **Overall** | | **FAIL** | **PASS** | **FAIL** |

Matching is by source-item overlap (Jaccard, with a primary-item rescue path), never
by title.

## 8. Actual fallback events

**None.** Every stage on every day succeeded on the primary model on its first
attempt: six attempts total (3 curator + 3 editor), all `SUCCESS`, `fallbackReason`
unset throughout `attempts.json`.

The fallback machinery is therefore **not validated in production**, only by
integration tests, which do exercise it against a synthetic `status: 429` quota error
and assert the chain walks gemini → gpt, records both attempts with the right failure
class, and resumes the second model from the first model's recorded decisions rather
than restarting the day. Structured-output retries were also never needed live
(`structuredOutputRetriesNeeded = 0` on all three days), so the corrective-retry path
is likewise only covered by tests.

## 9. Known limitations

1. **Fallback and corrective retry are test-verified, not live-verified.** See §8.
2. **Single model, single repetition.** Every live number is one run of
   `gemini-3.8-flash`. There is no variance estimate and no cross-model comparison —
   see §12 for why that sweep was not run.
3. **`DailyMaterials.stories` has no lower bound** but the editor needs 8–15. If a
   curator ever submits fewer than 8 stories, the editor is structurally unable to
   produce a valid brief and the day fails as `EDITOR_FAILED` after exhausting the
   chain. It did not happen (materials were 14–15 every day), and it was left alone
   deliberately rather than changing the code mid-experiment.
4. **`selected_story_precision` and the emerging-signal arc are in tension.** See §12.
5. **Fixtures are synthetic.** Real feeds are messier, contain adversarial content,
   and have far higher duplicate density. Nothing here says how this behaves on
   Hacker News at 3am.
6. **No prompt-injection testing.** Phase 1 items are trusted synthetic content.
   A production agent reading Reddit and YouTube transcripts faces injection; the
   restricted runtime limits the blast radius but was not attacked.
7. **The stall detector is coarse.** It only evaluates between turns, so a single very
   long turn that makes no progress is not interrupted.
8. **Latency.** 5–8.5 minutes of model time per day. Acceptable for a nightly job,
   not for anything interactive.

## 10. Acceptance criteria table

| Gate | Required | 09-10 | 09-11 | 09-12 | Verdict |
|---|---|---|---|---|---|
| Scan Coverage | 100% | 100% | 100% | 100% | **PASS (3/3)** |
| Important Story Recall | ≥ 90% | 90.9% | 90.9% | 90.9% | **PASS (3/3)** |
| Cluster F1 | ≥ 90% | 99.3% | 99.3% | 89.4% | **FAIL (2/3)** |
| Change Type Accuracy | ≥ 85% | 93.3% | 85.7% | 86.7% | **PASS (3/3)** |
| Selected Story Precision | ≥ 85% | 83.3% | 100% | 83.3% | **FAIL (1/3)** |
| Fabricated Source ID | 0 | 0 | 0 | 0 | **PASS (3/3)** |
| Invalid Fact Ref | 0 | 0 | 0 | 0 | **PASS (3/3)** |
| Final Duplicate Story | 0 | 0 | 0 | 0 | **PASS (3/3)** |
| Final Story Count | 8–15 | 12 | 10 | 12 | **PASS (3/3)** |
| Must Know Count | 3–5 | 4 | 4 | 4 | **PASS (3/3)** |
| Structured output after retry | 100% | 100% | 100% | 100% | **PASS (3/3)** |
| Would I read this every morning? | ≥ 4 | — | — | — | **NOT SCORED** — human only |

## 11. Final status

# FAIL

Two of three days failed at least one gate. The program runs end to end, produces
briefs that read well, and passes 10 of 12 gates on all three days — but the
acceptance gate is the acceptance gate, and it was not met.

The human score in `MANUAL_REVIEW.md` is deliberately blank in all three runs. Nothing
in this repository writes it.

## 12. Exact reasons for each failed gate

### `selected_story_precision` — 0.833 on 09-10 and 09-12 (gate 0.85)

10 of 12 brief stories matched an important gold event on both days. The four
"unjustified" stories were:

| Day | Story | Gold event | `expectedImportant` |
|---|---|---|---|
| 09-10 | `anvil-datacenter-campus-grid-delay` | `evt-20260910-trend-power-a` | false |
| 09-10 | `accelerator-cluster-power-capping-idle-study` | `evt-20260910-trend-power-b` | false |
| 09-12 | `tessellate-runtime-joules-per-token` | `evt-20260912-trend-power-e` | false |
| 09-12 | `northbridge-watt-based-compute-pricing` | `evt-20260912-trend-power-f` | false |

All four are constituents of the same emerging-signal arc — "electrical power is
becoming the binding constraint on compute capacity". Gold treats them as
individually unimportant precisely because the signal exists only in aggregate.

So the model did the hard thing right (it identified the aggregate signal and said so
in Emerging Signals) and then *also* promoted individual constituents to full stories,
which costs it precision. This is a real editorial-policy gap, not a metric artifact:
`editorial-policy.md` never says that an item whose only significance is as evidence
for a trend belongs in Emerging Signals rather than as a standalone story. Two of
twelve stories is exactly the margin between 0.833 and the 0.85 gate.

I did not adjust the threshold, the gold, or the metric. The gap is in the policy text
and should be closed there.

### `cluster_f1` — 0.894 on 09-12 (gate 0.90)

Recall stayed at 0.986; precision fell to 0.818 (predicted 88 pairs against 73 gold
pairs). A single cause, found by diffing the ledger against gold:

`us-core-cpi-august-rate-hold` merged **two** gold events into one story:

- `evt-20260912-arc-macro-cpi-d3` — August core CPI comes in below consensus at 2.4%
- `evt-20260912-std-cb-pause` — Central bank signals an extended pause after the print

That one over-merge also caused the only recall miss of the day
(`evt-20260912-std-cb-pause` "missed" because it was absorbed).

This is a defensible judgement call that lands on the wrong side of the line: the two
events are causally linked and same-day, but they are a cause and a reaction, with
different actors and different primary sources. `deduplication.md` distinguishes *same
event* / *related event* / *different event*, but gives no worked example of "policy
response to a data release", which is the single most common shape of this failure in
macro coverage.

### The two recurring `change_type` errors (gate passed, but worth recording)

`basalt-engine-v7-revenue-share-rumor`: model said `NO_MATERIAL_CHANGE`, gold says
`RUMOR` — arguably the model is right that nothing changed, while gold is tracking
that the story's *nature* is still an unconfirmed rumor. The definitions overlap.

`us-jobless-claims-weekly`: model said `UPDATE`, gold says `NEW` — a recurring weekly
release with a fresh number. Genuinely ambiguous; worth pinning down in `novelty.md`.

### Why no cross-model benchmark numbers

Section 33 of the brief required the tooling but warned against burning quota on an
exhaustive sweep when provider quota state cannot be confirmed. The tooling is
complete and all three models are confirmed to resolve and to build a session. No
sweep was run because current subscription quota could not be verified, and a 3×3×N
sweep is ~9+ full curator+editor runs at 5–8 minutes of model time each.

To run one:

```bash
pnpm benchmark:models --models gemini,gpt,deepseek --dates 2026-09-12 --repeat 1
```

Token and cost columns report `N/A` rather than a guess: the SDK exposes no reliable
per-run total at this integration point.

## 13. Recommended Phase 2 work

**Close the two gate failures first — both are content, not code.**

1. Add an explicit rule to `editorial-policy.md`: an item whose only significance is
   as evidence for a trend goes in Emerging Signals, not as a standalone story. Add a
   worked example. Re-run all three days and check precision.
2. Add a worked example to `deduplication.md` for "data release vs policy response",
   and more generally for cause/reaction pairs that share a day and a topic.
3. Tighten `novelty.md` on recurring scheduled releases (weekly claims, monthly CPI)
   and on the RUMOR-vs-NO_MATERIAL_CHANGE overlap.

**Then make the result trustworthy.**

4. Run each day ≥ 3 times to get variance. One run per day is not a measurement.
5. Run the cross-model sweep once quota is confirmed, and compare the three models on
   the same fixtures.
6. Deliberately fail a provider in a live run to validate fallback outside tests.

**Then engineering.**

7. Add a minimum-story floor to `submit_materials` (limitation §3), with a message
   telling the curator why 8 is the floor.
8. Make the stall detector work within a turn, not only between turns.
9. Replace `JsonStoryRepository` with a PostgreSQL implementation — `StoryRepository`
   already exists for exactly this, and `search_items` becomes pgvector rather than
   lexical.
10. Prompt-injection hardening before any real feed is connected: hostile fixtures
    with embedded instructions, and an assertion that the agent never follows them.
11. Only then: real collectors, the scheduler, and the web UI.
