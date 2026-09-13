# Intelligence Backlog (post-freeze)

Produced from a read-only audit of the code at commit `ed4f859` on 2026-09-13. Every "current state" claim
below cites the file and line that was actually read. Nothing in this document is
implemented; it is design and audit material for after the observation freeze.

## 0. Scope and freeze rule

The observation freeze runs 2026-09-13 through 2026-09-18. During that window no
change described here is implemented, no prompt or skill text is edited, no
migration is added and no threshold is tuned. The purpose of the freeze is to
observe the pipeline as it is. Two principles bind every item below. First,
personal weights are priors, not filters: an interest weight may shift ranking
and section placement, but the Curator's obligation to decide every item and the
Editor's obligation to write only from materials never depend on it. Second, no
new LLM judges: every gate proposed here is deterministic code over structured
evidence (ids, tool-call records, join rows), never a second model grading the
first.

---

## P1-1 Personalization

### Current state

- `config/interests.yaml` and `config/interests.local.yaml` exist (`config/` listing).
  The local file wins outright when present, not merged: `src/config/loader.ts:38-47`.
- The schema is strict and validated: `InterestTopic` has `id`, `label`,
  `weight` (0..1), `keywords`, `aliases` (`src/config/schema.ts:12-28`), and
  `loadConfig` parses it first (`src/config/loader.ts:84`).
- Tests cover loading and override: `tests/config.test.ts:17,74-83,135`,
  `tests/config-local-override.test.ts:60-81`.
- **The parsed interests never reach either agent.** The only production reader of
  `config.interests` is the setup check, which prints a topic count
  (`src/cli/setup-check.ts:66-68`). `loadConfig()` is otherwise called only for
  `agent.searchWeb`, `agent.modelChain` and collector sources
  (`src/cli/run-daily.ts:28,103`, `src/pipeline/collection.ts:412,757`).
- The Curator system prompt takes only `date`, `totalItems`, `skillSection`
  (`src/curator/prompt.ts:1-5`, built at `src/curator/session.ts:95-98`). The
  Editor prompt takes `date`, `materialCount`, `tierACount`, `skillSection`,
  `hasPreviousBrief` (`src/editor/prompt.ts:3-9`, `src/editor/session.ts:111-112`).
  `CuratorContext` carries `date`, `manifest`, `repo`, `now` and hooks only
  (`src/curator/tools.ts:49-69`). No tool exposes interests.
- The reader persona is a hardcoded sentence: "a technically sophisticated
  engineer who works in AI and software" (`src/editor/prompt.ts:23`).
- The database has an `interest_profiles` table with `weights jsonb` and a
  one-active-version index (`db/migrations/001_init.sql:279-289`). No code in
  `src/` or `web/` reads or writes it (rg over the tree found only the migration
  and the table-name list in `tests/db-migrations.test.ts:58`).

Conclusion: interests are validated configuration with no consumer. Personalization
today is entirely the skill text plus the one hardcoded persona sentence.

### Design: interests -> ReaderProfile -> Curator -> Editor

Data flow:

1. `loadConfig().interests` is projected into a `ReaderProfile` value object
   (new module `src/profile/reader-profile.ts`): `{ topics: [{id, label, weight,
   keywords, aliases}], persona: string, version: string }`. `version` is a hash of
   the effective YAML so a brief can record which profile shaped it.
2. The Curator receives the profile two ways. A rendered "Reader profile" block in
   the system prompt (`CuratorPromptContext` gains `readerProfile`), and a new
   read-only tool `get_reader_profile` so a resumed session can re-fetch it. The
   prompt text must say explicitly: weights raise or lower `relevance`; they never
   justify skipping an item decision, marking an item IRRELEVANT on weight alone,
   or dropping a high-importance story outside the listed topics.
3. `upsert_story` gains an optional `topicIds: string[]` field validated against
   the profile's topic ids (same pattern as `factRefs` at
   `src/curator/tools.ts:360-365`). This is how the prior becomes auditable.
