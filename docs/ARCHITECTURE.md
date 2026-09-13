# Architecture

## What SignalForge is organised around

**SignalForge is event-centric, not article-centric.** That is the product
decision the rest of this document serves.

A feed reader's unit is the article. SignalForge's unit is the event, and the
distinction is not cosmetic:

```text
5 articles about the same release
  → 1 Story
  → multiple supporting sources
```

Which leads to the sentence that most of the pipeline exists to act on:

```text
Today's article  ≠  Today's new information
```

Most of what is published on any given day is coverage of something already
known: commentary on last week's release, a second outlet reporting the same
filing, a rumour repeated. Treating those as new is what makes a summarizer
exhausting to read. So a story is not judged in isolation — it is compared
against the ledger, and what gets recorded is what *changed*:

| Change type | Meaning |
|---|---|
| `NEW` | First observation of this event |
| `UPDATE` | Genuinely new detail on a known story |
| `ESCALATION` | The situation became more serious |
| `RESOLUTION` | It concluded |
| `REVERSAL` | It went the other way |
| `CONFIRMATION` | A rumour or single-source report is now corroborated |
| `RUMOR` | Reported, but not from a source that settles it |
| `NO_MATERIAL_CHANGE` | Coverage happened; information did not |

`NO_MATERIAL_CHANGE` is the load-bearing one. A story in that state is updated
in the ledger and deliberately kept out of the brief — the system did the
reading so that you do not have to.

## The one idea

A Pi session is a conversation, not a memory. It ends, it overflows, it dies with the
provider that was serving it. So nothing that matters is allowed to live inside one.

Every durable thing this pipeline produces — which items were collected, which were
seen, which stories exist, what changed since yesterday, what the brief says — lives
outside the session. In Phase 1 that was a directory of JSON files; in production it
is Postgres. A session is a short-lived worker that reads that state through tools,
writes back through tools, and is then thrown away.

That single decision explains most of what follows, and it is the reason the move
from files to Postgres changed the storage layer and nothing else: `StoryRepository`
is an interface, `JsonStoryRepository` and `PostgresStoryRepository`
(`src/stories/`) both implement it, and the agent-facing tool surface did not move.

## Pipeline

```
  collectors (src/collectors/*.ts, 10 registered)
        │   every item tagged UNTRUSTED_EXTERNAL_CONTENT at the boundary
        ▼
  Postgres  raw_items ──► normalized_items, structured_facts
        │   (db/migrations/001_init.sql)
        ▼
  daily manifest  ── src/pipeline/manifest.ts: the UTC-day projection of
        │             normalized_items + structured_facts, and the only shape
        │             an agent ever sees
        ▼
  Pi Curator session ── restricted runtime, 12 custom tools (13 with search_web)
        │   ── tools ──►  item_decisions, story_ledger, story_items
        │                 (the cross-day ledger)
        │
        │  submit_materials  (validated; rejects unless scan coverage == 100%)
        ▼
  daily_materials / daily_material_stories
        │
        ▼
  Pi Editor session  ── a COMPLETELY separate session, fresh context, 7 tools
        │
        │  submit_brief  (validated)
        ▼
  daily_brief_drafts ──► validator ──► daily_briefs / daily_brief_stories
        │                               emerging_signals
        ▼
  Next.js reader (web/) — Server Components reading published rows. No model
                          is ever invoked on a web request.
```

`eval/gold/` sits outside this diagram on purpose. It is read by the evaluator and by
nothing that the agent can reach.

## Collectors, and the rule about editorial filtering

Ten collectors are registered in `src/pipeline/collection.ts`: `rss` (Miniflux),
`github`, `hackernews`, `arxiv`, `semantic-scholar`, `coingecko`, `fred`, `sec`,
`reddit`, `youtube`. Per-source operational settings live in `config/sources.yaml`
and per-source subject matter in `config/watchlists.yaml`; a collector never
hardcodes a watchlist and never reads the YAML itself — `CollectorContext` hands it
its own slice (`src/collectors/types.ts`).

