# Observation review

The daily manual review during an observation window, and the tooling that backs
it. One copy of the template per day, filled in by the owner, kept under
`observations/` (git-ignored) and summarised in the post-window report.

The point of the window is to learn where stories are lost, not to fix anything
while measuring. Nothing in this file changes the pipeline.

Run `pnpm observe` alongside filling in the sheet. It reads and prints; it
writes no row and contacts no network, which is what makes it safe to run inside
a window.

## Epochs: which days are the same experiment

A window is only a baseline if the thing being observed did not change during it.

**The 2026-09-13 → 2026-09-18 window did not produce one.** It was broken on
2026-09-15 by shipping personalization: the reader's interest profile now reaches
the Curator and the Editor as priors, which moves relevance, ordering and what
reaches Must Know — the exact quantities the window was measuring. That is a
deliberate break, not an accident, and the days are not thrown away; they are
reclassified.

The boundary is recorded in the data, not in this document.
`daily_briefs.profile_version` is the hash of the profile that shaped a brief:
null before personalization, and a distinct hash for every profile afterwards.
`pnpm observe` derives the epochs from that column, so editing a weight opens a
new epoch automatically and no date here has to be kept up to date.

| | Epoch A | Epoch B |
|---|---|---|
| id | `pre-personalization` | `profile-<hash>` |
| `profile_version` | null | the hash `pnpm observe` prints |
| Purpose | **historical reference only** | the clean observation baseline |
| Dates | whatever `pnpm observe` reports | from the first run that stamps a version |
| Required before conclusions | — | 5 consecutive complete daily runs |

Read Epoch A for what the pipeline did before it knew who it was writing for.
Do not read it as evidence about the system running today.

### 2026-09-16 is a transition day, not Epoch B Day 1

It carries a `profile_version` and it published, so `pnpm observe` will group it
with Epoch B. **Do not count it as a clean day.** What happened to it:

- its scheduled 05:30 run never produced a brief — the host had suspended the
  container VM overnight, and the day's items accumulated into a 1626-item
  backlog;
- the catch-up run failed (`CURATION_FAILED`, 1050 of 1626 decided) because the
  curator still tried to scan a day inside one model turn;
- it published only after three execution fixes landed **during** the day, and
  after four runs, two of which were stopped by hand mid-flight.

So the runtime changed underneath it, the workload was three times a normal
day's, and a human intervened repeatedly. Every one of those disqualifies it as
a baseline day even though the brief itself is sound.

**Epoch B Day 1 is the first daily run that is all of:**

| | |
|---|---|
| unattended | fired by the LaunchAgent, no hand-started run |
| fixed runtime | no execution change shipped that day |
| personalized | `profile_version` present |
| uninterrupted | no recovery, no `--resume`, no `--resume-from` |
| published | reaches `PUBLISHED` |

Count the five consecutive clean days from there, not from 09-16. Record
2026-09-16 in the daily sheet as `TRANSITION` with a one-line reason, so the
gap in the run of dates is explained rather than looking like a missing day.

**The tool will not merge them.** Asking for a range that spans a profile change
prints an explicit refusal instead of an average, because a five-day figure that
silently blends two systems does not look like an error — it looks like evidence.
If a weight is edited mid-window, the epoch closes and the five-day count starts
again. That is the cost of tuning during a window, and it is the reason not to.

## Daily template

Fill the "expected but did not see" fields in *before* running `pnpm observe`,
so the tool's answer does not become the memory.

```
Date:
Run id:
Health:
Epoch (from `pnpm observe`):
Profile version:
Day type (CLEAN / TRANSITION — and why, if not clean):

Must Know as published (title · section · change type):
1.
2.
3.

Opening paragraph — does it answer, in order:
  [ ] was there a genuinely major event today
  [ ] the most important technical change
  [ ] which items are industry news rather than technical progress
  [ ] if quiet, does it say so
Meta-language present (本簡報 / 今日簡報 / 綜合 / 值得注意的是 / 整體而言 …):

Technical story I expected but did not see:
-
  Trace (Raw → Decision → Candidate → Material → Final):

AI Engineering story I expected but did not see:
  (model release, inference, serving, agent runtime, coding agent, MCP, ROCm,
   MLX, vLLM, SGLang, quantization, GPU infra, open-weight model)
- title:
  source/url if known:
  Attribution (`pnpm observe --date <date> --missing "<word from title>"`):

AI Business story that felt over-prioritized:
  (funding, IPO, valuation, executive commentary, corporate news)
- title:
  why it should have ranked lower:

Crypto/Web3 story I expected but did not see:
- title:
  source/url if known:
  Attribution (`pnpm observe --date <date> --missing "<word from title>"`):

Story that should not have been Must Know, and why:
-

Change type that looks wrong (a continuation marked NEW, or the reverse):
-

Signal that reads as more settled than its evidence:
-
```