4. The Editor receives the same block (`EditorPromptContext` gains `readerProfile`;
   the hardcoded persona sentence at `src/editor/prompt.ts:23` is replaced by the
   profile's `persona`). Weights inform section ordering and Must Know selection,
   not eligibility.
5. `daily_runs` (or `daily_briefs`) records `profile_version` so a change in
   interests is visible in the run history.

Files to change: `src/config/schema.ts` (add optional `persona`),
`src/profile/reader-profile.ts` (new), `src/curator/prompt.ts`,
`src/curator/session.ts`, `src/curator/tools.ts`, `src/schemas/story.ts`
(`topicIds`), `src/editor/prompt.ts`, `src/editor/session.ts`,
`src/pipeline/daily-run.ts` (thread the profile), one migration for
`profile_version` and `story_ledger.topic_ids`. `interest_profiles` either gets a
writer (snapshot on each run) or is dropped; decide with the story_items audit.

Test plan: unit test that the rendered profile block is present in both system
prompts and contains every topic label; tool test that `upsert_story` rejects an
unknown `topicId`; policy test that the prompt contains the "priors not filters"
sentence; integration test on a fixture day that changing a weight changes
`relevance` ordering but not the set of decided items (`tests/integration/
curator-rejections.test.ts` pattern); eval regression via `src/eval/`.

Risk: the prompt gets longer for every run; keep the block under ~40 lines. A
model may over-apply weights and starve off-topic must-knows; the acceptance
criterion below guards that.

Acceptance criteria:
- Both system prompts contain the reader profile derived from the effective YAML.
- A fixture run with all weights set to 0 still records a decision for every item
  and still produces a brief within `requiredStoryCount`.
- `upsert_story` with an unknown `topicId` is rejected with a correctable error.
- The published brief row carries the `profile_version` that shaped it.

---

## P1-2 Historical Intelligence Invariant

### Current state

- The rule "before assigning a changeType, call find_history" is prompt and skill
  text only: system prompt rule 5 (`src/curator/prompt.ts:29`), the
  `find_history` tool description (`src/curator/tools.ts:242-243`), the skill
  (`agent/skills/daily-intelligence/SKILL.md:44-47,64-66`) and the novelty
  reference (`agent/skills/daily-intelligence/references/novelty.md:18-50`).
- `find_history` runs the repository query and records a hit count through the
  `note` hook (`src/curator/tools.ts:250-262`). Nothing stores the result in the
  tool context.
- `upsert_story` validates the Zod payload, that `sourceItemIds` are in the
  manifest, that `primarySourceIds` is a subset, and that `factRefs` exist
  (`src/curator/tools.ts:337-365`). It then writes (`src/curator/tools.ts:367`).
  **There is no check that `find_history` was ever called, for this storyId or at
  all, before a non-NEW `changeType` is accepted.**
- The repository layer is equally uninformed: `upsertStoryRow` writes
  `story_ledger` only (`src/db/stories.ts:88-125`); the `change_type` check
  constraint is an enum only (`db/migrations/001_init.sql:115-117`).
- The existing test for this rule asserts the skill document contains the
  sentences (`tests/policy-docs.test.ts:87-113`), which proves the text exists,
  not that behaviour is enforced. The test comment records the motivating
  failure: three of four changeType errors in one run were first appearances
  recorded as continuations (`tests/policy-docs.test.ts:82-86`).
- The Editor has the same soft rule for `whatChanged` (`src/editor/prompt.ts:38`)
  with no enforcement in `validateBrief`.

### Design: deterministic enforcement

`CuratorContext` gains a `historyEvidence` map keyed by storyId, populated by the
`find_history` handler:

```
historyEvidence: Map<storyId, { queries: [{ text?, storyId?, at, hitIds: string[] }] }>
```

Attribution rule ("relevant" lookup): a lookup counts for storyId S when either
(a) it was called with `storyId = S`, or (b) it was a text query whose results
include a ledger entry with `storyId = S`. A text query with zero hits counts as
evidence for a NEW verdict on any storyId created within the same session after
it, but only if no later query for that storyId returned hits.

`upsert_story` gate, evaluated before the repository write:

- `changeType = NEW`: allowed if there is no relevant lookup with hits for S. If a
  relevant lookup returned S on a prior date, reject: "find_history found S on
  <date>; NEW is not possible, choose UPDATE/CONFIRMATION/...".
- Any other `changeType`: require at least one relevant lookup with at least one
  hit for S. Otherwise reject: "changeType X requires a prior-day ledger entry;
  call find_history({storyId: S}) first" (the model never calls find_history and
  sends UPDATE -> deterministic rejection).
- `NO_MATERIAL_CHANGE` additionally requires the most recent prior entry to exist
  (already implied) and the merge path on the same day to not be the only history.

