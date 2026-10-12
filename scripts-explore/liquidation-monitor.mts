// HL Perp Liquidation Hunter — Phase 1: Position Monitor
//
// Scans top traders' positions on HL perps to find underwater positions
// that can be liquidated for profit
//
// Approach:
//   1. Get top traders by volume (from leaderboard)
//   2. For each trader, fetch their open positions
//   3. Calculate margin ratio (account value / maintenance margin)
//   4. Alert when margin ratio < 1.5 (approaching liquidation)
//   5. If margin ratio < 1.0 (already liquidatable), alert with action

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..');

try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch {}

const HL_API = 'https://api.hyperliquid.xyz/info';

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Get top traders from leaderboard
async function getTopTraders(limit: number = 50): Promise<string[]> {
  try {
    // HL leaderboard endpoint (may not exist publicly, try anyway)
    const res = await fetch(`${HL_API}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'leaderboard',
        period: 'alltime',
      }),
    });
    if (!res.ok) return [];
    const data = await res.json() as any[];
    return (data || []).slice(0, limit).map((t: any) => t.address || t.ethAddress).filter(Boolean);
  } catch {
    return [];
  }
}

// Get user's clearing house state (positions + margin)
async function getUserState(user: string): Promise<any> {
  return await hlInfo({ type: 'clearingHouseState', user });
}

// Get user's funding ledger (for additional context)
async function getUserFunding(user: string): Promise<any> {
  return await hlInfo({ type: 'userFunding', user });
}

// Calculate margin ratio
function calculateMarginRatio(userState: any): { ratio: number; accountValue: number; marginUsed: number; totalNotional: number } {
  const marginSummary = userState?.marginSummary || {};
  const accountValue = parseFloat(marginSummary.accountValue || '0');
  const marginUsed = parseFloat(marginSummary.totalMarginUsed || '0');
  const positions = userState?.assetPositions || [];
  let totalNotional = 0;
  for (const p of positions) {
    const pos = p.position;
    const szi = parseFloat(pos.szi || '0');
    const entryPx = parseFloat(pos.entryPx || '0');
    totalNotional += Math.abs(szi * entryPx);
  }
  // margin ratio = account value / margin used
  // if < 1, position is liquidatable
  const ratio = marginUsed > 0 ? accountValue / marginUsed : Infinity;
  return { ratio, accountValue, marginUsed, totalNotional };
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HL Perp Liquidation Hunter — Phase 1 Monitor');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Try to get top traders from leaderboard
  console.log('── Fetching HL Leaderboard ──');
  const topTraders = await getTopTraders(50);
  console.log(`  Got ${topTraders.length} traders from leaderboard`);

  // If leaderboard empty, use known HL addresses (whales from public data)
  const knownWhales = [
    '0x0000000000000000000000000000000000000000', // placeholder
  ];
  const users = topTraders.length > 0 ? topTraders : knownWhales;
  console.log(`  Scanning ${users.length} addresses\n`);

  // 2. For each user, fetch position state
  console.log('── User Position Scan ──');
  let scanned = 0;
  let withPositions = 0;
  let approachingLiq = 0;
  let liquidatable = 0;
  const alerts: any[] = [];

  for (const user of users.slice(0, 30)) { // limit to 30 to avoid rate limit
    if (!user || user === '0x0000000000000000000000000000000000000000') continue;
    scanned++;
    try {
      const state = await getUserState(user);
      const { ratio, accountValue, marginUsed, totalNotional } = calculateMarginRatio(state);
      const positions = state?.assetPositions || [];

      if (positions.length === 0) continue;
      withPositions++;

      const status = ratio < 1.0 ? 'LIQUIDATABLE' : ratio < 1.5 ? 'APPROACHING' : 'OK';
      const flag = ratio < 1.0 ? ' 🚨' : ratio < 1.5 ? ' ⚠️' : '';

      if (ratio < 1.5) {
        if (ratio < 1.0) liquidatable++;
        else approachingLiq++;
        alerts.push({
          user: user.substring(0, 10) + '...',
          ratio,
          accountValue,
          marginUsed,
          totalNotional,
          positions: positions.length,
          status,
        });
      }

      console.log(`  ${user.substring(0, 10).padEnd(12)} ratio=${ratio.toFixed(2).padStart(6)}  acct=$${accountValue.toFixed(0).padStart(10)}  margin=$${marginUsed.toFixed(0).padStart(10)}  pos=${positions.length}  [${status}]${flag}`);

      await new Promise(r => setTimeout(r, 200)); // rate limit
    } catch (e: any) {
      console.log(`  ${user.substring(0, 10).padEnd(12)} ERROR: ${e.message}`);
    }
  }

  // 3. Summary
  console.log('\n── Scan Summary ──');
  console.log(`  Total scanned: ${scanned}`);
  console.log(`  With positions: ${withPositions}`);
  console.log(`  Approaching liquidation (ratio < 1.5): ${approachingLiq}`);
  console.log(`  Liquidatable (ratio < 1.0): ${liquidatable}`);

  // 4. Actionable alerts
  console.log('\n── Actionable Alerts ──');
  if (alerts.length === 0) {
    console.log('  ✅ No liquidatable positions found');
    console.log('  (Need to scan more addresses OR leaderboard API not accessible)');
  } else {
    for (const a of alerts.sort((x, y) => x.ratio - y.ratio).slice(0, 10)) {
      console.log(`  ${a.user} ratio=${a.ratio.toFixed(2)} [${a.status}]`);
      console.log(`    Account: $${a.accountValue.toFixed(0)} | Margin used: $${a.marginUsed.toFixed(0)}`);
      console.log(`    Positions: ${a.positions} | Total notional: $${a.totalNotional.toFixed(0)}`);
      if (a.status === 'LIQUIDATABLE') {
        const potentialProfit = a.totalNotional * 0.015; // 1.5% liquidation bonus
        console.log(`    💰 POTENTIAL PROFIT: $${potentialProfit.toFixed(0)} (1.5% bonus on $${a.totalNotional.toFixed(0)})`);
      }
    }
  }

  // 5. Phase 1 status
  console.log('\n── Phase 1 Status ──');
  console.log('  ✅ Position monitor framework built');
  console.log('  ✅ Margin ratio calculator built');
  console.log('  ✅ Alert system built');
  console.log('  🔲 Need: Better trader address source (leaderboard API may be private)');
  console.log('  🔲 Need: Real-time webhook (currently polling)');
  console.log('  🔲 Need: Liquidation tx builder (Phase 2)');
  console.log('  🔲 Need: Position closer (Phase 3)');
  console.log('');
  console.log('NEXT STEPS:');
  console.log('  1. Find better address source (HL stats API, on-chain analytics)');
  console.log('  2. Add webhook for real-time updates');
  console.log('  3. Build Phase 2 (executor) once we have address source');
}

main().catch(console.error);
