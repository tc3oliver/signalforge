# Runbook

Failure playbooks for Daily Intelligence's operations layer. Pair with
`docs/OPERATIONS.md` for the normal-day reference.

## The machine must be logged in

**Prominent constraint, repeated here on purpose:** after a reboot, nobody is
logged in until a login happens at the console (or via Screen Sharing). A
user LaunchAgent in `gui/<uid>` does not start until that user's GUI session
exists — this is macOS design, not a bug, and it is why this automation is a
LaunchAgent and not a LaunchDaemon (it needs the login Keychain for the Pi
provider auth and Tavily credential, which only a GUI-session job can read).

- Screen lock alone does **not** block the agent — a locked-but-logged-in
  session still runs scheduled jobs normally.
- A reboot with nobody logged in means every scheduled run is silently
  skipped until someone logs in.

**Symptom:** no `logs/daily.out.log`/`logs/daily.err.log` entries for the
expected run time, and:

```sh
launchctl print gui/$(id -u)/com.dailyintelligence.daily
# -> "Could not find service" or similar
```

**Fix:** log in at the console once. If the agent was already installed
before the reboot, it comes back on its own — nothing to reinstall. Confirm
with `launchctl print gui/$(id -u)/com.dailyintelligence.daily` (should show
`state = running` or `waiting`).

In short, the standing requirement:

- A LaunchAgent needs a GUI (Aqua) session. After a reboot the user must log
  in once.
- The login Keychain and the Pi authentication it holds must be available in
  that session.
- Screen lock afterwards is fine; the jobs keep running.

### On the UID in these commands

Everything above is written as `gui/$(id -u)/…` and every script resolves the
uid the same way at run time (`scripts/install-launchagent.sh`,
`scripts/uninstall-launchagent.sh`). `gui/501` is what that resolved to on the
machine where this was validated, and it appears in acceptance evidence for
that reason — but it is an observation, not a value to copy. Never write a
literal uid into a script or a plist: the same repo on another account, or the
same account restored onto another machine, would then point launchctl at a
session that does not exist.

## Agent not loaded (outside the reboot case)

```sh
launchctl print gui/$(id -u)/com.dailyintelligence.daily
```

If this fails and you *are* logged in:

1. Re-run `./scripts/install-launchagent.sh` — it is idempotent and will
   re-bootstrap the job.
2. If it still fails to load, the installer's own verification step prints
   which job did not load — check the corresponding `logs/*.err.log` for a
   launchd-level error (e.g. an unreadable plist, a `ProgramArguments` binary
   that no longer exists because mise moved it).
3. Confirm the resolved `node`/`pnpm` paths in `~/Library/LaunchAgents/*.plist`
   still exist: `mise` upgrades change the install path under
   `~/.local/share/mise/installs/`, and a stale absolute path in an already-
   installed plist will fail silently at run time. Re-running the installer
   re-resolves and re-renders these.

## Collector failing

**Symptom:** `logs/incremental.err.log` or `logs/daily.err.log` shows a
collector-specific error (rate limit, auth failure, schema mismatch on the
upstream API).

1. Check whether it is one collector or all of them — a single failing
   collector should not fail the whole run (that contract lives in
   `src/collectors/types.ts`, owned outside this operations layer).
2. If it is a persistent single-source failure, it does not need the
   LaunchAgent touched at all — this is a collector-code or credential issue.
   Escalate to whoever owns `src/collectors/**` with the log excerpt.
3. If every collector fails at once, suspect network/DNS on this machine or
   an expired credential in the Keychain rather than the schedule itself.

## Pi provider quota exhausted

**Symptom:** curator/editor stage errors referencing a rate limit or quota
from the Pi provider.

1. This is expected to happen occasionally — it is not a LaunchAgent problem.
   Confirm the job actually ran (check `logs/daily.out.log` for the stage
   sequence) rather than assuming it silently skipped.
2. A quota exhaustion mid-run should leave the previous day's published brief
   untouched (the incremental job never rewrites it, and the daily job is
   expected to fail its validation gate rather than publish a broken brief —
   see "Brief failed validation" below).
3. No manual recovery of the LaunchAgent state is needed; the next scheduled
   run (05:30 next day, or the next incremental slot) will simply try again.

## Database down

**Symptom:** any stage error mentioning connection refused/timeout to
Postgres, or `backup-db.sh` / `restore-db.sh` failing at the
`pg_dump`/`psql`/`createdb` step.

1. Confirm the OrbStack Postgres container is actually running (this repo's
   `compose.yaml`, owned outside this operations layer) — this is an OrbStack
   / Docker Compose question, not a LaunchAgent one.
2. Once Postgres is back, the incremental job's next scheduled slot will
   pick up where it left off; there is no separate "resume" step here.
3. To confirm backups are unaffected: `ls -la backups/` — a backup that ran
   while Postgres was down will simply have failed loudly (`pg_dump` exits
   non-zero, `backup-db.sh` exits non-zero via `set -euo pipefail`, no
   partial file is left because the dump is written to a `.partial` path and
   only renamed into place on success).

## Brief failed validation

**Symptom:** `logs/daily.err.log` shows the validate stage rejecting the
day's brief.

1. This is the trust boundary working as designed (see the project's
   `AGENTS.md`): a rejected submission is a real result, not a bug to route
   around. Do not weaken the validator to force a pass.
2. The previous day's published brief remains live — nothing here overwrites
   it on a failed validation.
3. If this needs a human decision (e.g. whether to manually re-trigger with
   `launchctl kickstart -k`), that is a content/editorial call outside this
   operations layer's scope — flag it rather than re-running blindly on a
   loop.

## Restoring from backup

Always restore into the scratch database first and inspect it before ever
considering `--force`:

```sh
./scripts/restore-db.sh --file backups/<name>.sql.gz
docker exec daily-intelligence-postgres sh -c \
	'psql -U "$POSTGRES_USER" -d daily_intelligence_restore_test -c "select count(*) from schema_migrations;"'
```

(`psql`/`createdb` run inside the container, same as the backup/restore scripts
themselves — there is no Postgres client on the host. `--target` is
deliberately omitted above: the restore guard only accepts the production
name, with `--force`, the default scratch name shown here, or a name
prefixed with `daily_intelligence_` — see docs/OPERATIONS.md.)

Only restore over production (`--force`) as a deliberate, confirmed decision
— never as an automated or scripted recovery step.

## LaunchAgent manual trigger acceptance (Stage 6.3 of the production plan)

To prove the agent works end to end after install:

```sh
launchctl kickstart -k gui/$(id -u)/com.dailyintelligence.daily
tail -f logs/daily.out.log logs/daily.err.log
```

A clean run should reach the publish stage and update the brief; a failed run
should fail loudly in `logs/daily.err.log` with a stage name, not hang or
exit silently.