Persistence: `story_ledger` gains `history_evidence jsonb` (queries used,
hit story ids and dates) written by `upsertStoryRow`; the `StoryLedgerEntry`
schema gains `historyEvidence` (optional, default empty) so the JSON repository
(`src/stories/json-repository.ts`) stays compatible. The web story page can then
answer "Why is this UPDATE?" by rendering the prior entry it was judged against.

Resume path: a fresh session inherits nothing in memory, so
`buildCuratorResumePrompt` already tells the model to call `find_history` before
creating a story (`src/curator/prompt.ts:94`); the gate makes that mandatory.
Evidence persisted on the ledger row from the earlier attempt should be reloaded
into `historyEvidence` at session start so a merge on the same day is not
rejected for lack of a lookup that already happened.

Files: `src/curator/tools.ts` (context field, `find_history` recording,
`upsert_story` gate), `src/stories/repository.ts` and both repositories,
`src/db/stories.ts`, `src/schemas/story.ts`, one migration, `web/lib/queries.ts`
and `web/app/story/[id]/page.tsx` (render evidence), `src/curator/prompt.ts`
(rule 5 becomes "the tool will refuse"). Optional later: mirror the gate in
`validateBrief` for `whatChanged` using the Editor's own `find_history` calls.

Tests: unit test on `createCuratorTools` with the fake agent
(`tests/support/fake-agent.ts`): (1) no find_history, upsert UPDATE ->
ToolRejection; (2) find_history by storyId with a hit, upsert UPDATE -> accepted
and evidence persisted; (3) find_history hit, upsert NEW -> rejected; (4) text
query with no hits, upsert NEW -> accepted; (5) resume: evidence reloaded from the
ledger allows a same-day merge. Migration test extends
`tests/db-migrations.test.ts`. Repository parity test in
`tests/db-story-repository.test.ts` and `tests/json-repository.test.ts`.

Risk: the gate can trap a model in a rejection loop if the error text is not
actionable; every rejection must name the exact call to make. Text-query
attribution may under-attribute when the model queries by a paraphrase; the
storyId query path is the unambiguous fallback and the error message should point
to it.

Acceptance criteria:
- Model never calls `find_history`, then calls `upsert_story` with any non-NEW
  `changeType`: deterministic rejection, nothing written.
- Model calls `find_history` that returns S on an earlier date, then upserts S as
  NEW: deterministic rejection.
- Accepted non-NEW upserts persist `historyEvidence` naming at least one prior
  `(storyId, date)`.
- The web story page shows, for a non-NEW entry, which prior entry it was judged
  against.
- The policy-docs test keeps passing unchanged; the skill text is not weakened.

---

## P1-3 Claim-level Grounding

### Current state: what the validator can prove

- Source id exists in today's manifest: `createSourceValidator.unknownItemIds`
  (`src/validator/source-validator.ts:12-24`), used at
  `src/validator/brief-validator.ts:131-136`. Verified.
- Source belongs to the story's material: subset check against
  `material.sourceItemIds` (`src/validator/brief-validator.ts:138-146`). Verified.
- factRef exists: `unknownFactIds` (`src/validator/brief-validator.ts:148-153`),
  plus a second check in the tool (`src/editor/tools.ts:251-256`). Verified.
- Story is in materials, no duplicate storyId, story and Must Know counts,
  signal storyIds in materials, non-empty watchNext
  (`src/validator/brief-validator.ts:74-173`).
- What it cannot prove: that any sentence of `whatHappened`, `whatChanged`,
  `whyItMatters` or `impact` is supported by any cited source. The four fields are
  free strings with `min(1)` (`src/schemas/brief.ts:23-26`,
  `src/editor/tools.ts:184-187`); `sourceItemIds` is one flat list per story
  (`src/schemas/brief.ts:28`) with no link to any field. The renderer prints the
  four strings verbatim (`src/renderer/markdown.ts:71-74`) and so does the web
  story page (`web/app/story/[id]/page.tsx:71-77`).

### Design: minimal structural evidence mapping

Change the story contract so factual fields carry their own evidence, and
analytical fields are labelled as analysis:

```
whatHappened: { text: string, evidenceSourceIds: string[] (min 1) }
whatChanged:  { text: string, evidenceSourceIds: string[] (min 1) }
whyItMatters: { analysis: string }
impact:       { analysis: string }
```

