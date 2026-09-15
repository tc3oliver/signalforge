-- collection_runs (run_id): the reader resolves a day's collectors by the run
-- ids of that date, which replaced a 400-row global recency window that
-- silently undercounted any day but the newest. The table is small -- one row
-- per collector per run -- but the lookup still had nothing to seek on, so the
-- rewrite swapped a wrong answer for a sequential scan.
--
-- Its own file rather than an edit to 004: that migration has already been
-- applied here, and the checksum ledger is what stops an applied file from
-- being changed underneath another environment.
--
-- Additive only: one index, no data change.

create index if not exists collection_runs_run_idx
	on collection_runs (run_id);
