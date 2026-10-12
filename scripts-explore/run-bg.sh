#!/bin/bash
# Usage: run-bg.sh <name> <script>
NAME=$1
SCRIPT=$2
TSX=/home/z/my-project/edge-engine/node_modules/.bin/tsx
REPO=/home/z/my-project/edge-engine
cd "$REPO"
while true; do
  echo "[$(date -Iseconds)] starting $NAME ($SCRIPT)"
  $TSX "$SCRIPT" >> "logs/$NAME.log" 2>&1
  EXIT=$?
  echo "[$(date -Iseconds)] $NAME exited with $EXIT — restarting in 5s"
  sleep 5
done
