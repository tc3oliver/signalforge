# Observation review

The daily manual review during an observation freeze (currently 2026-09-13 to
2026-09-18), and the queries that back it. One copy of the template per day,
filled in by the owner, kept under `observations/` (git-ignored) and summarised
in the post-freeze report.

The point of the freeze is to learn where stories are lost, not to fix
anything while measuring. Nothing in this file changes the pipeline.

## Daily template

```
Date:
Run id:
Health:

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

Crypto/Web3 story I expected but did not see:
-
  Trace (Raw → Decision → Candidate → Material → Final):

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

Every stage writes a row, so a missed story can be located exactly. Run these
against the production lineage (`default`) with the day's date; replace the
`ILIKE` pattern with a distinctive word from the expected story's title.

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

## What the review must not do

- Do not edit gold, thresholds, prompts, the interest profile or sources
  during the window, whatever the trace shows. Write it down.
- Do not conclude "Crypto 太少 → add sources" without the trace. A raw item
  that the curator marked `IRRELEVANT` is a personalization finding, and
  adding sources would make it worse, not better.
- Do not let the language findings (meta-phrases, hype) leak into the
  selection review; they are tracked separately in `LANGUAGE_STYLE.md` and the
  backlog's style-integration item.

## After the window

The five daily sheets feed `reports/QUALITY_REVIEW.md` and the production
evidence section of the README. The counts that matter: expected technical
stories missed per stage, expected Crypto/Web3 stories missed per stage, Must
Know entries the owner would remove, and days on which the opening paragraph
answered all four questions.
