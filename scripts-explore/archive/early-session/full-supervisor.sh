#!/bin/bash
# Full supervisor — keeps ALL 4 background processes alive
# Restarts any process that crashes

cd /home/z/my-project/edge-engine
set -a
source .env
set +a

SCANNER_SCRIPT=/home/z/my-project/edge-engine/packages/scanner/node_modules/.bin/tsx
SCANNER_DIR=/home/z/my-project/edge-engine/packages/scanner
ALERTS_DIR=/home/z/my-project/edge-engine/packages/alerts

while true; do
  # Check if scanner is running
  if ! pgrep -f "all-runner" > /dev/null 2>&1; then
    echo "[$(date)] Starting scanner..." >&2
    cd "$SCANNER_DIR" && $SCANNER_SCRIPT src/runners/all-runner.ts >> /tmp/scan-bg.log 2>&1 &
  fi

  # Check if listener is running
  if ! pgrep -f "listener.ts" > /dev/null 2>&1; then
    echo "[$(date)] Starting listener..." >&2
    cd "$ALERTS_DIR" && ./node_modules/.bin/tsx src/listener.ts >> /tmp/listener-bg.log 2>&1 &
  fi

  # Check if command handler is running
  if ! pgrep -f "command-handler" > /dev/null 2>&1; then
    echo "[$(date)] Starting command handler..." >&2
    cd "$SCANNER_DIR" && $SCANNER_SCRIPT src/runners/command-handler.ts --loop >> /tmp/cmd-handler.log 2>&1 &
  fi

  # Check if opp monitor is running
  if ! pgrep -f "opportunity-monitor" > /dev/null 2>&1; then
    echo "[$(date)] Starting opp monitor..." >&2
    cd "$SCANNER_DIR" && $SCANNER_SCRIPT src/runners/opportunity-monitor.ts >> /tmp/opp-monitor.log 2>&1 &
  fi

  sleep 10
done
