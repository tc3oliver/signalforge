#!/usr/bin/env bash
#
# Restores a gzip-compressed pg_dump backup into an explicit target database.
# Defaults to a scratch database so a restore *test* can never clobber
# production by accident; restoring into the production database name
# requires --force.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd -P)"

BACKUP_DIR="${PROJECT_ROOT}/backups"
ENV_FILE="${DAILY_INTELLIGENCE_ENV_FILE:-${PROJECT_ROOT}/.env}"
SCRATCH_DB_SUFFIX="_restore_test"

fail() {
	echo "restore-db: $*" >&2
	exit 1
}

usage() {
	cat >&2 <<-EOF
		usage: restore-db.sh --file <backup.sql.gz> [--target <database>] [--force]

		  --file    path to a .sql.gz backup produced by backup-db.sh (required)
		  --target  database name to restore into (default: \${PGDATABASE}${SCRATCH_DB_SUFFIX})
		  --force   required to restore into the production database name (PGDATABASE)
	EOF
	exit 1
}

BACKUP_FILE=""
TARGET_DB=""
FORCE=0

while [[ $# -gt 0 ]]; do
	case "$1" in
		--file)
			BACKUP_FILE="${2:-}"
			shift 2
			;;
		--target)
			TARGET_DB="${2:-}"
			shift 2
			;;
		--force)
			FORCE=1
			shift
			;;
		-h | --help)
			usage
			;;
		*)
			echo "restore-db: unknown argument: $1" >&2
			usage
			;;
	esac
done

[[ -n "${BACKUP_FILE}" ]] || usage
[[ -f "${BACKUP_FILE}" ]] || fail "backup file not found: ${BACKUP_FILE}"

[[ -f "${ENV_FILE}" ]] || fail "env file not found: ${ENV_FILE} (expected PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD)"

# shellcheck disable=SC1090
set -a
source "${ENV_FILE}"
set +a

: "${PGHOST:?PGHOST must be set in ${ENV_FILE}}"
: "${PGPORT:?PGPORT must be set in ${ENV_FILE}}"
: "${PGDATABASE:?PGDATABASE must be set in ${ENV_FILE}}"
: "${PGUSER:?PGUSER must be set in ${ENV_FILE}}"

if [[ -z "${TARGET_DB}" ]]; then
	TARGET_DB="${PGDATABASE}${SCRATCH_DB_SUFFIX}"
fi

if [[ "${TARGET_DB}" == "${PGDATABASE}" && "${FORCE}" -ne 1 ]]; then
	fail "refusing to restore into production database '${PGDATABASE}' without --force"
fi

command -v psql >/dev/null 2>&1 || fail "psql not found on PATH"
command -v createdb >/dev/null 2>&1 || fail "createdb not found on PATH"
command -v gunzip >/dev/null 2>&1 || fail "gunzip not found on PATH"

echo "restore-db: target database = ${TARGET_DB}"
echo "restore-db: source file     = ${BACKUP_FILE}"

# createdb exits non-zero if the database already exists -- that is fine for
# a scratch db being reused across test runs.
createdb --host "${PGHOST}" --port "${PGPORT}" --username "${PGUSER}" "${TARGET_DB}" 2>/dev/null || true

gunzip -c -- "${BACKUP_FILE}" | psql --host "${PGHOST}" --port "${PGPORT}" --username "${PGUSER}" --dbname "${TARGET_DB}" --set ON_ERROR_STOP=on

echo "restore-db: restore into '${TARGET_DB}' complete."
