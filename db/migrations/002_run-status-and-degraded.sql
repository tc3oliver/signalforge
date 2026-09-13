-- Widen daily_runs.status to the full production state machine and pull the
-- DEGRADED marker out into its own column.
--
-- DEGRADED is orthogonal to status (a run can be degraded and still reach
-- PUBLISHED), so it does not belong in the status enum: a degraded_reason
-- column that is NULL when healthy lets /admin/runs say *why* a run is
-- degraded, not just that it is.
--
-- The prior constraint was lossy (missing COLLECTING, COLLECTED, PUBLISHED,
-- COLLECTION_FAILED), which forced daily-run.ts to remap the real state onto
-- an allowed value before persisting it. This migration is the fix, so that
-- caller-side mapping can be deleted.

alter table daily_runs drop constraint daily_runs_status_check;

alter table daily_runs add constraint daily_runs_status_check check (status in (
	'CREATED','COLLECTING','COLLECTED','CURATING','MATERIALS_READY','WRITING',
	'DRAFT_READY','VALIDATING','PUBLISHED','COMPLETED',
	'COLLECTION_FAILED','CURATION_FAILED','EDITOR_FAILED','VALIDATION_FAILED'
));

alter table daily_runs add column if not exists degraded_reason text;
comment on column daily_runs.degraded_reason is
	'NULL when the run is healthy. Non-null marks the run DEGRADED and records why (e.g. "Reddit unavailable"); orthogonal to status, since a degraded run can still reach PUBLISHED.';
