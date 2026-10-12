// Cross-Exchange Triangular Arbitrage
// Find triangular arb opportunities:
//   HL perp ↔ HL spot ↔ CEX (Binance/Bybit)
//
// Example:
//   1. Buy BTC on HL spot @ $80,000
//   2. Sell BTC on Binance perp @ $80,100 (0.125% premium)
//   3. Simultaneously buy BTC on HL perp @ $80,050 (hedge)
//   4. Net: capture 0.075% spread (after fees)
//
// Or simpler:
//   1. Buy BTC on HL spot @ $80,000
//   2. Withdraw to Binance (5-30 min)
//   3. Sell on Binance @ $80,100
//   4. Profit: 0.125% - withdrawal fees
//
// This is NOT atomic — has execution risk

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

async function getBinancePrice(symbol: string): Promise<{ bid: number; ask: number; last: number } | null> {
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${symbol}`);
    if (!res.ok) return null;
    const data = await res.json() as any;
    return {
      bid: parseFloat(data.bidPrice),
      ask: parseFloat(data.askPrice),
      last: parseFloat(data.bidPrice), // approximate
    };
  } catch {
    return null;
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Cross-Exchange Triangular Arbitrage Scanner');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get HL perp + spot prices
  console.log('── Loading HL prices ──');
  const perpMeta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const perpUniverse = perpMeta[0].universe || [];
  const perpCtxs = perpMeta[1] || [];

  const hlPerpPrices: Record<string, number> = {};
  for (let i = 0; i < perpUniverse.length; i++) {
    const name = perpUniverse[i].name || '';
    const markPx = parseFloat(perpCtxs[i]?.markPx || '0');
    if (markPx > 0) hlPerpPrices[name] = markPx;
  }

  const spotMeta = await hlInfo({ type: 'spotMetaAndAssetCtxs' });
  const spotUniverse = spotMeta[0].universe || [];
  const spotCtxs = spotMeta[1] || [];
  const spotTokens = spotMeta[0].tokens || [];
  const hlSpotPrices: Record<string, number> = {};
  for (let i = 0; i < spotUniverse.length; i++) {
    let name = spotUniverse[i].name || '';
    if (name.startsWith('@')) {
      const idx = parseInt(name.slice(1));
      if (idx < spotTokens.length) name = spotTokens[idx].name || name;
    }
    const markPx = parseFloat(spotCtxs[i]?.markPx || '0');
    if (markPx > 0 && !name.startsWith('@')) hlSpotPrices[name] = markPx;
  }

  console.log(`  HL perps: ${Object.keys(hlPerpPrices).length}`);
  console.log(`  HL spot: ${Object.keys(hlSpotPrices).length}\n`);

  // 2. Get Binance prices for top pairs
  console.log('── Loading Binance prices ──');
  const binancePairs = [
    { symbol: 'BTC', binance: 'BTCUSDT' },
    { symbol: 'ETH', binance: 'ETHUSDT' },
    { symbol: 'SOL', binance: 'SOLUSDT' },
    { symbol: 'XRP', binance: 'XRPUSDT' },
    { symbol: 'DOGE', binance: 'DOGEUSDT' },
    { symbol: 'AVAX', binance: 'AVAXUSDT' },
    { symbol: 'LINK', binance: 'LINKUSDT' },
    { symbol: 'LTC', binance: 'LTCUSDT' },
    { symbol: 'BCH', binance: 'BCHUSDT' },
    { symbol: 'NEAR', binance: 'NEARUSDT' },
  ];
  const binancePrices: Record<string, { bid: number; ask: number; last: number }> = {};
  for (const p of binancePairs) {
    const px = await getBinancePrice(p.binance);
    if (px) binancePrices[p.symbol] = px;
  }
  console.log(`  Binance: ${Object.keys(binancePrices).length} pairs\n`);

  // 3. Find triangular arb opportunities
  console.log('── Triangular Arb Opportunities ──');
  console.log('Symbol   | HL Perp    | HL Spot    | Binance    | HL Perp-Binance % | HL Spot-Binance % | Action');
  console.log('─────────|────────────|────────────|────────────|───────────────────|───────────────────|──────');

  const opportunities: any[] = [];
  for (const [symbol, binanceData] of Object.entries(binancePrices)) {
    const hlPerp = hlPerpPrices[symbol];
    const hlSpot = hlSpotPrices[symbol];
    if (!hlPerp && !hlSpot) continue;

    const binanceMid = (binanceData.bid + binanceData.ask) / 2;
    const perpSpread = hlPerp ? ((hlPerp - binanceMid) / binanceMid * 100) : 0;
    const spotSpread = hlSpot ? ((hlSpot - binanceMid) / binanceMid * 100) : 0;

    let action = '';
    if (hlPerp && Math.abs(perpSpread) > 0.1) {
      action = perpSpread > 0 ? 'SHORT HL PERP / LONG BINANCE' : 'LONG HL PERP / SHORT BINANCE';
    }
    if (hlSpot && Math.abs(spotSpread) > 0.1) {
      action += (action ? ' + ' : '') + (spotSpread > 0 ? 'SELL HL SPOT / BUY BINANCE' : 'BUY HL SPOT / SELL BINANCE');
    }

    if (action) {
      console.log(`${symbol.padEnd(9)}| $${hlPerp.toFixed(4).padStart(10)}| $${(hlSpot || 0).toFixed(4).padStart(10)}| $${binanceMid.toFixed(4).padStart(10)}| ${perpSpread.toFixed(3).padStart(17)}%| ${spotSpread.toFixed(3).padStart(17)}%| ${action}`);
      opportunities.push({ symbol, hlPerp, hlSpot, binanceMid, perpSpread, spotSpread, action });
    }
  }

  // 4. Top opportunities
  console.log('\n── Top Opportunities (|spread| > 0.1%) ──');
  opportunities.sort((a, b) => Math.max(Math.abs(b.perpSpread), Math.abs(b.spotSpread)) - Math.max(Math.abs(a.perpSpread), Math.abs(a.spotSpread)));
  for (const o of opportunities.slice(0, 10)) {
    console.log(`  ${o.symbol}: HL perp=${o.perpSpread.toFixed(3)}%, HL spot=${o.spotSpread.toFixed(3)}% — ${o.action}`);
  }

  // 5. Strategy economics
  console.log('\n── Strategy Economics ──\n');
  console.log('  Triangular arb is NOT atomic:');
  console.log('    - Buy on HL, withdraw to Binance (5-30 min)');
  console.log('    - Sell on Binance');
  console.log('    - Price risk during withdrawal');
  console.log('');
  console.log('  Better approach: Use CEX-HL funding arb (already built)');
  console.log('    - Hold positions on both venues');
  console.log('    - Capture funding rate differential');
  console.log('    - No withdrawal needed');
  console.log('');
  console.log('  Or: Use VOOI for atomic execution');
  console.log('    - VOOI supports both HL and Binance');
  console.log('    - Atomic paired orders');
  console.log('    - Already integrated');
  console.log('');

  console.log('=== Verdict ===');
  console.log('Triangular arb is COVERED by existing strategies:');
  console.log('  ✅ CEX-HL funding arb (in all-runner.ts)');
  console.log('  ✅ VOOI price spread arb (atomic)');
  console.log('  ✅ CexLikeDex price arb (in all-runner.ts)');
  console.log('');
  console.log('No new strategy needed — reuse existing infrastructure.');
  console.log(`Current opportunities: ${opportunities.length} pairs with spread > 0.1%`);
}

main().catch(console.error);