The binding rule (`AGENTS.md`, "Scope") is that **no editorial filtering happens
before Pi**. A collector may drop an item only for being an exact duplicate, corrupt,
unsupported, or a source-policy violation. "Looks unimportant" is the curator's
judgement, and making it early is how a pipeline silently stops seeing things.
`toNormalizedItem()` in `src/pipeline/collection.ts` is a mechanical field
projection for exactly this reason: it maps fields and does nothing else.

Everything a collector emits is external text written by someone else. It carries
`trust: UNTRUSTED_EXTERNAL_CONTENT` (`src/collectors/types.ts`), applied at the
boundary so no later layer has to remember to do it. Web-research results are
converted to the same collector item shape before they reach the model
(`src/curator/tools.ts`, the `search_web` handler) so provenance and the untrusted
marking arrive unchanged.

A collector that is missing a required credential reports `DISABLED`, not failure:
`src/pipeline/collection.ts` checks `collector.requiredSecrets` through `hasSecret()`
before calling it and records `missing required secret(s): …` as an operational fact
on the run. A run whose sources are half-credentialed still runs; it is marked
degraded, and `daily_runs.degraded_reason` says why.

## Postgres is the canonical store — and pgvector is for candidates only

`db/migrations/001_init.sql` creates both `vector` and `pg_trgm`, and
`normalized_items` carries an `embedding vector(1536)` column with an HNSW
`vector_cosine_ops` index. Two things are worth being precise about.

First, **similarity is never the decision.** Retrieval narrows the field; whether two
items describe the same real-world event is the curator's judgement, made from the
item text, and it is recorded explicitly through `record_item_decisions` and
`upsert_story`. There is no similarity threshold anywhere that merges two items on
its own. The curator's own `search_items` tool is lexical over the day's manifest,
and `find_history` searches the ledger — both are candidate generators handed to a
model that then has to decide.

Second, the embedding column is **currently unpopulated in the code path**: nothing
in `src/` computes an embedding. `upsertNormalizedItems` (`src/db/items.ts`) accepts
an optional `embedding` and `coalesce`s it, so the column and index are provisioned
and ready, but today's retrieval is full-text (`tsvector` columns on
`normalized_items` and `daily_brief_stories`) and trigram, not vector. The web
search path says so in `web/lib/queries.ts`: both halves are Postgres full-text
search ranked by `ts_rank`, with no embedding similarity standing alone and no model
in the path.

## The story ledger = cross-day memory

`story_ledger` / `story_items` / `item_decisions` are the agent's memory across
sessions and across days.

- Within a day, they are how a curator that crashed at item 50 can be replaced by a
  different model that picks up at item 51 — because the first 50 decisions are in
  Postgres, not in a dead conversation.
- Across days, they are how `find_history` answers "what did we know yesterday?",
  which is the entire basis for novelty. A `storyId` is a stable slug, so the same
  real-world event keeps its identity as it evolves from RUMOR to CONFIRMATION.

Rows are namespaced by `lineage` (`DI_LINEAGE`, default `default`), so a synthetic or
experimental run can share a database with production and still never collide with
it — the `experiments/` lineages exist for exactly that.

Emerging signals get the same treatment with a different identity rule
(`src/pipeline/signals.ts`): the label is model-written prose and drifts day to day,
so matching on it would split one signal into a new row every morning and its age —
the only interesting thing about a signal — would never accumulate. The evidence
story set is the stable identity, matched by Jaccard overlap.

## Curator and Editor are separate sessions

Not separate prompts in one session — separate sessions, built independently, with
disjoint tool sets.

The Curator can mutate the ledger and sees the raw firehose. The Editor can do
neither: its `get_source_items` only reaches items the Curator already attached to a
material story, and it has no mutation tool at all. So the Editor structurally cannot
resurrect a story the Curator discarded, and cannot quietly re-do the curation with
worse information.

