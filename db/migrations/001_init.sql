-- Forward-only initial schema for the daily-intelligence data layer.
--
-- `lineage` appears on every row that belongs to an editorial timeline. It is
-- what lets a synthetic/eval lineage share a database with production without
-- ever colliding on a story slug or a date key.

create extension if not exists vector;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------

create table daily_runs (
	run_id           text primary key,
	lineage          text        not null default 'default',
	date             text        not null,
	status           text        not null check (status in (
		'CREATED','CURATING','MATERIALS_READY','WRITING','DRAFT_READY',
		'VALIDATING','COMPLETED','CURATION_FAILED','EDITOR_FAILED','VALIDATION_FAILED'
	)),
	total_items      integer     not null default 0,
	processed_items  integer     not null default 0,
	story_count      integer     not null default 0,
	failure_reason   text,
	created_at       timestamptz not null default now(),
	updated_at       timestamptz not null default now()
);
create index daily_runs_lineage_date_idx on daily_runs (lineage, date desc);

create table collection_runs (
	collection_run_id text primary key,
	run_id            text references daily_runs (run_id) on delete set null,
	collector_id      text        not null,
	health            text        not null check (health in ('OK','DEGRADED','DISABLED','FAILED')),
	items_fetched     integer     not null default 0,
	cursor            text,
	warnings          text[]      not null default '{}',
	error             text,
	started_at        timestamptz not null,
	finished_at       timestamptz not null,
	latency_ms        integer     not null,
	created_at        timestamptz not null default now()
);
create index collection_runs_collector_idx on collection_runs (collector_id, started_at desc);

-- ---------------------------------------------------------------------------
-- Items
-- ---------------------------------------------------------------------------

-- Append-only. The provider payload is stored verbatim so a normalization bug
-- can be re-run from the original bytes instead of re-fetching.
create table raw_items (
	raw_item_id       bigserial primary key,
	collection_run_id text references collection_runs (collection_run_id) on delete set null,
	source_type       text        not null,
	source_name       text        not null,
	external_id       text        not null,
	body              jsonb       not null,
	fetched_at        timestamptz not null,
	created_at        timestamptz not null default now(),
	-- Re-collecting the same provider record must not duplicate it.
	constraint raw_items_source_external_key unique (source_type, external_id)
);
create index raw_items_fetched_at_idx on raw_items (fetched_at desc);
create index raw_items_body_idx on raw_items using gin (body jsonb_path_ops);

create table normalized_items (
	lineage       text        not null default 'default',
	item_id       text        not null,
	raw_item_id   bigint      references raw_items (raw_item_id) on delete set null,
	source_type   text        not null,
	source_name   text        not null,
	title         text        not null,
	summary       text        not null default '',
	content       text,
	url           text,
	author        text,
	published_at  timestamptz not null,
	metadata      jsonb       not null default '{}'::jsonb,
	embedding     vector(1536),
	search        tsvector generated always as (
		to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(content,''))
	) stored,
	created_at    timestamptz not null default now(),
	updated_at    timestamptz not null default now(),
	primary key (lineage, item_id)
);
create index normalized_items_search_idx on normalized_items using gin (search);
create index normalized_items_published_idx on normalized_items (lineage, published_at desc);
create index normalized_items_embedding_idx on normalized_items using hnsw (embedding vector_cosine_ops);

comment on column normalized_items.embedding is
	'Candidate retrieval only. Cosine distance narrows what the curator agent (Pi) looks at; it never decides that two items are the same event. That judgement is always the agent''s.';

-- ---------------------------------------------------------------------------
-- Story ledger
-- ---------------------------------------------------------------------------

-- One row per (lineage, story_id, date), mirroring the per-date JSON ledger
-- file. `ordinal` preserves the order entries were first written on a date so
-- listing matches the file-backed implementation exactly.
create table story_ledger (
	lineage            text        not null default 'default',
	story_id           text        not null,
	date               text        not null,
	ordinal            bigserial   not null,
	canonical_title    text        not null,
	source_item_ids    text[]      not null default '{}',
	primary_source_ids text[]      not null default '{}',
	fact_refs          text[]      not null default '{}',
	first_seen_at      timestamptz not null,
	last_seen_at       timestamptz not null,
	status             text        not null check (status in ('OPEN','RESOLVED','DORMANT')),
	change_type        text        not null check (change_type in (
		'NEW','UPDATE','ESCALATION','RESOLUTION','REVERSAL','CONFIRMATION','RUMOR','NO_MATERIAL_CHANGE'
	)),
	relevance          double precision not null check (relevance between 0 and 1),
	novelty            double precision not null check (novelty between 0 and 1),
	importance         double precision not null check (importance between 0 and 1),
	confidence         double precision not null check (confidence between 0 and 1),
	reason             text        not null,
	created_at         timestamptz not null default now(),
	updated_at         timestamptz not null default now(),
	primary key (lineage, story_id, date)
);
create index story_ledger_date_idx on story_ledger (lineage, date desc, ordinal);
create index story_ledger_title_trgm_idx on story_ledger using gin (canonical_title gin_trgm_ops);

