#!/bin/bash
# Daily Operations Script — run this at the start of each shift
# This is the "manager's morning routine"

cd /home/z/my-project/edge-engine

echo "=================================================="
echo "  EDGE ENGINE — DAILY OPERATIONS"
echo "  $(date -Iseconds)"
echo "=================================================="
echo ""

# 1. Health check
echo "── 1. HEALTH CHECK ──"
bash scripts-explore/system-health-check.sh
echo ""

# 2. Restart dead daemons
echo "── 2. DAEMON STATUS ──"
tsx_count=$(ps aux | grep -E "tsx" | grep -v grep | wc -l)
echo "  tsx processes: $tsx_count"
if [ "$tsx_count" -lt 15 ]; then
  echo "  WARNING: Low process count — launching all daemons"
  bash scripts-explore/launch-all-daemons.sh
fi
echo ""

# 3. Paper trader status
echo "── 3. PAPER TRADER ──"
if [ -f /home/z/my-project/download/paper-trading-state.json ]; then
  capital=$(grep currentCapital /home/z/my-project/download/paper-trading-state.json | head -1 | grep -oE '[0-9.]+' | head -1)
  pnl=$(grep realizedPnl /home/z/my-project/download/paper-trading-state.json | head -1 | grep -oE '[0-9.]+' | head -1)
  trades=$(grep totalTrades /home/z/my-project/download/paper-trading-state.json | head -1 | grep -oE '[0-9]+' | head -1)
  echo "  Capital: \$$capital"
  echo "  Realized P&L: +\$$pnl"
  echo "  Total trades: $trades"
fi
echo ""

# 4. Generate daily report
echo "── 4. DAILY REPORT ──"
npx tsx scripts-explore/master-daily-report.mts 2>&1 | tail -3
echo ""

# 5. Commit and push
echo "── 5. GIT STATUS ──"
commits=$(git log --oneline | wc -l)
changes=$(git status --short | wc -l)
echo "  Commits: $commits"
echo "  Uncommitted: $changes"
if [ "$changes" -gt 0 ]; then
  git add -A
  git commit -m "daily ops: auto-commit at $(date -Iseconds)" 2>&1 | tail -1
  git push 2>&1 | tail -1
fi
echo ""

echo "=================================================="
echo "  DAILY OPERATIONS COMPLETE"
echo "=================================================="
