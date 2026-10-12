#!/bin/bash
# Usage: run-bg-arg.sh <name> <script> <arg>
NAME=$1
SCRIPT=$2
ARG=$3
cd /home/z/my-project/edge-engine
while true; do
  echo "[$(date -Iseconds)] starting $NAME"
  ./node_modules/.bin/tsx "$SCRIPT" $ARG >> "logs/$NAME.log" 2>&1
  echo "[$(date -Iseconds)] $NAME exited — restarting in 5s"
  sleep 5
done
