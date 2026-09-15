-- story_items had no production writer until now: only the dev seeder ever
-- inserted there, so the web story page's PRIMARY/SUPPORTING display has been
-- empty on every real story since the table was created. `upsertStoryRow` now
-- writes it alongside the ledger, but only from this point forward -- every
-- story already in the ledger would stay roleless until it happened to be
-- re-curated, which for a closed day never happens.
--
-- The facts are not lost, only denormalised: story_ledger.source_item_ids and
-- primary_source_ids carry exactly what the relation needs, so this rebuilds
-- the rows from the arrays with the same rule the writer uses -- item set is
-- the union of both arrays, PRIMARY when the id appears in primary_source_ids.
--
-- Its own file rather than an edit to 001: that migration has been applied
-- here, and the checksum ledger is what stops an applied file from being
-- changed underneath another environment.
--
-- `on conflict do nothing` rather than an update, because by the time this runs
-- some rows may already have been written by the new code path. Those came from
-- a live curation pass and are more current than anything the arrays can say:
-- the arrays union across a day's passes and never drop a demoted or removed
-- item, so reconstructing over a fresh row would resurrect exactly the staleness
-- the writer exists to prune.

insert into story_items (lineage, story_id, date, item_id, role)
select distinct
	s.lineage,
	s.story_id,
	s.date,
	t.item_id,
	case when t.item_id = any(s.primary_source_ids) then 'PRIMARY' else 'SUPPORTING' end
from story_ledger s
cross join lateral unnest(s.source_item_ids || s.primary_source_ids) as t(item_id)
on conflict (lineage, story_id, date, item_id) do nothing;
