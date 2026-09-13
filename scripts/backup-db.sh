#!/usr/bin/env bash
#
# Dumps the Postgres database (running in OrbStack via this repo's
# compose.yaml, Stage 2 of docs/PRODUCTION_PLAN.md) to a timestamped,
# gzip-compressed file, then prunes old backups per a 7-daily / 4-weekly /
# 3-monthly retention policy.
#
# Connection settings come from a repo env file (never a hardcoded value or a
# command-line argument, so a password never appears in `ps` output or shell
# history). PGPASSWORD is exported into this script's own environment only,
# for the duration of the pg_dump call.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd -P)"

# Backups live under the repo, not /Volumes/Data -- a scheduled LaunchAgent
# cannot reliably reach an external volume on this machine.
BACKUP_DIR="${PROJECT_ROOT}/backups"
ENV_FILE="${DAILY_INTELLIGENCE_ENV_FILE:-${PROJECT_ROOT}/.env}"

fail() {
	echo "backup-db: $*" >&2
	exit 1
}

# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib-db-env.sh"
resolve_db_env "${ENV_FILE}" || fail "could not resolve database connection settings from ${ENV_FILE}"
# PGPASSWORD is intentionally optional: a .pgpass file is an equally valid way
# to authenticate and this script must not require one over the other.

command -v pg_dump >/dev/null 2>&1 || fail "pg_dump not found on PATH"
command -v gzip >/dev/null 2>&1 || fail "gzip not found on PATH"

mkdir -p "${BACKUP_DIR}"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="${BACKUP_DIR}/${PGDATABASE}-${TIMESTAMP}.sql.gz"
TMP_FILE="${OUT_FILE}.partial"

echo "backup-db: dumping ${PGDATABASE}@${PGHOST}:${PGPORT} -> ${OUT_FILE}"

# PGPASSWORD (if set) travels through the environment only -- never as a
# command-line argument, which would leak into `ps` and shell history.
pg_dump --no-owner --no-privileges | gzip >"${TMP_FILE}"
mv -- "${TMP_FILE}" "${OUT_FILE}"

echo "backup-db: wrote $(du -h "${OUT_FILE}" | cut -f1) to ${OUT_FILE}"

echo "backup-db: applying retention policy (7 daily / 4 weekly / 3 monthly)..."

# The actual keep/prune decision is made by the pure, unit-tested
# `selectRetention` function in src/ops/retention.ts -- this script only
# feeds it the real directory listing and acts on its answer, so the
# dangerous logic is never re-implemented here in bash.
PNPM_BIN="$(command -v pnpm || true)"
[[ -n "${PNPM_BIN}" ]] || fail "pnpm not found on PATH"

PRUNE_LIST="$(cd "${PROJECT_ROOT}" && "${PNPM_BIN}" exec tsx src/ops/list-prune-candidates.ts "${BACKUP_DIR}")"

if [[ -z "${PRUNE_LIST}" ]]; then
	echo "backup-db: nothing to prune."
	exit 0
fi

echo "backup-db: the following backups will be pruned:"
echo "${PRUNE_LIST}"

while IFS= read -r name; do
	[[ -z "${name}" ]] && continue
	target="${BACKUP_DIR}/${name}"
	# Refuse to touch anything that resolves outside BACKUP_DIR -- belt and
	# braces on top of the pure function only ever naming files it was given.
	case "${target}" in
		"${BACKUP_DIR}"/*) rm -f -- "${target}" ;;
		*) fail "refusing to delete path outside backup dir: ${target}" ;;
	esac
done <<<"${PRUNE_LIST}"

echo "backup-db: pruning complete."