Validator additions (deterministic only): each `evidenceSourceIds` entry must be
in the story's `sourceItemIds` and therefore in materials; `whatChanged`
evidence may additionally cite a prior-day ledger entry id once P1-2 lands. No
sentence-level checker, no LLM judge; the claim is structural: "this paragraph
was written against these sources", which is auditable by a human on the story
page.

Plan:
1. Schema: `src/schemas/brief.ts` gains the nested shapes; keep a
   `DailyBriefStoryV1` parser for stored rows.
2. Tool: `src/editor/tools.ts:178-195` parameter schema and the `normalized`
   step (`:224-229`) change accordingly; `src/editor/prompt.ts:35-36` rules
   updated to explain the split.
3. Validator: `src/validator/brief-validator.ts` adds the per-field subset check.
4. Storage: migration adds `what_happened_sources text[]` and
   `what_changed_sources text[]` to `daily_brief_stories`
   (`db/migrations/001_init.sql:229-256`); the generated `search` column keeps
   indexing the text. `src/db/briefs.ts` writes and reads both shapes.
5. Renderer: `src/renderer/markdown.ts:71-74` prints the text and appends the
   evidence ids under the factual fields only.
6. Web: `web/app/story/[id]/page.tsx:71-77` shows evidence links per field;
   `web/lib/queries.ts` maps old rows to the new shape with empty evidence.
7. Tests: `tests/brief-validator.test.ts` (evidence not in sourceItemIds ->
   reject), `tests/markdown-renderer.test.ts`, `tests/web-rendering.test.ts`,
   `tests/integration/editor-sandbox.test.ts`, fixture and gold files under
   `fixtures/` regenerated with the new shape, JSON-contract compatibility test
   that a stored V1 brief still renders.

This changes the Editor output contract, the stored brief JSON, the renderer and
the web reader at once. It must wait for post-freeze and ship as one change set
behind a fixture-backed eval run.

---

## P1-4 Feedback Loop

### Current state

- The web reader is server-rendered, reads Postgres only and has one route
  handler, the RSS feed (`find web/app -name route.ts` -> `web/app/feed.xml/route.ts`).
  Search is a GET form (`web/app/search/page.tsx:34`). There is no POST surface.
- There is no authentication; `/admin` is gated by an environment flag only
  (`web/lib/admin.ts:11-16`, `web/app/admin/layout.tsx:10-13`,
  `web/README.md:100`). Tests pin that gate (`tests/web-admin-gate.test.ts:8-29`)
  and that no LLM runs on the request path (`tests/web-no-llm.test.ts:49-79`).
- No feedback table exists in `db/migrations/001_init.sql` or later migrations.

### Design (capture only)

Tables (one migration):

```
story_feedback         (lineage, date, story_id, action, note, created_at, client)
  action in ('USEFUL','NOT_USEFUL','SHOULD_RANK_HIGHER')
brief_feedback         (lineage, date, rating int 1..5, note, created_at, client)
missed_story_feedback  (lineage, date, description text, url text, created_at, client)
```

All three reference the published brief `(lineage, date)`; `story_feedback` also
references `daily_brief_stories`. Append-only; no update or delete path.

v1 actions: Useful, Not useful, Should rank higher, Missing important story
(free text plus optional URL), Brief rating. Nothing reads these tables in the
pipeline. No prompt, interests file or threshold changes automatically.

Write endpoint constraint: the reader is loopback-bound by default and has no
identity. A write endpoint therefore must (a) be off unless an explicit flag such
as `SIGNALFORGE_FEEDBACK=1` is set, mirroring the admin gate; (b) accept only
same-origin form POSTs with a per-process CSRF token; (c) rate-limit by client
address and cap note length; (d) record `client` (address, user agent) so a stray
LAN writer is at least visible. This is single-reader tolerance, not
authentication; if the reader is ever exposed beyond loopback, feedback needs a
real identity first.

Future (separate item, not v1): a weekly job summarises feedback into a proposed
`interests.local.yaml` diff written to `runs/` for the owner to approve by hand;
only an approved diff changes configuration. Never auto-apply.

Tests: migration test, a Next route test that the endpoint 404s when the flag is
off, that a valid POST inserts one row, and that the no-LLM and no-client-DB
tests still pass.

---

## story_items audit

- Table: `db/migrations/001_init.sql:130-140`, keyed `(lineage, story_id, date,
  item_id)` with `role in ('PRIMARY','SUPPORTING')` and a cascade to
  `story_ledger`.
