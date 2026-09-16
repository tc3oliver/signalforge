#!/usr/bin/env bash
# Run a command, but only once the container host is actually answering.
#
# The pipeline's database lives in the OrbStack VM. macOS suspends that VM
# whenever the host sleeps, and OrbStack resumes it only on a *real user wake* --
# a DarkWake does not count. A scheduled job therefore starts on time against a
# host that is not there, and the host-side port forwarder still accepts TCP, so
# the failure arrives as a connect timeout rather than a refusal.
#
# That cost the 2026-09-16 brief in full: launchd fired at 05:30, the first query
# returned `write CONNECT_TIMEOUT 127.0.0.1:55432`, the run ended, and the VM
# came back at 05:59 on its own because a network packet arrived. Twenty-nine
# minutes, and nothing left to use it.
#
# So this does not wait politely -- waiting is what failed. It asserts user
# activity, which is the one thing OrbStack treats as a resume trigger, and only
# then hands over. `pmset disablesleep 1` (see the setup repo) is what stops the
# suspension happening at all; this is what makes a job survive it anyway.
set -uo pipefail

DEADLINE_SECONDS="${CONTAINER_HOST_DEADLINE:-300}"
POLL_SECONDS=5

log() { printf '{"scope":"preflight","msg":%s,"ts":"%s"}\n' "$(printf '%s' "$1" | sed 's/"/\\"/g;s/^/"/;s/$/"/')" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2; }

# Bounded, because the failure being handled is precisely one that never returns:
# an unbounded `docker version` against a suspended VM blocks forever and would
# hang this script in place of the job it is protecting.
docker_answers() {
  docker version --format '{{.Server.Version}}' >/dev/null 2>&1 &
  local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if (( waited >= 10 )); then
      kill -9 "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 1
    fi
    sleep 1
    waited=$(( waited + 1 ))
  done
  wait "$pid"
}

if docker_answers; then
  exec "$@"
fi

log "container host not answering; asserting user activity to resume it"

started=$(date +%s)
while true; do
  # -u declares user activity and -t bounds the assertion, so nothing is left
  # holding the machine awake after this script exits.
  caffeinate -u -t 2 2>/dev/null || true

  if docker_answers; then
    log "container host resumed after $(( $(date +%s) - started ))s"
    exec "$@"
  fi

  if (( $(date +%s) - started >= DEADLINE_SECONDS )); then
    log "container host still not answering after ${DEADLINE_SECONDS}s; running anyway so the failure is the job's to report"
    # Deliberately not a hard exit. The job has its own bounded wait and its own
    # error reporting; swallowing the run here would replace a diagnosable
    # pipeline failure with a silent no-op, which is harder to notice and harder
    # to debug.
    exec "$@"
  fi

  sleep "$POLL_SECONDS"
done
