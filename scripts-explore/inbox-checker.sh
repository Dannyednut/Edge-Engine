#!/bin/bash
# Continuously check Telegram inbox for principal commands
# Runs as a background process, checks every 60s

cd /home/z/my-project/edge-engine

while true; do
  if [ -f /tmp/telegram-inbox.jsonl ]; then
    # Check for unprocessed messages
    UNPROCESSED=$(grep '"processed":false' /tmp/telegram-inbox.jsonl 2>/dev/null | wc -l)
    if [ "$UNPROCESSED" -gt 0 ]; then
      echo "[$(date -Iseconds)] $UNPROCESSED unprocessed messages in inbox"
      # The command-handler daemon should process these
      # But let's also check if any contain "stop" or "return"
      grep '"processed":false' /tmp/telegram-inbox.jsonl 2>/dev/null | grep -i "stop\|return\|come back\|end shift" | while read line; do
        echo "[$(date -Iseconds)] PRINCIPAL COMMAND: $line"
        # Write a flag file that the main process can check
        echo "STOP" > /tmp/principal-stop-command
      done
    fi
  fi
  sleep 60
done