The two "expected but did not see" fields are the owner's recall of the day's
actual events in their own feeds, not something the pipeline can supply. Fill
them in before reading the trace so the trace does not anchor the answer.

## Tracing a missed story

Write down what you expected first. Then:

```bash
pnpm observe --date 2026-09-16 --missing "liquid network"
```

It walks the five stages **forwards** and reports the first one with no row.
Forwards matters: checking down from the brief reports "the Editor dropped it"
for a story that was never collected, because absence is true at every stage of
a total miss. The verdict is one of:

| Verdict | Means | The fix is *not* |
|---|---|---|
| `SOURCE_MISS` | No raw or normalized item matched. The data plane never saw it. | weights, prompts, ranking |
| `CURATOR_MISS` | Collected and scanned, but no story was promoted. | adding sources — that makes it worse |
| `MATERIAL_MISS` | A story existed; the Curator did not hand it to the Editor. | the Editor |
| `EDITOR_MISS` | It was in the materials and was not published. | the Curator, or coverage |
| `UNKNOWN` | Not enough evidence. Record the exact title or URL and re-run. | acting on it at all |
| `PUBLISHED` | It did reach the brief. Expectation and output agree. | — |

The distinction that matters most is `SOURCE_MISS` versus `CURATOR_MISS`, because
they need opposite actions. The first crypto trace run against 2026-09-15
returned `CURATOR_MISS`: 25 items matched across CoinDesk, Decrypt, The Block,
Unchained, PANews and The Defiant, and every decision was `IRRELEVANT` or
`DUPLICATE`. Adding a crypto source would have added items to the same
judgement. Record it; do not act on it during a window.

The tool searches titles and URLs. It performs no web search: the question is
what this pipeline did with what it had.

### The same thing by hand

Useful when the pattern needs tuning or a stage needs fields the tool does not
print. Run against the production lineage (`default`) with the day's date;
replace the `ILIKE` pattern with a distinctive word from the expected story's
title.

```sql
-- 1. Raw: was it collected at all?
select item_id, source_name, title, published_at
from normalized_items
where lineage = 'default' and title ilike '%PATTERN%'
order by published_at desc;

-- 2. Decision: what did the curator do with it?
select d.item_id, d.disposition, d.story_id, d.reason
from item_decisions d
where d.lineage = 'default' and d.date = 'YYYY-MM-DD'
  and d.item_id in (select item_id from normalized_items
                    where lineage = 'default' and title ilike '%PATTERN%');

-- 3. Candidate: did it get a ledger row that day?
select story_id, canonical_title, change_type, relevance, novelty, importance, reason
from story_ledger
where lineage = 'default' and date = 'YYYY-MM-DD'
  and canonical_title ilike '%PATTERN%';

-- 4. Material: did the curator hand it to the editor?
select story_id, tier, canonical_title, why_selected
from daily_material_stories
where lineage = 'default' and date = 'YYYY-MM-DD'
  and canonical_title ilike '%PATTERN%';

-- 5. Final: did the editor publish it?
select story_id, section, must_know, title
from daily_brief_stories
where lineage = 'default' and date = 'YYYY-MM-DD'
  and title ilike '%PATTERN%';
```

Record the last stage that returned a row. The stage where the story stopped
is the diagnosis:

| Stopped at | Reads as | Not this |
|---|---|---|
| No raw item | source coverage gap | a ranking problem |
| Raw item, decision `IRRELEVANT` | Curator relevance / personalization | a source problem |
| `CANDIDATE` decision, no material row | material selection | Editor |
| Material row, no brief story | Editor prioritisation | Curator |
| Brief story, not Must Know | Must Know policy | coverage |

The `/admin/item/[id]` page (with `SIGNALFORGE_ADMIN=1`) shows the same chain
for one item id when that is quicker than the SQL.

## What `pnpm observe` reports

**Topic funnel.** Per topic: configured weight, then candidate → material →
final → must-know story counts. A story counts towards every topic it carries,
so rows do not sum to the total. The funnel starts at *candidate*, because
`story_ledger.topic_ids` is the only topic attribution that exists — a raw item
is not attributed to a topic anywhere, so "how many Crypto items were collected"
is reported as unavailable rather than estimated. Stories carrying no topic are
counted separately rather than dropped.

**AI Engineering vs AI Business.** Groups published stories using
`config/observation-audit.yaml`, which maps topic ids onto `AI_ENGINEERING`,
`AI_RESEARCH`, `AI_BUSINESS` and `NON_AI`. That file is read by this report and
by nothing else — no collector, no Curator tool, no Editor prompt, no ranking
rule — so the measurement cannot steer what it measures.

