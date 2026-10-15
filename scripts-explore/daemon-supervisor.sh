#!/bin/bash
# Daemon Supervisor — ensures all daemons stay alive
# Checks every 60s, restarts dead daemons
#
# Duplicate prevention:
#   The supervisor checks both the PID file AND the process table before
#   starting a new wrapper. If a wrapper is in its 5-second restart sleep,
#   the wrapper process (bash -c) is still alive and will be detected by
#   the PID file check, preventing a duplicate wrapper.
#
#   The supervisor also tracks wrapper PIDs (the setsid bash -c process)
#   separately from child PIDs (the tsx process). A wrapper being alive
#   means the daemon is managed, even if the child tsx is temporarily
#   crashed and sleeping in the restart loop.

cd /home/z/my-project/edge-engine

mkdir -p logs run

DAEMONS=(
  "telegram-listener:packages/alerts/src/listener.ts:"
  "command-handler:packages/scanner/src/runners/command-handler.ts:--loop"
  "realtime-opp-alerts:scripts-explore/realtime-opp-alerts.mts:"
  "opp-db:scripts-explore/opp-db.mts:--loop"
  "hl-funding-alerts:scripts-explore/hl-funding-alerts.mts:"
  "paper-trader:scripts-explore/paper-trader.mts:"
  "risk-dashboard:scripts-explore/risk-dashboard-v2.mts:"
  "wallet-funding-alert:scripts-explore/wallet-funding-alert.mts:"
  "realtime-spread-monitor:scripts-explore/realtime-spread-monitor.mts:"
  "khype-timeseries:packages/scanner/src/runners/khype-timeseries.ts:"
  "khype-cadence-sampler:packages/scanner/src/runners/khype-cadence-sampler.ts:"
  "limusd-monitor:packages/scanner/src/runners/limusd-monitor.ts:"
)

# Check if a daemon wrapper is already managing this script.
# Returns 0 (managed) or 1 (needs restart).
is_managed() {
  local NAME=$1
  local SCRIPT=$2
  local PID_FILE="run/${NAME}.pid"

  # Check 1: PID file exists and the process is alive
  if [ -f "$PID_FILE" ]; then
    local PID=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      # The wrapper process is alive — daemon is managed
      return 0
    fi
    # PID file exists but process is dead — stale lock
    rm -f "$PID_FILE"
  fi

  # Check 2: Look for any running wrapper that references this script
  # This catches wrappers started by the launcher (which also writes PID files)
  local wrapper_count=$(ps aux | grep "tsx.*${SCRIPT}" | grep -v grep | wc -l)
  if [ "$wrapper_count" -gt 0 ]; then
    # A tsx process for this script is running — daemon is managed
    return 0
  fi

  # Also check for wrapper bash processes in their 5-second sleep
  # The wrapper is a bash -c process that runs the while loop
  local bash_wrapper=$(ps aux | grep "bash -c" | grep "${NAME}" | grep -v grep | wc -l)
  if [ "$bash_wrapper" -gt 0 ]; then
    return 0
  fi

  return 1  # not managed — needs restart
}

check_and_restart() {
  local name="$1"
  local script="$2"
  local arg="$3"

  if is_managed "$name" "$script"; then
    return 0  # already managed
  fi

  echo "[$(date -Iseconds)] RESTARTING: $name (script: $script)"

  ( setsid bash -c "
    cd /home/z/my-project/edge-engine
    echo \$\$ > run/${name}.pid
    exec >> logs/${name}.log 2>&1
    echo \"[\$(date -Iseconds)] daemon ${name} restarting (via supervisor), pid=\$\$\"
    while true; do
      ./node_modules/.bin/tsx ${script} ${arg}
      EXIT=\$?
      echo \"[\$(date -Iseconds)] ${name} exited with \$EXIT — restarting in 5s\"
      sleep 5
    done
  " </dev/null >/dev/null 2>&1 & )

  echo "[$(date -Iseconds)] STARTED: $name"
}

echo "[$(date -Iseconds)] Daemon supervisor started"
echo "[$(date -Iseconds)] Monitoring ${#DAEMONS[@]} daemons with PID-file duplicate prevention"

while true; do
  for daemon in "${DAEMONS[@]}"; do
    IFS=':' read -r name script arg <<< "$daemon"
    check_and_restart "$name" "$script" "$arg"
  done

  sleep 60
done
