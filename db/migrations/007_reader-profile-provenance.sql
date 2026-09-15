-- config/interests.yaml now reaches both agents as priors on relevance and
-- ordering (src/profile/reader-profile.ts). Two columns make that auditable
-- rather than merely believed.
--
-- story_ledger.topic_ids records which of the reader's topics the Curator said
-- a story matched. Without it the prior is invisible: a story ranked highly
-- looks the same whether the model applied the profile or ignored it, and
-- "weights are priors, not filters" becomes a claim nothing can check. The
-- column is nullable and defaults to empty, because a story matching no listed
-- topic is a normal and expected outcome -- an important outage reaches this
-- reader whether or not a topic names it, and recording that as an empty array
-- is the honest answer, not a gap.
--
-- daily_briefs.profile_version records the hash of the profile that shaped a
-- published brief. A change to interests.yaml changes what the agents read, and
-- without this the run history cannot distinguish "the model behaved
-- differently" from "the reader changed their mind".

alter table story_ledger
	add column if not exists topic_ids text[] not null default '{}';

alter table daily_briefs
	add column if not exists profile_version text;

-- Every brief already published was shaped by no profile at all, which is a
-- fact worth keeping rather than back-dating to whatever the file says today.
comment on column daily_briefs.profile_version is
	'Hash of the reader profile that shaped this brief; null for briefs published before interests reached the agents.';
