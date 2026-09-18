-- Model screening: a cheap, accountable verdict per item, separate from triage.
--
-- item_triage (009, 011) is the deterministic Stage 0 prediction with the
-- PRIORITY/NORMAL/LOW/DUPLICATE_HINT/UNCERTAIN vocabulary, and its contract is
-- that the pipeline never reads it. That table keeps its meaning unchanged: its
-- rows are still what the rules said, still shadow-only, still measured by the
-- observation report and nothing else.
--
-- This table is a different thing and must not be confused with it. A
-- screening row is a routing verdict -- DROP / KEEP / UNSURE -- that the
-- pipeline IS allowed to read, in ROUTE mode, to decide which items the
-- Curator's default broad scan offers. The vocabulary is deliberately small:
-- the screener answers "is it worth a strong model's attention?", never "how
-- important is it?", because importance, novelty and event identity need
-- history and siblings in view and the screener has neither.
--
-- What a DROP row means, exactly:
--
--   * In SHADOW mode: nothing. Every item still reaches the Curator; the row
--     is compared against the Curator's decision afterwards. `routed` is false.
--   * In ROUTE mode, when this row's (model, policy_version) is the trusted
--     pair and the item was not audit-sampled: the item is OMITTED FROM THE
--     DEFAULT BROAD SCAN. `routed` is true. It is not erased: it stays in the
--     manifest, `search_items` still finds it, and the Curator may rescue it by
--     recording a real decision, which supersedes this row editorially.
--
-- Accounting in ROUTE mode: every manifest item must be accounted for by a
-- routed DROP row OR a Curator decision. An item with neither is unaccounted
-- and submit_materials refuses. A DROP row alone never lets an item be cited
-- as a story source; that needs a Curator decision.
--
-- Keyed by (lineage, date, item_id, model, policy_version): one verdict per
-- item per screener version, so a prompt or model change starts a new evidence
-- epoch beside the old one instead of overwriting it. Recall measured across a
-- version change is two measurements averaged.
--
-- No per-item token usage column, on purpose. The provider reports usage per
-- request (one batch of ~40 items), so a per-item figure would be an
-- allocation, not a measurement. Usage lives on the agent_attempts row for the
-- SCREENER stage, per pass.
--
-- No foreign key to normalized_items: same reasoning as item_triage -- a
-- re-normalised item or a rebuilt manifest must not be blocked by a verdict
-- about it.

create table if not exists item_screening (
	lineage        text        not null,
	date           text        not null,
	item_id        text        not null,
	provider       text        not null,
	model          text        not null,
	policy_version text        not null,
	-- The run that wrote the row. Nullable: a backfill from `pnpm screen` has
	-- no daily run, and the row is still evidence.
	run_id         text,
	verdict        text        not null check (verdict in ('DROP','KEEP','UNSURE')),
	-- Stable, machine-readable reason family (e.g. FUNDING_NEWS, TRACKED_AREA,
	-- CANNOT_TELL). Lets a shift in the DROP mix be attributed to a category.
	reason_code    text        not null,
	reason         text        not null,
	-- Deterministically chosen from hash(date, item_id, policy_version) at a
	-- configured rate. An audit-sampled DROP is offered to the Curator anyway,
	-- so a routed day keeps producing ground truth about its own DROPs.
	audit_sampled  boolean     not null default false,
	-- True only when this DROP row actually withheld the item from the default
	-- broad scan. False in SHADOW mode, for KEEP/UNSURE, for audit samples, and
	-- for any version that was not the trusted one when the run happened.
	routed         boolean     not null default false,
	created_at     timestamptz not null default now(),
	primary key (lineage, date, item_id, model, policy_version)
);

create index if not exists item_screening_verdict_idx
	on item_screening (lineage, date, model, policy_version, verdict);

comment on table item_screening is
	'Cheap model screening verdicts (DROP/KEEP/UNSURE), one per item per screener version. Read by the pipeline only in ROUTE mode and only for the trusted (model, policy_version); a routed DROP is omitted from the Curator''s default scan but never from the manifest or from search_items. A Curator decision supersedes a screening row editorially.';

-- ---------------------------------------------------------------------------
-- Stage telemetry: the screener is a stage, and usage is now recorded.
-- ---------------------------------------------------------------------------

-- 001 fixed the stage vocabulary to CURATOR/EDITOR. The screener runs as its
-- own stage so its wall clock and token usage are attributable next to the
-- other two, in the tables the admin page already reads.
alter table agent_runs drop constraint if exists agent_runs_stage_check;
alter table agent_runs add constraint agent_runs_stage_check
	check (stage in ('SCREENER', 'CURATOR', 'EDITOR'));

alter table agent_attempts drop constraint if exists agent_attempts_stage_check;
alter table agent_attempts add constraint agent_attempts_stage_check
	check (stage in ('SCREENER', 'CURATOR', 'EDITOR'));

-- Provider-reported token usage for one attempt, or null when the provider
-- (or the driver) did not report any. Null means "not told", never zero: the
-- observation report prints it as unavailable rather than summing it as 0.
--
-- Shape: {"input": n, "output": n, "cacheRead": n, "cacheWrite": n,
--         "totalTokens": n, "reportedBy": n}. `reportedBy` is how many
-- provider responses contributed, so a partial sum is visible as partial.
alter table agent_attempts add column if not exists token_usage jsonb;

comment on column agent_attempts.token_usage is
	'Provider-reported token usage summed over the responses in this attempt, or null when unavailable. Never an estimate.';
