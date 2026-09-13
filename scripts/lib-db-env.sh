#!/usr/bin/env bash
#
# Shared connection-resolution logic for backup-db.sh / restore-db.sh.
# Sourced, never executed directly.
#
# DATABASE_URL is the canonical setting (matches .env.example) and takes
# precedence; PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD are the fallback so
# there is exactly one source of truth per invocation, never two that can
# drift out of sync.
#
# This machine also runs several other long-lived Docker stacks (miniflux,
# bark, gemini-balance, shopmaster, tesla-tv-hub) in the same engine. The
# loopback guard below exists specifically so a missing/mistyped env value
# can never resolve to one of those instead of daily-intelligence's own
# Postgres (compose.yaml binds it to 127.0.0.1 only, by design).

# Populates PGHOST/PGPORT/PGDATABASE/PGUSER(/PGPASSWORD) in the caller's shell
# and exports them for pg_dump/psql/createdb to pick up. Returns non-zero
# (never exits — this is sourced) on any resolution failure.
resolve_db_env() {
	local env_file="$1"

	if [[ ! -f "${env_file}" ]]; then
		echo "resolve_db_env: env file not found: ${env_file}" >&2
		return 1
	fi

	# shellcheck disable=SC1090
	set -a
	# shellcheck disable=SC1091
	source "${env_file}"
	set +a

	if [[ -n "${DATABASE_URL:-}" ]]; then
		# postgres[ql]://user[:password]@host:port/dbname
		if [[ "${DATABASE_URL}" =~ ^postgres(ql)?://([^:@/]+)(:([^@]*))?@([^:/@]+):([0-9]+)/([^?]+) ]]; then
			PGUSER="${BASH_REMATCH[2]}"
			if [[ -n "${BASH_REMATCH[4]}" ]]; then
				PGPASSWORD="${BASH_REMATCH[4]}"
			fi
			PGHOST="${BASH_REMATCH[5]}"
			PGPORT="${BASH_REMATCH[6]}"
			PGDATABASE="${BASH_REMATCH[7]}"
		else
			echo "resolve_db_env: DATABASE_URL is not a recognized postgres:// URL" >&2
			return 1
		fi
	fi

	if [[ -z "${PGHOST:-}" || -z "${PGPORT:-}" || -z "${PGDATABASE:-}" || -z "${PGUSER:-}" ]]; then
		echo "resolve_db_env: PGHOST/PGPORT/PGDATABASE/PGUSER must be resolvable from DATABASE_URL or from PG* vars in ${env_file}" >&2
		return 1
	fi

	# Refuse anything but loopback. This is the guard against a stray env
	# value pointing at a different Postgres instance -- there must never be
	# a way for this project's backup/restore tooling to reach another
	# service's database.
	case "${PGHOST}" in
		127.0.0.1 | localhost) ;;
		*)
			echo "resolve_db_env: refusing non-loopback PGHOST '${PGHOST}' -- this script only operates on the local daily-intelligence Postgres" >&2
			return 1
			;;
	esac

	export PGHOST PGPORT PGDATABASE PGUSER
	if [[ -n "${PGPASSWORD:-}" ]]; then
		export PGPASSWORD
	fi

	return 0
}
