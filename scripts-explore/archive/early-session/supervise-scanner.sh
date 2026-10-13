#!/bin/bash
# Supervisor script that keeps the scanner alive
# Restarts scanner if it exits for any reason
# Logs restart events to /tmp/scanner-restarts.log

cd /home/z/my-project/edge-engine/packages/scanner
set -a
source /home/z/my-project/edge-engine/.env
set +a

RESTART_COUNT=0
MAX_RESTARTS=100

while [ $RESTART_COUNT -lt $MAX_RESTARTS ]; do
  RESTART_COUNT=$((RESTART_COUNT + 1))
  echo "[$(date)] === Scanner restart #$RESTART_COUNT ===" >> /tmp/scanner-restarts.log
  echo "[$(date)] === Starting scanner (attempt $RESTART_COUNT) ==="

  # Run scanner directly. It will exit when it crashes.
  ./node_modules/.bin/tsx src/runners/all-runner.ts 2>&1

  EXIT_CODE=$?
  echo "[$(date)] Scanner exited with code $EXIT_CODE" >> /tmp/scanner-restarts.log
  echo "[$(date)] Scanner exited with code $EXIT_CODE, restarting in 3s..."

  # Brief pause before restart
  sleep 3
done

echo "[$(date)] Reached max restarts ($MAX_RESTARTS). Giving up." >> /tmp/scanner-restarts.log
