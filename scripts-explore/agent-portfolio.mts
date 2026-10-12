// Agent Portfolio Tracker
// Monitor our agent wallet's positions + P&L on HL
// Useful for:
//   - Tracking our own performance
//   - Alerting when positions are at risk
//   - Computing real-time NAV

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

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

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Agent Portfolio Tracker');
  console.log('═══════════════════════════════════════════════════\n');

  const agentAddress = process.env.AGENT_EVM_ADDRESS;
  if (!agentAddress) {
    console.log('❌ AGENT_EVM_ADDRESS not set');
    return;
  }

  console.log(`  Agent address: ${agentAddress}\n`);

  // 1. Get clearing house state (perp positions)
  console.log('── Perp Positions (Clearing House State) ──');
  try {
    const chs = await hlInfo({ type: 'clearingHouseState', user: agentAddress });
    if (chs?.marginSummary) {
      console.log(`  Account value: $${parseFloat(chs.marginSummary.accountValue || '0').toFixed(2)}`);
      console.log(`  Withdrawable: $${parseFloat(chs.marginSummary.withdrawable || '0').toFixed(2)}`);
      console.log(`  Margin used: $${parseFloat(chs.marginSummary.totalMarginUsed || '0').toFixed(2)}`);
      console.log(`  Open positions: ${chs.assetPositions?.length || 0}`);
      if (chs.assetPositions?.length > 0) {
        for (const ap of chs.assetPositions) {
          const pos = ap.position;
          console.log(`    ${pos.coin}: size=${pos.szi} entry=${pos.entryPx} mark=${pos.markPx}`);
        }
      }
    } else {
      console.log(`  No perp positions (response: ${JSON.stringify(chs).substring(0, 200)})`);
    }
  } catch (e: any) {
    console.log(`  Error: ${e.message}`);
  }

  // 2. Get spot positions
  console.log('\n── Spot Positions ──');
  try {
    const spotState = await hlInfo({ type: 'spotClearingHouseState', user: agentAddress });
    if (Array.isArray(spotState)) {
      console.log(`  Spot balances: ${spotState.length}`);
      for (const b of spotState.slice(0, 10)) {
        console.log(`    ${b.coin}: ${b.hold} (total: ${b.total})`);
      }
    } else {
      console.log(`  Response: ${JSON.stringify(spotState).substring(0, 200)}`);
    }
  } catch (e: any) {
    console.log(`  Error: ${e.message}`);
  }

  // 3. Get funding history
  console.log('\n── Funding History (last 30 days) ──');
  try {
    const funding = await hlInfo({ type: 'userFunding', user: agentAddress, startTime: Date.now() - 30 * 24 * 60 * 60 * 1000 });
    if (Array.isArray(funding)) {
      console.log(`  Funding events: ${funding.length}`);
      let totalFunding = 0;
      for (const f of funding.slice(0, 5)) {
        console.log(`    ${new Date(f.time).toISOString()}: ${f.delta} USDC (${f.coin})`);
        totalFunding += parseFloat(f.delta || '0');
      }
      console.log(`  Total funding (last 30d): $${totalFunding.toFixed(2)}`);
    } else {
      console.log(`  Response: ${JSON.stringify(funding).substring(0, 200)}`);
    }
  } catch (e: any) {
    console.log(`  Error: ${e.message}`);
  }

  // 4. Get trade history
  console.log('\n── Trade History (last 30 days) ──');
  try {
    const fills = await hlInfo({ type: 'userFillsByTime', user: agentAddress, startTime: Date.now() - 30 * 24 * 60 * 60 * 1000 });
    if (Array.isArray(fills)) {
      console.log(`  Trades: ${fills.length}`);
      let totalVolume = 0;
      for (const f of fills.slice(0, 5)) {
        const px = parseFloat(f.px);
        const sz = parseFloat(f.sz);
        const notional = px * sz;
        totalVolume += notional;
        console.log(`    ${new Date(f.time).toISOString()}: ${f.side} ${f.coin} ${sz} @ ${px} = $${notional.toFixed(2)}`);
      }
      console.log(`  Total volume (sample): $${totalVolume.toFixed(2)}`);
    } else {
      console.log(`  Response: ${JSON.stringify(fills).substring(0, 200)}`);
    }
  } catch (e: any) {
    console.log(`  Error: ${e.message}`);
  }

  // 5. Get portfolio (historical)
  console.log('\n── Portfolio (Historical) ──');
  try {
    const portfolio = await hlInfo({ type: 'portfolio', user: agentAddress });
    if (Array.isArray(portfolio)) {
      console.log(`  Portfolio items: ${portfolio.length}`);
      for (const p of portfolio) {
        const type = p[0]; // 'day', 'week', 'month'
        const data = p[1];
        if (data?.accountValueHistory) {
          console.log(`    ${type}: ${data.accountValueHistory.length} data points`);
          const latest = data.accountValueHistory[data.accountValueHistory.length - 1];
          if (latest) {
            console.log(`      Latest: ${new Date(latest[0]).toISOString()} = $${latest[1]}`);
          }
        }
      }
    } else {
      console.log(`  Response: ${JSON.stringify(portfolio).substring(0, 200)}`);
    }
  } catch (e: any) {
    console.log(`  Error: ${e.message}`);
  }

  // 6. Get vault equities
  console.log('\n── Vault Equities ──');
  try {
    const vaultEquities = await hlInfo({ type: 'userVaultEquities', user: agentAddress });
    if (Array.isArray(vaultEquities)) {
      console.log(`  Vault positions: ${vaultEquities.length}`);
      for (const v of vaultEquities.slice(0, 5)) {
        console.log(`    ${JSON.stringify(v).substring(0, 100)}`);
      }
    } else {
      console.log(`  Response: ${JSON.stringify(vaultEquities).substring(0, 200)}`);
    }
  } catch (e: any) {
    console.log(`  Error: ${e.message}`);
  }

  console.log('\n── Use Cases ──\n');
  console.log('  1. Real-time NAV tracking');
  console.log('  2. Position risk monitoring (margin ratio)');
  console.log('  3. P&L attribution (which strategies made money)');
  console.log('  4. Daily report to principal');
  console.log('  5. Alert on margin call risk');
  console.log('  6. Track builder code revenue (via funding history)');
}

main().catch(console.error);
