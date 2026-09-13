#!/usr/bin/env bash
#
# Removes both Daily Intelligence LaunchAgents and their installed plists.
# Never touches logs or data -- only ~/Library/LaunchAgents/*.plist and the
# running launchd registration.

set -euo pipefail

TARGET_DIR="${HOME}/Library/LaunchAgents"
UID_NUM="$(id -u)"

DAILY_LABEL="com.dailyintelligence.daily"
INCREMENTAL_LABEL="com.dailyintelligence.incremental"

fail() {
	echo "uninstall-launchagent: $*" >&2
	exit 1
}

remove_job() {
	local label="$1"
	local plist="${TARGET_DIR}/${label}.plist"

	echo "uninstall-launchagent: removing ${label}..."
	launchctl bootout "gui/${UID_NUM}/${label}" >/dev/null 2>&1 || true

	if [[ -f "${plist}" ]]; then
		rm -f -- "${plist}"
	fi

	if launchctl print "gui/${UID_NUM}/${label}" >/dev/null 2>&1; then
		fail "${label} is still loaded after bootout"
	fi
	if [[ -f "${plist}" ]]; then
		fail "${plist} still exists after removal"
	fi
	echo "uninstall-launchagent: ${label} removed."
}

remove_job "${DAILY_LABEL}"
remove_job "${INCREMENTAL_LABEL}"

echo "uninstall-launchagent: done. Logs and data were left untouched."
