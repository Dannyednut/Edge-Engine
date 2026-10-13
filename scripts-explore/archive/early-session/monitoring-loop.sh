#!/bin/bash
# Monitoring loop — checks for Telegram messages + restarts processes
# Run this in the foreground to keep the session alive

cd /home/z/my-project/edge-engine
set -a
source .env
set +a

SCANNER_DIR=/home/z/my-project/edge-engine/packages/scanner
ALERTS_DIR=/home/z/my-project/edge-engine/packages/alerts

while true; do
  # Check and restart processes
  if ! pgrep -f "all-runner" > /dev/null 2>&1; then
    echo "[$(date)] Restarting scanner..."
    cd "$SCANNER_DIR" && ./node_modules/.bin/tsx src/runners/all-runner.ts >> /tmp/scan-bg.log 2>&1 &
  fi

  if ! pgrep -f "listener.ts" > /dev/null 2>&1; then
    echo "[$(date)] Restarting listener..."
    cd "$ALERTS_DIR" && ./node_modules/.bin/tsx src/listener.ts >> /tmp/listener-bg.log 2>&1 &
  fi

  if ! pgrep -f "command-handler" > /dev/null 2>&1; then
    echo "[$(date)] Restarting command handler..."
    cd "$SCANNER_DIR" && ./node_modules/.bin/tsx src/runners/command-handler.ts --loop >> /tmp/cmd-handler.log 2>&1 &
  fi

  if ! pgrep -f "opportunity-monitor" > /dev/null 2>&1; then
    echo "[$(date)] Restarting opp monitor..."
    cd "$SCANNER_DIR" && ./node_modules/.bin/tsx src/runners/opportunity-monitor.ts >> /tmp/opp-monitor.log 2>&1 &
  fi

  # Check for Telegram messages
  if [ -f /tmp/telegram-inbox.jsonl ]; then
    UNREAD=$(python3 -c "
import json
with open('/tmp/telegram-inbox.jsonl') as f:
    lines = [l for l in f.read().split('\n') if l.strip()]
entries = [json.loads(l) for l in lines if l.strip()]
unread = [e for e in entries if not e.get('processed', False)]
print(len(unread))
" 2>/dev/null)
    if [ "$UNREAD" != "0" ] && [ -n "$UNREAD" ]; then
      echo "[$(date)] Telegram: $UNREAD unread messages!"
    fi
  fi

  # Print status
  PROCS=$(pgrep -f "all-runner|listener.ts|command-handler|opportunity-monitor" 2>/dev/null | wc -l)
  echo "[$(date)] Processes: $PROCS | Inbox: ${UNREAD:-0} unread"

  sleep 30
done