- Production writers: none. The ledger upsert writes `story_ledger` only
  (`src/db/stories.ts:96-125`), and `PostgresStoryRepository.upsertStory` calls
  only that (`src/stories/postgres-repository.ts:50-55`). An rg over `src/`,
  `web/`, `scripts/` and `tests/` for `story_items` finds: the migration, the
  read helper `listStoryItemRoles` (`src/db/stories.ts:381-393`), the test reset
  (`src/db/test-support.ts:126`), the migration table list
  (`tests/db-migrations.test.ts:56`) and the dev seed.
- Dev seed writer only: `web/scripts/seed-dev.ts:687-694` inserts PRIMARY /
  SUPPORTING rows. This is development data, not the pipeline.
- Production reader: the web story page loads roles from it
  (`web/lib/queries.ts:137-143`). In production that map is always empty, so the
  role display is dead-on-arrival until a writer exists. The same information is
  already available redundantly as `source_item_ids` and `primary_source_ids`
  arrays on `story_ledger` (`db/migrations/001_init.sql:109-110`).

Option A: make `story_items` the canonical story-to-item relation. Populate it
from `upsertStoryRow` in the same transaction (role derived from
`primarySourceIds`), keep the arrays as a denormalised cache for now, and build
on the join for P1-3 evidence per field (add `evidence_field`), source-quality
reporting per source, and a related-story graph (stories sharing items).
Option B: drop the table and the read helper; the arrays already carry the facts.

Recommendation: A. The owner's stated preference is a canonical relation, and
every later item here (claim grounding, source role, related stories, feedback on
a specific source) wants a joinable row rather than an array scan. The cost is
one insert per upsert and one backfill from the arrays. No schema change during
the freeze; the backfill is a one-off migration script post-freeze.

---

## Emerging Signals audit

- Identity: the label is model prose and deliberately not the identity; the
  evidence story set is (`src/pipeline/signals.ts:4-11`). A new signal id is
  `sig-<sha1 of sorted storyIds>` (`src/pipeline/signals.ts:123-126`); matching
  never uses it.
- Matching: Jaccard over story id sets in `matchSignal`
  (`src/pipeline/signals.ts:61-81`), thresholds `minOverlap = 2` and
  `minJaccard = 0.25` (`:36-37`), with a one-story exact-set exception (`:76`).
- Lifecycle: enum `emerging`, `strengthening`, `confirmed`, `fading`
  (`db/migrations/001_init.sql:351`); transitions in `nextSignalState`
  (`src/pipeline/signals.ts:94-108`): any second day of evidence advances one
  step regardless of whether the evidence is new; `confirmed` is terminal;
  silence of `fadeAfterDays = 3` (`:145,195-213`) moves to `fading`; a return
  after fading restarts at `strengthening`.
- Confidence: base per state (0.3 / 0.5 / 0.75 / 0.35) plus 0.05 per extra story
  capped at 0.2 (`src/pipeline/signals.ts:111-120`). It is a function of state
  and set size only.
- Persistence: `emerging_signals` with `story_ids text[]`, `state`, `confidence`,
  `first_seen_at`, `last_seen_at` (`db/migrations/001_init.sql:353-370`), written
  by `observeSignal` (`src/db/signals.ts:56-79`) from `daily-run.ts` after the
  brief is saved (`src/pipeline/daily-run.ts:576-595`). Candidates are the
  Editor's `emergingSignals` (`:581`), validated only for storyId membership in
  materials (`src/validator/brief-validator.ts:162-169`).
- Policy text asks for at least three unrelated actors, a shared mechanism and a
  falsifier (`agent/skills/daily-intelligence/references/emerging-signals.md:43-50`);
  none of that is enforced in code.

Observed gaps: the same evidence set re-submitted two days running advances to
`confirmed` with no new story (`nextSignalState` ignores set growth); a
single-story signal is allowed; label drift is handled but rationale is
overwritten each day (`src/db/signals.ts:66-70`), so the timeline the skill asks
for is lost.

Future gates (backlog, deterministic, applied in `reconcileSignals`):
- EMERGING requires at least 2 distinct storyIds in materials.
- STRENGTHENING requires a cross-day continuation (matched an existing signal on a
  later date) and at least one storyId not in the previous set.
- CONFIRMED requires stronger evidence, defined as: at least 3 distinct storyIds
  across at least 2 distinct dates, with at least 2 stories that carry a
  non-`NEW` `changeType` on the ledger or belong to different brief sections.