It also means an Editor failure is cheap. There is no conversation worth saving — you
rebuild a fresh editor session from the stored materials and start again. That is
exactly what the `EDITOR_FAILED -> WRITING` edge in the state machine does.

Recorded tool sets (`restricted-runtime.json`, written per run):

| Stage | Tools |
|---|---|
| Curator | `find_history`, `get_daily_inventory`, `get_item_detail`, `get_story`, `get_structured_facts`, `list_today_stories`, `list_unseen_items`, `read_skill_reference`, `record_item_decisions`, `search_items`, `submit_materials`, `upsert_story` (+ `search_web` when research is configured) |
| Editor | `find_history`, `get_materials`, `get_source_items`, `get_story_detail`, `get_structured_facts`, `read_skill_reference`, `submit_brief` |

## Agent output = custom tool submission

The pipeline never parses JSON out of an assistant message. This is a rule in
`AGENTS.md` ("Deterministic validation is the trust boundary") and it is enforced
structurally, not by convention: there is no code path that reads an assistant
message for a payload. The only way a stage produces output is by calling its submit
tool, which writes into a context field the driver reads afterwards
(`CuratorToolContext.submitted`, set by `submit_materials` in
`src/curator/tools.ts`; the equivalent for `submit_brief` in `src/editor/tools.ts`).

Both submit tools parse with Zod, then run the full referential check — every item id
exists, every primary source is a subset of its story's sources, every `factRef`
resolves, every story the Editor names came from the materials. A failure **throws**;
Pi turns that into a tool error the model can read and correct. Tools signal
rejection by throwing — `AgentToolResult` has no `isError` field.

This is why "the model said it reviewed everything" is irrelevant.
`submit_materials` compares `processedItemIds()` from the repository against the
manifest and refuses to accept anything while a single item lacks a recorded
decision. Scan coverage is not a metric we hope for, it is a precondition the tool
enforces, and `AGENTS.md` makes it explicit that it has no override flag.

## Validator = trust boundary

The validators run twice, deliberately.

Once inside the submit tool, so the model gets a specific, actionable rejection and a
chance to fix it. Once again in the orchestrator after the brief is accepted, writing
`validation.json`, so a bug in the tool layer cannot let a malformed brief reach the
renderer or the publish path. `VALIDATION_FAILED` is a real terminal-ish state with
edges back to `WRITING` and `VALIDATING`, not a warning.

Numeric facts get a third layer: the renderer prints the value out of
`structured_facts`, keyed by `factRef` (`src/renderer/markdown.ts`), and the web
reader does the same thing at render time (`web/lib/facts.ts`). A model that invents
"up 4.2%" cannot get that number into a brief — the renderer does not read its prose,
it reads the fact. An unresolvable fact id renders as an explicit gap, never as a
substituted figure.

## Restricted runtime

The global Pi at `~/.pi/agent` is an interactive tool with bash, file access,
`pi-web-access` and `pi-usage`. A worker that ingests untrusted feed content must
have none of that.

`createRestrictedSession()` in `src/runtime/pi-runtime.ts` builds a session with:

- `noTools: "all"` plus an explicit `customTools` array and a matching `tools`
  allowlist — so the active tool set is exactly the tools this stage defines.
- A sealed `ResourceLoader` (`createSealedResourceLoader`) that returns zero
  extensions, prompts, themes and agents-files. This is what keeps globally installed
  extensions, `~/.pi/agent` content and any `cwd/.pi` content out; discovery is done
  by `DefaultResourceLoader`, which is never constructed here.
- An in-memory `SettingsManager` — the global `settings.json` is neither read nor
  written.
- `ModelRuntime` pointed at `GLOBAL_AUTH_PATH` (`~/.pi/agent/auth.json`) so existing
  OAuth logins work. That is the only global file the runtime reads, and it is read
  for OAuth reuse and nothing else.