create table story_items (
	lineage  text not null default 'default',
	story_id text not null,
	date     text not null,
	item_id  text not null,
	role     text not null default 'SUPPORTING' check (role in ('PRIMARY','SUPPORTING')),
	created_at timestamptz not null default now(),
	primary key (lineage, story_id, date, item_id),
	foreign key (lineage, story_id, date) references story_ledger (lineage, story_id, date) on delete cascade
);
create index story_items_item_idx on story_items (lineage, item_id);

-- Answers "why did this item not reach the brief". Every scanned item gets a
-- row, which is what makes scan coverage auditable rather than self-reported.
create table item_decisions (
	lineage     text        not null default 'default',
	date        text        not null,
	item_id     text        not null,
	ordinal     bigserial   not null,
	run_id      text        references daily_runs (run_id) on delete set null,
	disposition text        not null check (disposition in ('IRRELEVANT','DUPLICATE','CANDIDATE')),
	story_id    text,
	reason      text        not null,
	decided_at  timestamptz not null,
	created_at  timestamptz not null default now(),
	updated_at  timestamptz not null default now(),
	primary key (lineage, date, item_id)
);
create index item_decisions_disposition_idx on item_decisions (lineage, date, disposition);
create index item_decisions_item_idx on item_decisions (lineage, item_id);

-- ---------------------------------------------------------------------------
-- Materials and briefs
-- ---------------------------------------------------------------------------

create table daily_materials (
	lineage       text        not null default 'default',
	date          text        not null,
	run_id        text        references daily_runs (run_id) on delete set null,
	produced_at   timestamptz not null,
	curator_notes text        not null default '',
	-- The curator's own signal candidates for this date, kept verbatim. The
	-- cross-day signal lifecycle lives in emerging_signals.
	emerging_signals jsonb    not null default '[]'::jsonb,
	created_at    timestamptz not null default now(),
	updated_at    timestamptz not null default now(),
	primary key (lineage, date)
);

create table daily_material_stories (
	lineage            text   not null default 'default',
	date               text   not null,
	story_id           text   not null,
	ordinal            integer not null,
	tier               text   not null check (tier in ('A','B','C')),
	canonical_title    text   not null,
	why_selected       text   not null,
	change_type        text   not null,
	importance         double precision not null check (importance between 0 and 1),
	novelty            double precision not null check (novelty between 0 and 1),
	confidence         double precision not null check (confidence between 0 and 1),
	source_item_ids    text[] not null default '{}',
	primary_source_ids text[] not null default '{}',
	fact_refs          text[] not null default '{}',
	created_at         timestamptz not null default now(),
	primary key (lineage, date, story_id),
	foreign key (lineage, date) references daily_materials (lineage, date) on delete cascade
);
create index daily_material_stories_tier_idx on daily_material_stories (lineage, date, tier, ordinal);

-- Every editor attempt is kept, not just the accepted one, so a validation
-- failure can be diffed against the draft that replaced it.
create table daily_brief_drafts (
	lineage           text        not null default 'default',
	date              text        not null,
	draft_no          integer     not null,
	run_id            text        references daily_runs (run_id) on delete set null,
	body              jsonb       not null,
	produced_at       timestamptz not null,
	validation_status text        not null default 'PENDING'
		check (validation_status in ('PENDING','PASSED','FAILED')),
	validation_errors jsonb       not null default '[]'::jsonb,
	created_at        timestamptz not null default now(),
	primary key (lineage, date, draft_no)
);

create table daily_briefs (
	lineage          text        not null default 'default',
	date             text        not null,
	run_id           text        references daily_runs (run_id) on delete set null,
	produced_at      timestamptz not null,
	daily_analysis   text        not null,
	watch_next       text[]      not null default '{}',
	emerging_signals jsonb       not null default '[]'::jsonb,
	created_at       timestamptz not null default now(),
	updated_at       timestamptz not null default now(),
	primary key (lineage, date)
);

create table daily_brief_stories (
	lineage         text    not null default 'default',
	date            text    not null,
	story_id        text    not null,
	ordinal         integer not null,
	section         text    not null check (section in (
		'MUST_KNOW','AI_LLM','DEVELOPER_OSS','RESEARCH','CRYPTO_MARKET','MACRO','COMPANIES'
	)),
	must_know       boolean not null default false,
	title           text    not null,
	what_happened   text    not null,
	why_it_matters  text    not null,
	what_changed    text    not null,
	impact          text    not null,
	confidence      text    not null check (confidence in ('HIGH','MEDIUM','LOW')),
	source_item_ids text[]  not null default '{}',
	fact_refs       text[]  not null default '{}',
	search          tsvector generated always as (
		to_tsvector('simple',
			coalesce(title,'') || ' ' || coalesce(what_happened,'') || ' ' ||
			coalesce(why_it_matters,'') || ' ' || coalesce(what_changed,'') || ' ' || coalesce(impact,''))
	) stored,
	created_at      timestamptz not null default now(),
	primary key (lineage, date, story_id),
	foreign key (lineage, date) references daily_briefs (lineage, date) on delete cascade
);
create index daily_brief_stories_search_idx on daily_brief_stories using gin (search);
create index daily_brief_stories_section_idx on daily_brief_stories (lineage, date, section, ordinal);

