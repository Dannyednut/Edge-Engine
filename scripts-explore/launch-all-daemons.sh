#!/bin/bash
# Launch all 5 background daemons using the proper double-fork pattern.
# Usage: bash scripts-explore/launch-all-daemons.sh
#
# Daemons started:
#   1. telegram-listener    — listens for Telegram messages from principal
#   2. command-handler      — processes inbox commands
#   3. realtime-opp-alerts  — fires Telegram alerts on high-value opps (60s poll)
#   4. opp-db               — records opp snapshots to SQLite (5min poll)
#   5. paper-trader         — simulates VOOI arb trades
#
# Each daemon auto-restarts 5s after exit.
# Logs: logs/<name>.log
# Stop: pkill -f "tsx.*<script-name>"

cd "$(dirname "$0")/.."  # edge-engine root

# CRITICAL: Ensure /home/z/my-project/.env is symlinked to edge-engine/.env
# The parent Next.js project overwrites this file periodically
if [ -f "/home/z/my-project/.env" ] && [ ! -L "/home/z/my-project/.env" ]; then
  echo "WARNING: /home/z/my-project/.env is not a symlink — re-symlinking..."
  rm /home/z/my-project/.env
  ln -s /home/z/my-project/edge-engine/.env /home/z/my-project/.env
fi

# Verify .env has all required keys
ENV_LINES=$(wc -l < /home/z/my-project/edge-engine/.env)
if [ "$ENV_LINES" -lt 30 ]; then
  echo "CRITICAL: .env file has only $ENV_LINES lines — may be corrupted!"
  echo "Expected: 50+ lines with all API keys"
  exit 1
fi
echo "OK: .env file verified ($ENV_LINES lines)"

mkdir -p logs

start_daemon() {
  local NAME=$1
  local SCRIPT=$2
  local ARG=$3
  ( setsid bash -c "
    cd /home/z/my-project/edge-engine
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

echo ""
echo "All 8 daemons started. Check logs/ for output."
echo "Stop all: pkill -f 'tsx'"