Two honest limits, both of which show up as `UNCLASSIFIED` rather than a guess:
a story whose topics span two groups is not assigned to whichever matched first,
and the shipped interest profile has **no topic for funding, IPOs, valuations or
executive commentary**, so those stories arrive carrying either no topic or only
a broad one. That is why `AI_BUSINESS` is empty in the shipped config and why the
ratio is not yet fully derivable from data. When `UNCLASSIFIED` is above 30% the
report says so and points here. Until a topic names business news, the two manual
fields in the daily template are the measurement, not the table.

**Historical intelligence.** Change-type counts per day and the **non-NEW
continuity rate** — the share of stories that are something other than `NEW`.
A pipeline marking everything `NEW` every day would pass every other check while
being a feed reader with extra steps, and each day's brief would still read fine
on its own. If five consecutive days sit at or below 10%, the report says a
deterministic history invariant is the next thing to build. It enforces nothing;
P1-2 is designed against this measurement, not against an intuition.

**Emerging signals.** State, confidence, day span, and evidence counted as
stories *and* distinct sources — "three stories from one feed" and "three
stories from three feeds" are different amounts of confidence and the stored
`confidence` does not distinguish them. Recorded only: whether `WATCHING` needs
splitting out of `EMERGING` is deferred until five days of this exist.

**Screening.** One section per screener version (`provider/model @
policyVersion`): the DROP / KEEP / UNSURE distribution; DROP precision against
the Curator's own decision (a DROP the Curator also set aside, as IRRELEVANT or
DUPLICATE, is agreement; a DROP the Curator made CANDIDATE is a false
negative); story-level material / final / Must Know recall a full DROP filter
would have achieved, with the lost story ids named; audit-sampled DROPs and
their leakage; rescued DROPs; a per-day table; and a verdict — READY TO ROUTE,
KEEP SHADOWING or NOT WORTH ROUTING — against `SCREENING_GATE`: at least 3000
evaluated items over at least 3 distinct days, Must Know recall 100%, final
recall ≥ 98%, material recall ≥ 95%, DROP precision ≥ 95%, and a DROP rate
≥ 30% (perfect recall on a 2% DROP rate is safe and pointless, and the verdict
says so). Item-level precision is an early-warning bar rather than the safety
bar: on the 2026-09-16..18 backtest most DROP-but-CANDIDATE items belonged to
stories that survived through their other items. The verdict is
advisory; a human edits `config/agent.yaml`.

`pnpm screen --date <day>[,<day>...]` backtests past days whose Curator
decisions and brief outcomes already exist. It screens exactly the items the
Curator decided, writes rows with no run id, and prints the same section.
A backfilled row can never withhold anything: `routed` is always false.

**Model usage by stage.** Per stage: attempts, wall clock, and provider-reported
input / output / cache-read / total tokens, plus tokens per screened item and
per Curator item. Usage comes from the provider's own statement (the Pi
assistant message for the Curator and Editor, the chat-completions response
for the screener) and is never estimated; a stage whose provider reported
nothing is printed as unavailable, not as zero.

## What the review must not do

- Do not edit gold, thresholds, prompts, the interest profile or sources
  during the window, whatever the trace shows. Write it down.
- Do not conclude "Crypto 太少 → add sources" without the trace. A raw item
  that the curator marked `IRRELEVANT` is a personalization finding, and
  adding sources would make it worse, not better.
- Do not let the language findings (meta-phrases, hype) leak into the
  selection review; they are tracked separately in `LANGUAGE_STYLE.md` and the
  backlog's style-integration item.
- Do not edit an interest weight to correct a ratio the audit reports. It closes
  the epoch, restarts the five-day count, and discards the evidence that would
  have told you whether the edit was the right one.
- Do not compare a day in Epoch A against a day in Epoch B and call the
  difference an effect. Everything else about that week changed too — the arXiv
  source moved to the announcement feeds and was narrowed to two categories on
  the same day personalization shipped.

## After the window

The five daily sheets feed `reports/QUALITY_REVIEW.md` and the production
evidence section of the README, **within one epoch**. A report covering days
from two epochs is not a five-day review; it is two shorter ones.

The counts that matter: expected technical stories missed per stage, expected
Crypto/Web3 stories missed per stage, AI Engineering stories missed against AI
Business stories over-prioritized, Must Know entries the owner would remove, the
non-NEW continuity rate, and days on which the opening paragraph answered all
four questions.

Three questions this is meant to answer, and what would count as an answer:

| Question | Answered by | Answer looks like |
|---|---|---|
| AI Engineering vs AI Business ratio | the audit table, plus the two manual fields while `UNCLASSIFIED` stays high | a split with a defensible denominator, not a percentage of unclassified stories |
| Why Crypto/Web3 is thin | `--missing` attribution across five days | a stage, repeated: mostly `SOURCE_MISS` is a sources problem, mostly `CURATOR_MISS` is a profile problem |
| Whether Historical Intelligence works | the non-NEW continuity rate across five days | a rate that is not near zero, on days that had enough stories to mean something |