-- ---------------------------------------------------------------------------
-- Facts, configuration, signals
-- ---------------------------------------------------------------------------

create table structured_facts (
	lineage        text        not null default 'default',
	fact_id        text        not null,
	kind           text        not null check (kind in ('crypto','macro','filing')),
	label          text        not null,
	value          double precision not null,
	unit           text        not null,
	as_of          timestamptz not null,
	source_item_id text        not null,
	previous_value double precision,
	change_pct     double precision,
	created_at     timestamptz not null default now(),
	updated_at     timestamptz not null default now(),
	primary key (lineage, fact_id)
);
create index structured_facts_kind_idx on structured_facts (lineage, kind, as_of desc);

create table interest_profiles (
	profile_id text        not null,
	version    integer     not null,
	label      text        not null,
	weights    jsonb       not null default '{}'::jsonb,
	active     boolean     not null default false,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	primary key (profile_id, version)
);
create unique index interest_profiles_one_active_idx on interest_profiles (profile_id) where active;

create table watchlists (
	watchlist_id text        not null primary key,
	label        text        not null,
	terms        text[]      not null default '{}',
	active       boolean     not null default true,
	created_at   timestamptz not null default now(),
	updated_at   timestamptz not null default now()
);

create table source_configs (
	collector_id         text        not null primary key,
	source_type          text        not null,
	enabled              boolean     not null default true,
	config               jsonb       not null default '{}'::jsonb,
	-- Logical secret names only. A secret's value lives in the OS keychain and
	-- must never be written here.
	required_secrets     text[]      not null default '{}',
	cursor               text,
	last_health          text,
	last_run_at          timestamptz,
	consecutive_failures integer     not null default 0,
	created_at           timestamptz not null default now(),
	updated_at           timestamptz not null default now()
);

create table agent_runs (
	run_id      text        not null references daily_runs (run_id) on delete cascade,
	stage       text        not null check (stage in ('CURATOR','EDITOR')),
	status      text        not null check (status in ('RUNNING','SUCCESS','FAILED')),
	provider    text,
	model       text,
	started_at  timestamptz not null,
	finished_at timestamptz,
	duration_ms integer,
	created_at  timestamptz not null default now(),
	updated_at  timestamptz not null default now(),
	primary key (run_id, stage)
);

create table agent_attempts (
	attempt_id      text        not null primary key,
	run_id          text        not null,
	stage           text        not null check (stage in ('CURATOR','EDITOR')),
	provider        text        not null,
	model           text        not null,
	started_at      timestamptz not null,
	finished_at     timestamptz not null,
	duration_ms     integer     not null,
	status          text        not null check (status in ('SUCCESS','FAILED')),
	failure_class   text,
	fallback_reason text,
	-- Sanitized by src/runtime/error-classifier.ts before it gets here.
	error_meta      jsonb,
	-- Non-null marks a test-only synthetic fault, never a real provider failure.
	fault_injected  jsonb,
	created_at      timestamptz not null default now(),
	foreign key (run_id, stage) references agent_runs (run_id, stage) on delete cascade
);
create index agent_attempts_run_idx on agent_attempts (run_id, started_at);

create type emerging_signal_state as enum ('emerging','strengthening','confirmed','fading');

create table emerging_signals (
	lineage       text        not null default 'default',
	signal_id     text        not null,
	label         text        not null,
	rationale     text        not null default '',
	state         emerging_signal_state not null default 'emerging',
	confidence    double precision not null default 0 check (confidence between 0 and 1),
	first_seen_at timestamptz not null,
	last_seen_at  timestamptz not null,
	-- Evidence links. Array rather than a join table: a signal's story set is
	-- always read and rewritten whole, never joined against per-story.
	story_ids     text[]      not null default '{}',
	created_at    timestamptz not null default now(),
	updated_at    timestamptz not null default now(),
	primary key (lineage, signal_id)
);
create index emerging_signals_state_idx on emerging_signals (lineage, state, last_seen_at desc);
create index emerging_signals_stories_idx on emerging_signals using gin (story_ids);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Order-preserving array union: first occurrence wins its position, which is
-- what the file-backed ledger's merge does when it unions id arrays.
create or replace function array_union_ordered(a text[], b text[]) returns text[]
language sql immutable as $$
	select coalesce(array_agg(v order by ord), '{}'::text[])
	from (
		select v, min(ord) as ord
		from unnest(coalesce(a, '{}'::text[]) || coalesce(b, '{}'::text[])) with ordinality as t(v, ord)
		group by v
	) u;
$$;

-- Same tokenisation the ledger's in-process history search uses: lowercase,
-- split on anything that is not ASCII alphanumeric or CJK.
create or replace function ledger_tokens(t text) returns text[]
language sql immutable as $$
	select regexp_split_to_array(lower(coalesce(t, '')), '[^a-z0-9一-鿿]+');
$$;
