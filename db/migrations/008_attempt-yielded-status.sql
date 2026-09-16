-- A curator turn that stops because it reached its work-unit ceiling, with
-- items still undecided and real decisions committed along the way, is not a
-- failed attempt. It used to be recorded as one: status FAILED, failure_class
-- TIMEOUT. `decideAction` reads TIMEOUT as a transient provider fault -- retry
-- once, then fall back -- so on 2026-09-16 six consecutive turns that were each
-- making steady progress burned the entire three-model chain in 28 minutes and
-- the run ended CURATION_FAILED with 1050 of 1626 items decided and no model
-- that had actually misbehaved.
--
-- The distinction has to live in the row, not only in the code that writes it.
-- Anything counting failures or fallbacks off agent_attempts -- the observation
-- report, src/cli/benchmark.ts, a future health check -- would otherwise keep
-- reporting a healthy bounded run as a three-model outage.
--
-- Widening a check constraint rather than adding a column: status already
-- answers "how did this attempt end", and a parallel boolean would leave two
-- fields that can disagree.

alter table agent_attempts
	drop constraint if exists agent_attempts_status_check;

alter table agent_attempts
	add constraint agent_attempts_status_check
	check (status in ('SUCCESS', 'FAILED', 'YIELDED'));

comment on column agent_attempts.status is
	'SUCCESS: the stage produced accepted output. FAILED: a real provider or output failure; consumes the model chain. YIELDED: the turn hit its work-unit ceiling with progress committed and work remaining; continues on the same model and consumes no fallback budget.';