- FADING when no candidate matches for N days (keep N = 3, make it config).
- Keep a per-day evidence history (`signal_observations` rows or a jsonb array)
  instead of overwriting `rationale`, so "third time this week" is computable.

Incremental Intelligence Test (policy, then a code check where possible): if
removing the signal loses no insight that a single one of its stories already
states, do not publish. Code proxy: reject a candidate whose storyIds are all in
one section and all `NEW` on the same day, and require `storyIds.length >= 2`.
The rest stays editorial text in `emerging-signals.md`.

---

## pgvector / embeddings

- Extension and column exist: `create extension if not exists vector`
  (`db/migrations/001_init.sql:7`), `normalized_items.embedding vector(1536)`
  (`:81`) with an HNSW cosine index (`:91`) and a column comment restricting it
  to candidate retrieval (`:93-94`). The compose image is `pgvector/pgvector:pg17`
  (`compose.yaml:8`).
- Production never produces an embedding. The optional field and the `::vector`
  bind exist in `upsertNormalizedItems` (`src/db/items.ts:72-104`), but the only
  caller passes collector items with no embedding
  (`src/pipeline/collection.ts:123-131`), and rg for `embedding` across `src/`
  outside `items.ts` returns nothing. `config/agent.yaml` and `package.json` name
  no embedding model or client. Every column value is null.
- The web reader states it uses full-text search only and no embedding similarity
  (`web/lib/queries.ts:209-211`; `web/app/search/page.tsx:30-31`).

Position: vector retrieval, if ever added, may only do candidate generation for
`search_items` and `find_history` (a wider net for the model to read). It never
auto-merges stories, never decides two items are the same event, never assigns a
`changeType` and never filters editorial importance. Adding an embedding
producer means a new model dependency on the collection path; that is a
post-freeze decision with its own cost and privacy review, not a prerequisite for
any P1 item above.

---

## Post-freeze: Chinese editorial style integration

Added 2026-09-14 from the language audit. Specification: `LANGUAGE_STYLE.md`.
Nothing here is applied to the Editor during the freeze.

### Evidence

The 2026-09-13 production `dailyAnalysis` opens 「今日簡報呈現出前沿技術演進與工程
現實之間的強烈對比。」 — self-reference to the product form (「簡報」) plus a hype
frame (「強烈對比」) in the first sentence, which the dashboard lifts verbatim as
the hero line. That sentence is Editor output, not UI copy; it cannot be fixed
in `web/` and the reader's hero therefore still shows it until the Editor
changes. Story prose from the same run repeats 「此為首次進入追蹤之新事件」 as a
formulaic opener in every `whatChanged` field.

The skill's `references/writing-style.md` already bans 「值得注意的是」,
「總的來說」 and the anchor voice. It does not ban self-reference (本簡報 / 今日
簡報 / 本文), does not ban hype frames unless evidence supports them, and does
not require the opening paragraph to answer whether today was quiet.

### Change (post-freeze, one change set)

1. `agent/skills/daily-intelligence/references/writing-style.md`: add the
   meta-language ban (rule 4 of `LANGUAGE_STYLE.md`), the hype list (rule 5),
   the quiet-day requirement (rule 7) and financing ≠ progress (rule 8). Add
   the four questions the `dailyAnalysis` opening must answer, in order.
2. `src/editor/prompt.ts`: one line pointing at the updated rules; no change
   to selection, section assignment or Must Know policy.
3. A deterministic post-hoc check (not a rejection) over `dailyAnalysis`,
   `whyItMatters`, `whatChanged`, `impact` for the banned phrase list, written
   into the run's manual-review artifact as counts per phrase. Promote to a
   hard gate only after a week shows a near-zero false-positive rate.
4. Gold evaluation re-run unchanged. Acceptance: selection metrics move by
   less than run-to-run noise (see `reports/STABILITY_REPORT.md` for the
   baseline); the phrase counter reads zero on at least three consecutive
   production days.

Why it must wait: rule 7 changes the shape of the opening paragraph, which is
the hero line, and rule 8 changes how funding stories are described. Both are
editorial behaviour and both would confound the observation window.

## Post-freeze: signal state wording versus evidence

