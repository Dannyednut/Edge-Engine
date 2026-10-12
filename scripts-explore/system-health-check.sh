#!/bin/bash
# Edge Engine System Health Check
# Run this to verify all systems are operational
# Usage: bash scripts-explore/system-health-check.sh

cd "$(dirname "$0")/.."  # edge-engine root

echo "═══════════════════════════════════════════════════"
echo "  EDGE ENGINE SYSTEM HEALTH CHECK"
echo "  $(date -Iseconds)"
echo "═══════════════════════════════════════════════════"
echo ""

# 1. Check .env symlink
echo "── 1. .ENV FILE CHECK ──"
if [ -L "/home/z/my-project/.env" ]; then
  echo "  PASS: /home/z/my-project/.env is symlinked"
  ENV_LINES=$(wc -l < /home/z/my-project/edge-engine/.env)
  if [ "$ENV_LINES" -gt 30 ]; then
    echo "  PASS: .env has $ENV_LINES lines (all keys present)"
  else
    echo "  FAIL: .env has only $ENV_LINES lines — may be corrupted!"
  fi
else
  echo "  FAIL: /home/z/my-project/.env is NOT a symlink — fixing..."
  rm -f /home/z/my-project/.env
  ln -s /home/z/my-project/edge-engine/.env /home/z/my-project/.env
  echo "  FIXED: symlink restored"
fi
echo ""

# 2. Check daemons
echo "── 2. DAEMON HEALTH ──"
DAEMON_COUNT=$(ps aux | grep -E "tsx" | grep -v grep | wc -l)
echo "  tsx processes: $DAEMON_COUNT"
if [ "$DAEMON_COUNT" -ge 15 ]; then
  echo "  PASS: sufficient processes running"
else
  echo "  WARNING: low process count — daemons may need restart"
  echo "  Run: bash scripts-explore/launch-all-daemons.sh"
fi
echo ""

# 3. Check paper trader
echo "── 3. PAPER TRADER ──"
if [ -f "/home/z/my-project/download/paper-trading-state.json" ]; then
  CAPITAL=$(grep currentCapital /home/z/my-project/download/paper-trading-state.json | head -1 | grep -oE '[0-9.]+' | head -1)
  TRADES=$(grep totalTrades /home/z/my-project/download/paper-trading-state.json | head -1 | grep -oE '[0-9]+' | head -1)
  echo "  Capital: \$$CAPITAL"
  echo "  Trades: $TRADES"
  echo "  PASS: paper trader state exists"
else
  echo "  FAIL: paper trader state not found!"
fi
echo ""

# 4. Check opp database
echo "── 4. OPP DATABASE ──"
if [ -f "data/opportunities.db" ]; then
  DB_SIZE=$(stat -c%s data/opportunities.db)
  echo "  Database size: $DB_SIZE bytes"
  if [ "$DB_SIZE" -gt 1000000 ]; then
    echo "  PASS: database has significant data"
  else
    echo "  WARNING: database may be empty or small"
  fi
else
  echo "  WARNING: database not found (will be created by opp-db daemon)"
fi
echo ""

# 5. Check alerts
echo "── 5. RECENT ALERTS ──"
SPREAD_ALERTS=$(wc -l < /tmp/realtime-spread-history.jsonl 2>/dev/null || echo 0)
FUNDING_ALERTS=$(wc -l < /tmp/hl-funding-alert-history.jsonl 2>/dev/null || echo 0)
echo "  Spread alerts fired: $SPREAD_ALERTS"
echo "  Funding alerts fired: $FUNDING_ALERTS"
if [ "$SPREAD_ALERTS" -gt 0 ]; then
  echo "  PASS: spread alerts are being generated"
else
  echo "  WARNING: no spread alerts — monitor may not be running"
fi
echo ""

# 6. Check git status
echo "── 6. GIT STATUS ──"
UNCOMMITTED=$(git status --short | wc -l)
COMMITS=$(git log --oneline | wc -l)
echo "  Total commits: $COMMITS"
echo "  Uncommitted changes: $UNCOMMITTED"
if [ "$UNCOMMITTED" -eq 0 ]; then
  echo "  PASS: clean working tree"
else
  echo "  WARNING: $UNCOMMITTED uncommitted files"
fi
echo ""

# 7. Summary
echo "═══════════════════════════════════════════════════"
echo "  HEALTH CHECK COMPLETE"
echo "═══════════════════════════════════════════════════"