Then `assertRestricted()` fails the run if `extensionCount !== 0`, if any active tool
is not in the expected custom-tool list, if any expected tool is missing, or if any
of `bash`, `powershell`, `read`, `write`, `edit`, `grep`, `find`, `ls` is even
*registered* — not merely active. A future Pi version changing a default is caught
here rather than discovered later by an agent that suddenly has a shell.
`assertRestricted()` is exported and unit-tested, and `AGENTS.md` forbids downgrading
its failure to a warning.

### The skill problem, and what was done about it

Pi loads skills lazily: `buildSystemPrompt` appends an `<available_skills>` block
naming `SKILL.md` and its path, and expects the model to open it with `read` or
`bash`. The code gates on it:

```js
const skillFileReadTool = ["read", "bash"].find((tool) => tools.includes(tool));
if (skillFileReadTool && skills.length > 0) prompt += formatSkillsForPrompt(...)
```

With no filesystem tools, that mechanism does nothing — the skill would silently not
load. Copying the whole skill into the prompt would "work" but would stop it being a
skill and would burn the whole reference corpus of context on every turn.

So the discovery half stays real and only the transport changes
(`src/runtime/skill-access.ts`). Skills are found by Pi's own `loadSkillsFromDir`
(frontmatter validated, diagnostics surfaced). The `SKILL.md` body — frontmatter
stripped, the workflow needed on every turn — is inlined into the system prompt by
`renderSkillSection`. The nine reference documents under
`agent/skills/daily-intelligence/references/` stay lazy behind
`read_skill_reference`, the single filesystem-touching tool in the entire system.
Its `resolveWithin()` rejects absolute paths and any path that escapes the skill
directory, comparing after `realpathSync` so a symlink cannot walk out either. It
will read nothing else on the machine, and `AGENTS.md` forbids widening its root.

## Model fallback, at the worker level

Pi has no cross-provider fallback, so this project implements it in
`src/runtime/model-router.ts`. `runStageWithFallback()` contains no Pi SDK import at
all and is therefore fully unit-testable against a fake `onAttempt`.

Errors are classified by `status` / `code` / `name` / `cause` before ever looking at
message text (`src/runtime/error-classifier.ts`), then `decideAction(failureClass,
sameModelAttempts)` maps the class to an action:

| Failure class | Action |
|---|---|
| `NETWORK`, `TIMEOUT`, `RATE_LIMIT`, `SERVER_ERROR` | retry once on the same model, then fall back |
| `QUOTA`, `BILLING`, `MODEL_UNAVAILABLE`, `AUTH` | fall back immediately |
| `INVALID_AGENT_OUTPUT` | one corrective retry on the same model, then fall back |
| `TOOL_LOOP` | one resume on the same model, then fall back |
| `CONTEXT_OVERFLOW` | fresh session on the **same** model, always |
| `PROGRAMMER_ERROR`, `USER_ABORT` | fail; never retried |
| `UNKNOWN` | retry once, then fall back |

`RouterState` remembers which providers proved unusable (AUTH failures) during a run
and skips them for the rest of it. `runStageWithFallback()` walks the chain from
`MODEL_CHAIN` (`src/runtime/model-config.ts`, mirrored in `config/agent.yaml`) and
enforces `maxAttemptsPerModel` (default 4).

`CONTEXT_OVERFLOW` deliberately does not switch models. It opens a fresh session on
the same model, which works precisely because the durable state is external.

Falling back never migrates a half-dead conversation. The new model gets a resume
prompt describing what is already stored and continues from the first undecided item.

## Web research is routed, budgeted, and degradable

`search_web` is the one tool that reaches the network, and it is not part of the
default curator tool set — it appears only when research is configured. It routes
through `ResearchRouter` (`src/research/router.ts`): Tavily first, Exa on any
failure. Provider failure never throws out of the router; a research outage degrades
the brief, it does not fail the run. The failure is mapped to an admin-safe
`DegradedReason` (`TAVILY_CREDENTIAL_MISSING`, `TAVILY_AUTH_FAILED`,
`TAVILY_RATE_LIMITED`, `TAVILY_TIMEOUT`, `TAVILY_MALFORMED_RESPONSE`,
`TAVILY_UNAVAILABLE`) and surfaced on the run's `degraded_reason`. When every
provider fails the tool rejects with an instruction to proceed from existing evidence
and lower the story's confidence.

