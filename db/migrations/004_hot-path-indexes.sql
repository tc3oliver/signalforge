-- Two indexes for scans the pipeline does on every run and had to do
-- sequentially.
--
-- raw_items (collection_run_id): a collection run writes its raw rows with the
-- run id and the trace reads them back by it, but the column carried no index
-- at all, so every provenance lookup and every per-run count scanned the whole
-- append-only table.
--
-- structured_facts (lineage, as_of desc): the manifest selects a day's facts by
-- lineage and an as_of range with no kind. The existing
-- structured_facts_kind_idx leads with (lineage, kind), so a query that does
-- not constrain kind cannot use it and the day window is a sequential scan of
-- every fact ever collected.
--
-- Additive only: indexes, no data change.

create index if not exists raw_items_collection_run_idx
	on raw_items (collection_run_id);

create index if not exists structured_facts_as_of_idx
	on structured_facts (lineage, as_of desc);
