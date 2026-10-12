#!/bin/bash
cd /home/z/my-project/edge-engine
while true; do
  echo "[$(date -Iseconds)] starting command-handler"
  ./node_modules/.bin/tsx packages/scanner/src/runners/command-handler.ts --loop >> logs/command-handler.log 2>&1
  echo "[$(date -Iseconds)] command-handler exited — restarting in 5s"
  sleep 5
done
