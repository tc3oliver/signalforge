-- Stage 0 triage predictions, recorded in shadow mode.
--
-- The point of this table is to be compared against, never to be read by the
-- pipeline. Every item still goes to the Curator; this records what a cheap
-- deterministic pass *would* have said, so the question "how much would we lose
-- by filtering on it?" can be answered from data instead of argued about.
--
-- The comparison that matters runs against item_decisions.disposition and, one
-- stage further, against daily_brief_stories.must_know: an item this table calls
-- LOW that the Editor put in Must Know is the failure mode that would make
-- filtering unacceptable, and it has to be countable.
--
-- Keyed by (lineage, date, item_id) to match item_decisions exactly, so the
-- recall queries are a plain join rather than a fuzzy alignment.
--
-- No foreign key to normalized_items: an item can be re-normalized or a
-- manifest rebuilt, and a shadow prediction that blocked either would be a
-- measurement changing the thing it measures.

create table if not exists item_triage (
	lineage        text        not null,
	date           text        not null,
	item_id        text        not null,
	category       text        not null check (category in ('PRIORITY','NORMAL','LOW','DUPLICATE_HINT','UNCERTAIN')),
	-- Which rule fired. Stable across wording changes, so a shift in the mix is
	-- attributable to a specific rule rather than to "the rules changed".
	rule_id        text        not null,
	reason         text        not null,
	-- Advisory prior, never a relevance score; nothing downstream reads it.
	relevance_hint double precision not null,
	topic_ids      text[]      not null default '{}',
	-- The rules version that produced this row. Without it, a day triaged before
	-- a rule change and a day after would be averaged into one recall figure --
	-- the same silent merge the observation epochs exist to refuse.
	rules_version  text        not null,
	created_at     timestamptz not null default now(),
	primary key (lineage, date, item_id)
);

create index if not exists item_triage_category_idx on item_triage (lineage, date, category);

comment on table item_triage is
	'Shadow-mode Stage 0 triage predictions. Written by the pipeline, read only by the observation report. No production read path: every item reaches the Curator regardless of what is recorded here.';
