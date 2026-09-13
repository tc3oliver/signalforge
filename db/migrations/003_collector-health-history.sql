-- Keep the real failure history of a collector instead of overwriting it.
--
-- source_configs carried only last_health / last_run_at / consecutive_failures,
-- and consecutive_failures was reset by any run that was not FAILED. A
-- collector that reports DEGRADED forever -- or one that reports OK while
-- fetching nothing -- therefore stayed green and never escalated, and once the
-- counter was reset there was nothing left to show when it had last actually
-- worked.
--
-- Additive only: new nullable columns, no backfill, no change to existing rows.
-- A NULL last_success_at means "never observed a success since this migration",
-- which is exactly the truth -- the old schema did not record it.

alter table source_configs add column if not exists last_success_at timestamptz;
alter table source_configs add column if not exists last_failure_at timestamptz;
alter table source_configs add column if not exists last_error      text;

comment on column source_configs.last_success_at is
	'Finish time of the most recent genuinely successful run (health OK). A quiet source that legitimately returned 0 items still counts as a success.';
comment on column source_configs.last_failure_at is
	'Finish time of the most recent run that did not succeed (FAILED or DEGRADED). DEGRADED counts: a permanently degraded collector must still escalate.';
comment on column source_configs.last_error is
	'Error text of the most recent unsuccessful run, retained until the collector succeeds again, so the reason is still visible after later runs.';
