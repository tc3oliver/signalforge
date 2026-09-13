# Architecture

## The one idea

A Pi session is a conversation, not a memory. It ends, it overflows, it dies with the
provider that was serving it. So nothing that matters is allowed to live inside one.

Every durable thing this pipeline produces — which items were seen, which stories
exist, what changed since yesterday, what the brief says — lives in files outside the
session. A session is a short-lived worker that reads that state through tools,
writes back through tools, and is then thrown away.

That single decision explains most of what follows.

## Pipeline

```
fixtures/generated/<date>/manifest.json        (synthetic day, agent-visible)
        │
        ▼
  Pi Curator session  ── tools ──►  runs/_ledger/<date>/item-decisions.json
                                    runs/_ledger/<date>/story-ledger.json
        │
        │  submit_materials  (validated, rejects unless scan coverage == 100%)
        ▼
  materials.json
        │
        ▼
  Pi Editor session   ── a COMPLETELY separate session, fresh model, fresh context
        │
        │  submit_brief  (validated)
        ▼
  brief.json ──► renderer ──► brief.md
        │
        ▼
  validator ──► evaluator ──► evaluation.json / MANUAL_REVIEW.md
```

`eval/gold/` sits outside this diagram on purpose. It is read by the evaluator and by
nothing that the agent can reach.

## Story Ledger = external working memory

`JsonStoryRepository` is the agent's memory across sessions and across days.

- Within a day, it is how a curator that crashed at item 50 can be replaced by a
  different model that picks up at item 51 — because the first 50 decisions are on
  disk, not in a dead conversation.
- Across days, it is how `find_history` can answer "what did we know yesterday?",
  which is the entire basis for novelty. A `storyId` is a stable slug, so the same
  real-world event keeps its identity as it evolves from RUMOR to CONFIRMATION.

`StoryRepository` is an interface. Phase 1 implements it over JSON files; a future
PostgreSQL implementation swaps in without the agent workflow changing at all, which
is the point of having the interface this early.

## Curator and Editor are separate sessions

Not separate prompts in one session — separate sessions, built independently, with
disjoint tool sets.

The Curator can mutate the ledger and sees the raw firehose. The Editor can do
neither: its `get_source_items` only reaches items the Curator already attached to a
material story, and it has no mutation tool at all. So the Editor structurally cannot
resurrect a story the Curator discarded, and cannot quietly re-do the curation with
worse information.

It also means an Editor failure is cheap. There is no conversation worth saving —
you rebuild a fresh editor session from `materials.json` and start again.

## Agent output = custom tool submission

The pipeline never parses JSON out of an assistant message.

`submit_materials` and `submit_brief` are the only ways to produce output. Both parse
with Zod, then run the full referential check — every item id exists, every primary
source is a subset of its story's sources, every `factRef` resolves, every story the
Editor names came from the materials. A failure throws, which Pi turns into a tool
error the model can read and correct.

This is why "the model said it reviewed everything" is irrelevant. `submit_materials`
compares `processedItemIds` against the manifest and refuses to accept anything while
a single item lacks a recorded decision. Scan coverage is not a metric we hope for,
it is a precondition the tool enforces.

## Validator = trust boundary

The validators run twice, deliberately.

Once inside the submit tool, so the model gets a specific, actionable rejection and a
chance to fix it. Once again in the orchestrator after the brief is accepted, writing
`validation.json`, so a bug in the tool layer cannot let a malformed brief reach the
renderer.

Numeric facts get a third layer: the renderer prints the value out of the fact store,
keyed by `factRef`. A model that invents "up 4.2%" cannot get that number into
`brief.md` — the renderer does not read its prose, it reads the fact.

## Restricted runtime

The global Pi at `~/.pi/agent` is an interactive tool with bash, file access,
`pi-web-access` and `pi-usage`. A worker that ingests untrusted feed content must have
none of that.

`createRestrictedSession()` builds a session with:

- `noTools: "all"` plus an explicit `customTools` array and a matching `tools`
  allowlist — so the active tool set is exactly the tools this stage defines.
- A hand-written `ResourceLoader` that returns empty for extensions, prompts, themes
  and context files. This is what keeps the globally-installed extensions out; they
  are discovered by `DefaultResourceLoader`, which is never constructed here.
- `SettingsManager.inMemory()` — the global settings file is not read and not written.
- `SessionManager.inMemory()` — no session history is persisted anywhere.
- `ModelRuntime` pointed at the global `auth.json` so existing OAuth logins work.
  That is the only global file the runtime depends on.

Then `assertRestricted()` fails the run if the active tools are not exactly what was
asked for, if any builtin is even *registered*, or if any extension loaded. A future
Pi version changing a default is caught here rather than discovered later by an agent
that suddenly has a shell.

### The skill problem, and what was done about it

Pi loads skills lazily: `buildSystemPrompt` appends an `<available_skills>` block
naming `SKILL.md` and its path, and expects the model to open it with `read` or
`bash`. The code literally gates on it:

```js
const skillFileReadTool = ["read", "bash"].find((tool) => tools.includes(tool));
if (skillFileReadTool && skills.length > 0) prompt += formatSkillsForPrompt(...)
```

With no filesystem tools, that mechanism does nothing — the skill would silently not
load. Copying the whole skill into the prompt would "work" but would stop it being a
skill and would burn ~1200 lines of context on every turn.

So the discovery half stays real and only the transport changes. Skills are found by
Pi's own `loadSkillsFromDir` (frontmatter validated, diagnostics surfaced). `SKILL.md`
— the workflow, needed on every turn — is inlined into the system prompt. The nine
reference documents stay lazy behind `read_skill_reference`, a tool whose root is the
skill directory, which rejects absolute paths and resolves symlinks before comparing,
and which will read nothing else on the machine.

## Model fallback

Pi has no cross-provider fallback, so this project implements it at the worker level
in `runStageWithFallback`, which contains no Pi import at all and is therefore fully
unit-testable.

Errors are classified by `status` / `code` / `name` / `cause` before ever looking at
message text, then mapped to an action: retry the same model once (transient), fall
back immediately (quota, billing, model unavailable), retry with a corrective prompt
(invalid output), resume (tool loop), or fail outright (programmer error).

`CONTEXT_OVERFLOW` deliberately does **not** switch models. It opens a fresh session
on the same model, which works precisely because the durable state is external.

Falling back never migrates a half-dead conversation. The new model gets a resume
prompt describing what is already on disk and continues from the first undecided item.

## Run artifacts

Each run writes `runs/<date>/<run-id>/`:

| File | What it answers |
|---|---|
| `manifest.json` | exactly what the agent was shown |
| `run-state.json` | where the run got to, and why it stopped |
| `attempts.json` | every model attempt, with failure class and fallback reason |
| `events.jsonl` | append-only trace of every tool call and transition |
| `item-decisions.json` | the scan-coverage evidence |
| `story-ledger.json` | the clustering as the curator left it |
| `materials.json` | the curator's handoff |
| `brief.json` / `brief.md` | the output, structured and rendered |
| `validation.json` | the post-submit check |
| `evaluation.json` / `MANUAL_REVIEW.md` | the automated score, and the empty human one |
| `restricted-runtime.json` | the tool names actually active in each stage |

All JSON is written temp → `fsync` → atomic `rename`, so a crashed agent leaves whole
files or no file, never a half-written one the next stage would happily parse.
