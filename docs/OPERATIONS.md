# Operations

This is the day-2 guide for running Daily Intelligence on the Mac Studio: what
runs when, where its output goes, and how to operate it by hand. See
`docs/RUNBOOK.md` for what to do when something breaks.

## What runs, and when

Two [LaunchAgents](../launchd/), both user-domain (`gui/<uid>`), never a
LaunchDaemon — they need the login Keychain for the Pi provider auth and the
Tavily credential, which only a GUI-session job can reach.

| Job | Label | Schedule | Does |
|---|---|---|---|
| Daily pipeline | `com.dailyintelligence.daily` | 05:30 | Full run: collect → curate → edit → validate → publish. Targets completion before 07:00. |
| Incremental ingestion | `com.dailyintelligence.incremental` | 09:00, 12:00, 15:00, 18:00, 21:00 | Ingests new source data and updates the normalized store only. **Never** rewrites the published daily brief. |

The command each job actually runs (`pnpm run pipeline:daily` /
`pnpm run pipeline:incremental`) is a placeholder until Stage 3 of
`docs/PRODUCTION_PLAN.md` lands those scripts in `package.json`. The
LaunchAgent plumbing (scheduling, logging, install/uninstall, verification) is
complete and tested independently of that script existing.

## Logs

Both jobs write to `logs/` at the project root:

- `logs/daily.out.log` / `logs/daily.err.log`
- `logs/incremental.out.log` / `logs/incremental.err.log`

The log directory is created by the installer if it does not exist. Logs are
never rotated by the LaunchAgent itself — if that becomes a problem, add a
`newsyslog` rule or a simple size-based rotation to the pipeline script, not
to the plist.

## Installing / uninstalling

```sh
./scripts/install-launchagent.sh     # renders both plists, bootstraps both jobs, verifies they loaded
./scripts/uninstall-launchagent.sh   # tears both jobs down, removes their plists, leaves logs and data alone
```

The installer:

1. resolves the project root from its own location (not your `cwd`),
2. resolves the active `node`/`pnpm` (mise-managed — whatever is actually on
   `PATH` when you run it, not a guessed Homebrew path),
3. validates every resolved path exists and is executable,
4. renders `launchd/*.plist.template` into `~/Library/LaunchAgents/`,
5. `launchctl bootout`s any previous instance, then
   `launchctl bootstrap gui/$(id -u)`s the new one,
6. verifies the load with `launchctl print gui/$(id -u)/<label>`, and fails
   loudly (non-zero exit) if it did not load.

It is safe to re-run at any time.

## Manual triggers and status

```sh
# Kick off a run right now, ignoring the schedule:
launchctl kickstart -k gui/$(id -u)/com.dailyintelligence.daily
launchctl kickstart -k gui/$(id -u)/com.dailyintelligence.incremental

# Check whether a job is loaded and see its last exit status:
launchctl print gui/$(id -u)/com.dailyintelligence.daily
launchctl print gui/$(id -u)/com.dailyintelligence.incremental

# Tail today's run:
tail -f logs/daily.out.log logs/daily.err.log
```

## Backup and restore

Backups are Postgres dumps (Stage 2 of the production plan — the Postgres
instance runs in OrbStack via this repo's `compose.yaml`), written to
`backups/` **inside the repo**, never to `/Volumes/Data` — a scheduled
LaunchAgent cannot reliably reach an external volume on this machine.

```sh
./scripts/backup-db.sh
```

- Reads connection settings from a repo env file (`.env` by default, override
  with `DAILY_INTELLIGENCE_ENV_FILE`). Expects `PGHOST`, `PGPORT`,
  `PGDATABASE`, `PGUSER`, and optionally `PGPASSWORD` (a `.pgpass` file works
  too — the script does not require one over the other).
- Writes `backups/<database>-<UTC timestamp>.sql.gz`.
- Applies retention (7 daily, 4 weekly, 3 monthly) using the pure,
  unit-tested `selectRetention` function in `src/ops/retention.ts`. It always
  prints the filenames it is about to prune before deleting them, and refuses
  to delete anything outside `backups/`.

```sh
./scripts/restore-db.sh --file backups/dailyintel-20260913T053000Z.sql.gz
```

- Defaults to restoring into a scratch database (`<PGDATABASE>_restore_test`)
  so a restore test can never clobber production by accident.
- Restoring into the real `PGDATABASE` name requires `--force`.
- To prove a backup is actually restorable, run the default (scratch) restore
  periodically and spot-check the result — see `docs/RUNBOOK.md`.

## Machine constraints this operations layer assumes

- **Must log in once after reboot.** macOS does not start a user
  LaunchAgent's GUI session automatically; see the Runbook.
- Node/pnpm come from **mise**, not Homebrew, not nvm. The installer resolves
  whatever is active on `PATH`, so keep mise's shims first in `PATH` for the
  shell you install from.
- Postgres runs in **OrbStack**, not Docker Desktop, not a bare local
  install.
- Nothing here opens any port to the Internet; all of this is LAN-local
  automation on a machine that never faces the Internet.
