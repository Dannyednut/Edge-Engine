#!/bin/bash
# Daemon Supervisor — ensures all daemons stay alive
# Checks every 60s, restarts dead daemons
# This is the "watchdog" that runs above all other daemons

cd /home/z/my-project/edge-engine

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
)

check_and_restart() {
  local name="$1"
  local script="$2"
  local arg="$3"
  
  # Check if the process is running
  local running=$(ps aux | grep "tsx.*${script}" | grep -v grep | wc -l)
  
  if [ "$running" -eq 0 ]; then
    echo "[$(date -Iseconds)] RESTARTING: $name (script: $script)"
    
    ( setsid bash -c "
      cd /home/z/my-project/edge-engine
      exec >> logs/${name}.log 2>&1
      echo \"[\$(date -Iseconds)] daemon ${name} restarting (via supervisor)\"
      while true; do
        ./node_modules/.bin/tsx ${script} ${arg}
        EXIT=\$?
        echo \"[\$(date -Iseconds)] ${name} exited with \$EXIT — restarting in 5s\"
        sleep 5
      done
    " </dev/null >/dev/null 2>&1 & )
    
    echo "[$(date -Iseconds)] STARTED: $name"
  fi
}

echo "[$(date -Iseconds)] Daemon supervisor started"
echo "[$(date -Iseconds)] Monitoring ${#DAEMONS[@]} daemons"

while true; do
  for daemon in "${DAEMONS[@]}"; do
    IFS=':' read -r name script arg <<< "$daemon"
    check_and_restart "$name" "$script" "$arg"
  done
  
  sleep 60
done
