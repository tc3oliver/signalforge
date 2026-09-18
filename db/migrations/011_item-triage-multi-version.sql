-- Let two triage passes hold predictions for the same item on the same day.
--
-- 009 keyed this table (lineage, date, item_id) to match item_decisions exactly,
-- so the recall query stays a plain join. That is still the right join key, but
-- it made the table hold exactly one opinion per item -- and the whole point of
-- the shadow period is to compare opinions.
--
-- The comment in src/triage/rules.ts states the condition for spending a model
-- on this: "If UNCERTAIN turns out to dominate and the misses concentrate there,
-- that is the evidence for spending a model on UNCERTAIN only". On 2026-09-18
-- UNCERTAIN was 471 of 1311 (35.9%), the largest bucket, so a model pass now
-- runs beside the rules. Under the old key it would have silently overwritten
-- them on conflict and destroyed the very baseline it must be judged against.
--
-- rules_version joins the key rather than replacing anything: one row per
-- (item, pass), every pass keeping its own history, and a recall query naming
-- which pass it is measuring. A query that forgets to name one now counts an
-- item once per pass, which is visible and wrong, rather than silently reporting
-- whichever pass happened to write last.

alter table item_triage drop constraint item_triage_pkey;
alter table item_triage add primary key (lineage, date, item_id, rules_version);

-- The recall queries filter by pass, so the category index has to as well.
drop index if exists item_triage_category_idx;
create index if not exists item_triage_category_idx
	on item_triage (lineage, date, rules_version, category);

comment on table item_triage is
	'Shadow-mode Stage 0 triage predictions, one row per item per pass (rules_version). Written by the pipeline, read only by the observation report. No production read path: every item reaches the Curator regardless of what is recorded here.';