The reader now labels every signal 「值得觀察的趨勢」 and shows its evidence
(events, sources, days) next to a 可信度 word. That is presentation. The
underlying state machine still advances `emerging → strengthening` on any
second day of evidence, whether or not the evidence is new (see the Emerging
Signals audit above), so the state word can outrun the evidence.

Post-freeze change, folded into the signal gates item: distinguish

- **WATCHING** — evidence is weak: one day, or fewer than two distinct events,
  or one source cluster. Reader wording stays 「值得觀察」 and the confidence
  word may not exceed 「可信度低」.
- **EMERGING** — cross-event and cross-day evidence exists: two or more
  distinct events across two or more days, from more than one source host.

This is an Intelligence change (it alters when a signal is published as more
than a watch item) and is not made during the freeze.

## Post-freeze: reader prior for AI engineering versus AI industry

The owner's coverage goal, recorded 2026-09-14: **AI 技術濃度高**, and
**Crypto/Web3 不漏重要事件**.

### Evidence

The 2026-09-13 production run's Must Know set was: a labs-slow-down consensus
statement, a GitHub outage, an OpenAI IPO comment, a 50 億美元 financing round.
One of four is engineering-relevant infrastructure; two are industry news that
led on the size of the number or the fame of the company. No inference,
serving, quantization, agent-runtime, MCP, eval or open-weight story was
selected that day, although the collectors returned items in those areas.

### Change (post-freeze, part of P1-1)

The `ReaderProfile` block in P1-1 distinguishes at least three AI strata, as
priors the Curator and Editor see, not quotas:

- **AI Engineering** — model releases, inference, serving, quantization,
  vLLM, SGLang, llama.cpp, MLX, ROCm, CUDA, accelerators, agent runtimes,
  coding agents, MCP, evals, RAG, open-weight models.
- **AI Research** — agents, reasoning, multimodal, benchmarks, architecture,
  safety research with engineering relevance.
- **AI Industry** — funding, IPO, valuation, executive comments, partnerships.

Principle: an AI Industry item does not outrank an AI Engineering item that is
directly relevant to the reader merely because the amount is large or the
company is well known. Industry items reach Must Know when they change
something the reader must act on (pricing, availability, licensing, an
outage), and are otherwise filed under 產業動態 with a takeaway that says what
did not change technically.

Weights are priors, not quotas. No section is guaranteed a slot, and a quiet
day in AI Engineering is reported as quiet.

Acceptance: over the first two post-change weeks, the share of Must Know
stories tagged AI Engineering or AI Research rises without the gold precision
metric falling; funding rounds appear in Must Know only with an action-bearing
takeaway.

## Post-freeze: Crypto / Web3 coverage audit

No source is added and no ranking is changed during the freeze. The freeze
review template (`OBSERVATION_REVIEW.md`) now records, every day, the
technical and the Crypto/Web3 stories the owner expected and did not see, and
traces each through `Raw → Decision → Candidate → Material → Final`. The
post-freeze decision is made from that trace, not from the impression that
「Crypto 太少」:

| Where the story stopped | Conclusion | Owner of the fix |
|---|---|---|
| No raw item at all | source coverage | sources config (post-freeze) |
| Raw item, disposition `IRRELEVANT` | Curator relevance / personalization | P1-1 |
| `CANDIDATE`, no material row | material selection | Curator policy |
| Material row, no brief story | Editor prioritisation | Editor policy |

Only the first row is a source problem. The table is the reason the trace
chain is recorded before any source is added.

## Ordering recommendation

1. **P1-2 first.** It is the smallest change, touches one tool handler and one
   column, needs no new prompt surface, and closes the one failure that already
   happened in production (first appearances recorded as continuations). It also
   produces the `historyEvidence` that P1-3's `whatChanged` evidence wants.
2. **story_items Option A backfill next**, because P1-3 and later source-quality
   work both want the join, and the change is mechanical.
3. **P1-3** after that, as one contract change with fixtures and eval regenerated.
4. **P1-1** once P1-3 has settled the story contract, so `topicIds` and the profile
   block land on a stable schema and their effect can be measured in eval.
5. **P1-4** last; it needs the write-endpoint gating decision and has no reader
   until the owner decides to look at the numbers.
6. Emerging-signal gates (including the WATCHING / EMERGING split above) and any
   embedding producer are backlog after all P1s.
7. Chinese editorial style integration is independent of the P1 order and can
   ship first after the freeze, because it changes wording rather than
   selection and is verified by the unchanged gold run.
