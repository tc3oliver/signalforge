-- A recovery run points at the run it is recovering, instead of overwriting it.
--
-- Run 00d11db2 for 2026-09-16 ended CURATION_FAILED with 1050 of 1626 items
-- decided, after six turns that were each making progress were each classified
-- as a provider timeout. That failure is evidence: it is the record of what the
-- old execution model did, and it is the thing the bounded-worker change was
-- built against.
--
-- `LEGAL_TRANSITIONS` does allow CURATION_FAILED -> CURATING, so the same run
-- id could simply be re-run to PUBLISHED. That would be the easy path and it
-- would quietly delete the evidence: nothing afterwards could show that the day
-- had failed, or how far it got before it did. The durable work is keyed by
-- (lineage, date) rather than by run id -- item_decisions, story_ledger,
-- story_items and the topic attributions are all reusable by a different run --
-- so a recovery run can pick up exactly where the failed one stopped without
-- redoing or destroying anything.
--
-- Nullable, because almost every run is not a recovery. Self-referencing
-- foreign key deliberately omitted: the run it names may be pruned by retention
-- long before this one is, and losing the recovery row because its history
-- expired would be the wrong way round.

alter table daily_runs
	add column if not exists resumed_from_run_id text;

create index if not exists daily_runs_resumed_from_idx
	on daily_runs (resumed_from_run_id)
	where resumed_from_run_id is not null;

comment on column daily_runs.resumed_from_run_id is
	'Set when this run continues a previous run''s durable state for the same (lineage, date) instead of starting the day over. The named run keeps its own final status -- a recovery never rewrites the history of what it recovered.';