`ResearchBudgetTracker` enforces query length, result count, per-story calls and
per-run calls from `config/agent.yaml` `searchWeb`. Budget exhaustion is a clean
`REFUSED` outcome — never an exception and never a silent truncation.

## The production run state machine

`src/pipeline/daily-run.ts` defines thirteen states and the only legal edges between
them. `daily_runs.status` stores a `PipelineState` verbatim (migration 002 widened
the check constraint for exactly this), so `/admin/runs` reads the real state with no
lossy mapping.

```
CREATED ──► COLLECTING ──► COLLECTED ──► CURATING ──► MATERIALS_READY
   └────────────────────────────────────────┘             │
                                                          ▼
                                                       WRITING ──► DRAFT_READY
                                                          │            │
                                                          ▼            ▼
                                                   EDITOR_FAILED   VALIDATING ──► PUBLISHED
                                                          ▲            │
                                                          └────────────┴──► VALIDATION_FAILED
COLLECTING ──► COLLECTION_FAILED ──► COLLECTING
CURATING   ──► CURATION_FAILED   ──► CURATING
```

The shape of that table is the point: **every failure state has an edge back to the
entry state of the stage that failed, and nowhere else.** That is what "retry one
stage" means, and it is why a failed curation can never skip forward to publishing.
`VALIDATION_FAILED` is the one state with two edges — back to `WRITING` for a rewrite
and back to `VALIDATING` for a re-check — and a rejected draft goes to a *fresh*
editor session, because the draft is what was wrong. `PUBLISHED` is terminal; a new
day, or a new run, starts at `CREATED`. `assertTransition()` throws
`IllegalTransitionError` on anything else.

Retry works from persisted state, not from a saved conversation. `DailyRunOptions`
takes a `runId` to resume an existing run, a `stage` to run exactly one stage while
reading everything else from the store, and `skipCollection` for a resumed run whose
collection already finished. A resumed curator reads `processedItemIds()` and starts
at the first item without a decision.

## Fault injection is test-only, and says so in the artifact

`src/runtime/fault-injection.ts` can synthesize a real, classifier-real provider
failure at a chosen point in a chosen stage, so the fallback path can be exercised
without waiting for an actual outage. It is off unless
`DAILY_INTELLIGENCE_FAULT_INJECTION` holds a valid JSON spec — never keyed off
`NODE_ENV`, test mode or a config file — and an invalid spec throws at startup rather
than silently disabling itself. The synthesized error goes through the real
`classifyError`, and every attempt it produces carries a `faultInjected` record, so
an injected fallback can never be mistaken for a spontaneous one in a report.

## Run artifacts

Postgres is canonical, but each run still writes `runs/<date>/<run-id>/` (or
`experiments/<lineage>/<date>/<run-id>/`) for forensics:

| File | What it answers |
|---|---|
| `manifest.json` | exactly what the agent was shown |
| `run-state.json` | where the run got to, and why it stopped |
| `attempts.json` | every model attempt, with failure class, fallback reason and any `faultInjected` record |
| `events.jsonl` | append-only trace of every tool call and transition |
| `item-decisions.json` | the scan-coverage evidence |
| `story-ledger.json` | the clustering as the curator left it |
| `materials.json` | the curator's handoff |
| `brief.json` / `brief.md` | the output, structured and rendered |
| `validation.json` | the post-submit check |
| `evaluation.json` / `evaluation.md` / `MANUAL_REVIEW.md` | the automated score, and the deliberately empty human one |
| `restricted-runtime.json` | the tool names actually active in each stage |
| `summary.md` | the human-readable round-up |

All JSON is written temp → `fsync` → atomic `rename` (`src/runtime/atomic-json.ts`),
so a crashed agent leaves whole files or no file, never a half-written one the next
stage would happily parse.
