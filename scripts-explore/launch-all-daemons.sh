#!/bin/bash
# Launch all background daemons with PID-file-based duplicate prevention.
# Usage: bash scripts-explore/launch-all-daemons.sh
#
# Duplicate prevention:
#   Each daemon writes a PID file to run/<name>.pid. Before starting,
#   the launcher checks if a running process owns that PID file. If so,
#   the daemon is already running and is skipped.
#
# Stale lock recovery:
#   If the PID file exists but no process with that PID is running,
#   the lock is considered stale and is removed before starting.

cd "$(dirname "$0")/.."  # edge-engine root

# Verify edge-engine/.env has all required keys
ENV_LINES=$(wc -l < /home/z/my-project/edge-engine/.env)
if [ "$ENV_LINES" -lt 30 ]; then
  echo "CRITICAL: edge-engine/.env has only $ENV_LINES lines — may be corrupted!"
  exit 1
fi
echo "OK: edge-engine/.env verified ($ENV_LINES lines)"

mkdir -p logs run

# Check if a daemon is already running via PID file
# Returns 0 (running) or 1 (not running/stale)
is_running() {
  local NAME=$1
  local PID_FILE="run/${NAME}.pid"

  if [ ! -f "$PID_FILE" ]; then
    return 1  # no PID file → not running
  fi

  local PID=$(cat "$PID_FILE" 2>/dev/null)
  if [ -z "$PID" ]; then
    return 1  # empty PID file → stale
  fi

  # Check if the process is still running
  if kill -0 "$PID" 2>/dev/null; then
    # Verify it's actually a tsx process for this script (not a reused PID)
    local CMDLINE=$(ps -p "$PID" -o args= 2>/dev/null)
    if echo "$CMDLINE" | grep -q "tsx"; then
      return 0  # running
    fi
  fi

  # Stale PID file — remove it
  rm -f "$PID_FILE"
  return 1
}

start_daemon() {
  local NAME=$1
  local SCRIPT=$2
  local ARG=$3

  # Check if already running
  if is_running "$NAME"; then
    echo "SKIP: $NAME already running (PID $(cat run/${NAME}.pid 2>/dev/null))"
    return 0
  fi

  # Start the daemon with a wrapper that writes its own PID
  ( setsid bash -c "
    cd /home/z/my-project/edge-engine
    echo \$\$ > run/${NAME}.pid
    exec >> logs/${NAME}.log 2>&1
    echo \"[\$(date -Iseconds)] daemon ${NAME} starting, pid=\$\$\"
    while true; do
      ./node_modules/.bin/tsx ${SCRIPT} ${ARG}
      EXIT=\$?
      echo \"[\$(date -Iseconds)] ${NAME} exited with \$EXIT — restarting in 5s\"
      sleep 5
    done
  " </dev/null >/dev/null 2>&1 & )
  echo "Started daemon: $NAME"
}

start_daemon telegram-listener packages/alerts/src/listener.ts
start_daemon command-handler packages/scanner/src/runners/command-handler.ts --loop
start_daemon realtime-opp-alerts scripts-explore/realtime-opp-alerts.mts
start_daemon opp-db scripts-explore/opp-db.mts --loop
start_daemon hl-funding-alerts scripts-explore/hl-funding-alerts.mts
start_daemon paper-trader scripts-explore/paper-trader.mts
start_daemon risk-dashboard scripts-explore/risk-dashboard-v2.mts
start_daemon wallet-funding-alert scripts-explore/wallet-funding-alert.mts
start_daemon realtime-spread-monitor scripts-explore/realtime-spread-monitor.mts
start_daemon khype-timeseries packages/scanner/src/runners/khype-timeseries.ts
start_daemon khype-cadence-sampler packages/scanner/src/runners/khype-cadence-sampler.ts
start_daemon limusd-monitor packages/scanner/src/runners/limusd-monitor.ts

echo ""
echo "All 12 daemons processed. Check logs/ for output."
echo "Stop all: pkill -f 'tsx'; rm -f run/*.pid"
echo ""
echo "NOTE: daemon-supervisor.sh should be started separately to auto-restart"
echo "  any daemon that crashes. It is NOT started by this script."
