#!/usr/bin/env bash
#
# Installs both Daily Intelligence LaunchAgents (daily pipeline + incremental
# ingestion) into the current user's gui/<uid> domain. Safe to re-run.
#
# Never call this from an unattended context expecting it to "just work" on a
# machine nobody has logged into since reboot: a user LaunchAgent needs a GUI
# session to bootstrap into, by design (it needs the login Keychain).

set -euo pipefail

# Resolve the project root from this script's own location, not the caller's
# cwd -- this script may be invoked with an arbitrary working directory.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd -P)"

LAUNCHD_DIR="${PROJECT_ROOT}/launchd"
LOG_DIR="${PROJECT_ROOT}/logs"
TARGET_DIR="${HOME}/Library/LaunchAgents"
UID_NUM="$(id -u)"

DAILY_LABEL="com.dailyintelligence.daily"
INCREMENTAL_LABEL="com.dailyintelligence.incremental"

fail() {
	echo "install-launchagent: $*" >&2
	exit 1
}

echo "install-launchagent: resolving toolchain..."

# mise-managed Node/pnpm: resolve what is actually active for this shell
# rather than guessing a Homebrew or system path.
NODE_BIN="$(command -v node || true)"
PNPM_BIN="$(command -v pnpm || true)"

[[ -n "${NODE_BIN}" ]] || fail "could not resolve 'node' on PATH (expected a mise-managed install)"
[[ -n "${PNPM_BIN}" ]] || fail "could not resolve 'pnpm' on PATH (expected a mise-managed install)"
[[ -x "${NODE_BIN}" ]] || fail "resolved node at ${NODE_BIN} is not executable"
[[ -x "${PNPM_BIN}" ]] || fail "resolved pnpm at ${PNPM_BIN} is not executable"

NODE_BIN_DIR="$(dirname -- "${NODE_BIN}")"

[[ -d "${PROJECT_ROOT}" ]] || fail "project root does not exist: ${PROJECT_ROOT}"
[[ -f "${LAUNCHD_DIR}/daily.plist.template" ]] || fail "missing template: ${LAUNCHD_DIR}/daily.plist.template"
[[ -f "${LAUNCHD_DIR}/incremental.plist.template" ]] || fail "missing template: ${LAUNCHD_DIR}/incremental.plist.template"

echo "install-launchagent: project root      = ${PROJECT_ROOT}"
echo "install-launchagent: node               = ${NODE_BIN}"
echo "install-launchagent: pnpm               = ${PNPM_BIN}"
echo "install-launchagent: uid                = ${UID_NUM}"

mkdir -p "${LOG_DIR}"
mkdir -p "${TARGET_DIR}"

render_plist() {
	local template="$1"
	local out="$2"
	sed \
		-e "s#{{PROJECT_ROOT}}#${PROJECT_ROOT}#g" \
		-e "s#{{NODE_BIN}}#${NODE_BIN}#g" \
		-e "s#{{PNPM_BIN}}#${PNPM_BIN}#g" \
		-e "s#{{NODE_BIN_DIR}}#${NODE_BIN_DIR}#g" \
		-e "s#{{LOG_DIR}}#${LOG_DIR}#g" \
		-e "s#{{UID}}#${UID_NUM}#g" \
		"${template}" >"${out}"
}

install_job() {
	local label="$1"
	local template="$2"
	local rendered="${TARGET_DIR}/${label}.plist"

	echo "install-launchagent: rendering ${label}..."
	render_plist "${template}" "${rendered}"

	if grep -q '{{' "${rendered}"; then
		fail "unsubstituted token remains in ${rendered}"
	fi

	# Idempotent: tear down any previous instance of this label before
	# re-registering it. `bootout` on a job that isn't loaded exits non-zero,
	# which is fine and expected on a first install.
	launchctl bootout "gui/${UID_NUM}/${label}" >/dev/null 2>&1 || true

	echo "install-launchagent: bootstrapping ${label}..."
	launchctl bootstrap "gui/${UID_NUM}" "${rendered}"

	echo "install-launchagent: verifying ${label} is loaded..."
	if ! launchctl print "gui/${UID_NUM}/${label}" >/dev/null 2>&1; then
		fail "${label} did not load -- check ${LOG_DIR}/${label##*.}.err.log"
	fi
	echo "install-launchagent: ${label} loaded."
}

install_job "${DAILY_LABEL}" "${LAUNCHD_DIR}/daily.plist.template"
install_job "${INCREMENTAL_LABEL}" "${LAUNCHD_DIR}/incremental.plist.template"

echo "install-launchagent: done."
echo "install-launchagent: trigger a manual run with:"
echo "  launchctl kickstart -k gui/${UID_NUM}/${DAILY_LABEL}"
echo "  launchctl kickstart -k gui/${UID_NUM}/${INCREMENTAL_LABEL}"
