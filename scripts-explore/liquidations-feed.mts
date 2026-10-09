// HL Liquidations Feed — query recent liquidation events
// This shows us what liquidations are happening RIGHT NOW on HL

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

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HL Liquidations Feed');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Try the allLiquidations endpoint
  console.log('── Recent Liquidations (all markets) ──');
  try {
    const liqs = await hlInfo({
      type: 'liquidations',
      startTime: Date.now() - 24 * 60 * 60 * 1000, // last 24h
    });
    if (Array.isArray(liqs) && liqs.length > 0) {
      console.log(`  Got ${liqs.length} liquidation events in last 24h\n`);
      // Show last 20
      const sorted = liqs.sort((a: any, b: any) => (b.time || 0) - (a.time || 0));
      for (const l of sorted.slice(0, 20)) {
        const time = new Date(l.time).toISOString().substring(11, 19);
        const coin = l.coin || l.symbol || '?';
        const side = l.side || (parseFloat(l.szi || '0') > 0 ? 'LONG' : 'SHORT');
        const szi = Math.abs(parseFloat(l.szi || '0'));
        const px = parseFloat(l.markPx || l.price || '0');
        const notional = szi * px;
        const user = (l.user || '0x?').substring(0, 10);
        console.log(`  ${time} ${coin.padEnd(8)} ${side.padEnd(5)} sz=${szi.toFixed(4).padStart(10)} px=$${px.toFixed(4).padStart(10)} notional=$${notional.toFixed(0).padStart(10)} user=${user}`);
      }
      // Stats
      const totalNotional = liqs.reduce((sum: number, l: any) => {
        const szi = Math.abs(parseFloat(l.szi || '0'));
        const px = parseFloat(l.markPx || l.price || '0');
        return sum + szi * px;
      }, 0);
      console.log(`\n  Total liquidated (24h): $${(totalNotional/1e6).toFixed(2)}M`);
      console.log(`  Avg per liquidation: $${(totalNotional/liqs.length).toFixed(0)}`);

      // Group by coin
      const byCoin: Record<string, number> = {};
      for (const l of liqs) {
        const coin = l.coin || '?';
        const szi = Math.abs(parseFloat(l.szi || '0'));
        const px = parseFloat(l.markPx || l.price || '0');
        byCoin[coin] = (byCoin[coin] || 0) + szi * px;
      }
      const sortedCoins = Object.entries(byCoin).sort((a, b) => b[1] - a[1]);
      console.log('\n  Top 10 coins by liquidation volume:');
      for (const [coin, vol] of sortedCoins.slice(0, 10)) {
        console.log(`    ${coin.padEnd(10)} $${(vol/1000).toFixed(0)}k`);
      }

      // Liquidator bonus estimate
      const totalBonus = totalNotional * 0.015; // 1.5% average
      console.log(`\n  Estimated liquidator bonus pool (24h): $${(totalBonus/1000).toFixed(0)}k`);
      console.log(`  Annual run rate: $${(totalBonus * 365 / 1e6).toFixed(1)}M`);
    } else {
      console.log(`  No liquidations returned (or wrong API): ${JSON.stringify(liqs).substring(0, 200)}`);
    }
  } catch (e: any) {
    console.log(`  Error: ${e.message}`);
  }

  // 2. Try per-coin liquidations (BTC)
  console.log('\n── BTC Liquidations (last 7 days) ──');
  try {
    const btcLiqs = await hlInfo({
      type: 'liquidations',
      coin: 'BTC',
      startTime: Date.now() - 7 * 24 * 60 * 60 * 1000,
    });
    if (Array.isArray(btcLiqs)) {
      console.log(`  Got ${btcLiqs.length} BTC liquidation events in last 7d`);
      if (btcLiqs.length > 0) {
        const totalNotional = btcLiqs.reduce((sum: number, l: any) => {
          const szi = Math.abs(parseFloat(l.szi || '0'));
          const px = parseFloat(l.markPx || l.price || '0');
          return sum + szi * px;
        }, 0);
        console.log(`  Total BTC liquidated: $${(totalNotional/1e6).toFixed(2)}M`);
      }
    }
  } catch (e: any) {
    console.log(`  Error: ${e.message}`);
  }

  // 3. Try alternative: recent trades feed (shows liquidations as trades)
  console.log('\n── Recent Trades (BTC, last 1h) ──');
  try {
    const trades = await hlInfo({
      type: 'trades',
      coin: 'BTC',
      startTime: Date.now() - 60 * 60 * 1000,
    });
    if (Array.isArray(trades)) {
      console.log(`  Got ${trades.length} BTC trades in last 1h`);
      // Filter for large trades (potential liquidations)
      const large = trades.filter((t: any) => {
        const sz = parseFloat(t.sz || '0');
        const px = parseFloat(t.px || '0');
        return sz * px > 100_000; // > $100k
      });
      console.log(`  Large trades (>$100k): ${large.length}`);
      for (const t of large.slice(0, 5)) {
        const time = new Date(t.time).toISOString().substring(11, 19);
        const sz = parseFloat(t.sz || '0');
        const px = parseFloat(t.px || '0');
        const side = t.side || '?';
        console.log(`    ${time} ${side.padEnd(4)} sz=${sz.toFixed(4)} px=$${px.toFixed(2)} notional=$${(sz*px).toFixed(0)}`);
      }
    }
  } catch (e: any) {
    console.log(`  Error: ${e.message}`);
  }

  // 4. Phase 1 strategy assessment
  console.log('\n── Phase 1 Assessment ──');
  console.log('  If we can see liquidations in real-time:');
  console.log('    1. Track which users get liquidated');
  console.log('    2. Build pattern: which size traders get liquidated most');
  console.log('    3. Pre-position liquidation txs for these users');
  console.log('    4. When their margin crosses threshold, fire liquidate()');
  console.log('');
  console.log('  Real-time monitoring: WebSocket subscription to liquidations feed');
  console.log('  Latency requirement: < 100ms (compete with Wintermute)');
  console.log('  Capital requirement: $100k USDC floating');
  console.log('  Expected capture: 5-15% of liquidation bonus pool');
}

main().catch(console.error);
