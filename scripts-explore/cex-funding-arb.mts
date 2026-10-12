/**
 * CEX Funding Rate Arb Scanner
 * 
 * Compares HL perp funding rates with CEX funding rates
 * When spread exists, we can arb directly (no VOOI needed)
 * 
 * Strategy:
 *   1. Get HL perp funding rates
 *   2. Get Binance/Bybit/OKX funding rates
 *   3. When HL funding > CEX funding + threshold:
 *      - Short HL perp (receive funding)
 *      - Long CEX perp (pay less funding)
 *      - Net positive funding income
 *   4. Hold until funding converges
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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

async function getBinanceFunding(): Promise<Record<string, { funding: number; nextTime: number }>> {
  try {
    const res = await fetch('https://fapi.binance.com/fapi/v1/premiumRate');
    if (!res.ok) return {};
    const data = await res.json() as any[];
    const result: Record<string, any> = {};
    for (const item of data) {
      const symbol = item.symbol.replace('USDT', '');
      const funding = parseFloat(item.lastFundingRate);
      const nextTime = parseInt(item.nextFundingTime);
      if (Math.abs(funding) > 0.00001) {
        result[symbol] = { funding, nextTime };
      }
    }
    return result;
  } catch { return {}; }
}

async function getBybitFunding(): Promise<Record<string, { funding: number; nextTime: number }>> {
  try {
    const res = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
    if (!res.ok) return {};
    const data = await res.json() as any;
    const result: Record<string, any> = {};
    for (const item of (data?.result?.list || [])) {
      const symbol = item.symbol.replace('USDT', '');
      const funding = parseFloat(item.fundingRate);
      const nextTime = parseInt(item.nextFundingTime || '0');
      if (Math.abs(funding) > 0.00001) {
        result[symbol] = { funding, nextTime };
      }
    }
    return result;
  } catch { return {}; }
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  CEX-HL Funding Rate Arb Scanner');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get HL funding rates
  console.log('── Loading HL Funding Rates ──');
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  
  const hlFunding: Record<string, { funding1h: number; annualApr: number; vol: number }> = {};
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name || '';
    const funding = parseFloat(ctxs[i]?.funding || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (funding !== 0 && vol > 1_000_000) {
      hlFunding[name] = {
        funding1h: funding,
        annualApr: funding * 24 * 365 * 100,
        vol,
      };
    }
  }
  console.log(`  HL: ${Object.keys(hlFunding).length} perps with funding`);

  // 2. Get Binance funding rates
  console.log('── Loading Binance Funding Rates ──');
  const binanceFunding = await getBinanceFunding();
  console.log(`  Binance: ${Object.keys(binanceFunding).length} pairs`);

  // 3. Get Bybit funding rates
  console.log('── Loading Bybit Funding Rates ──');
  const bybitFunding = await getBybitFunding();
  console.log(`  Bybit: ${Object.keys(bybitFunding).length} pairs`);

  // 4. Find funding rate arbitrage opportunities
  console.log('\n── Funding Rate Arb Opportunities ──\n');
  
  const opportunities: any[] = [];
  
  for (const [symbol, hl] of Object.entries(hlFunding)) {
    const binance = binanceFunding[symbol];
    const bybit = bybitFunding[symbol];
    
    // HL vs Binance
    if (binance) {
      // Binance funding is per 8h, HL is per 1h
      const binanceFunding1h = binance.funding / 8;
      const spread1h = hl.funding1h - binanceFunding1h;
      const annualSpread = spread1h * 24 * 365 * 100;
      
      if (Math.abs(annualSpread) > 10) {
        opportunities.push({
          symbol,
          hlFunding: hl.funding1h * 100,
          binanceFunding: binanceFunding1h * 100,
          spread1h: spread1h * 100,
          annualApr: annualSpread,
          hlVol: hl.vol,
          venue1: 'HL',
          venue2: 'Binance',
          direction: spread1h > 0 ? 'SHORT HL / LONG BINANCE' : 'LONG HL / SHORT BINANCE',
        });
      }
    }
    
    // HL vs Bybit
    if (bybit) {
      const bybitFunding1h = bybit.funding / 8;
      const spread1h = hl.funding1h - bybitFunding1h;
      const annualSpread = spread1h * 24 * 365 * 100;
      
      if (Math.abs(annualSpread) > 10) {
        opportunities.push({
          symbol,
          hlFunding: hl.funding1h * 100,
          bybitFunding: bybitFunding1h * 100,
          spread1h: spread1h * 100,
          annualApr: annualSpread,
          hlVol: hl.vol,
          venue1: 'HL',
          venue2: 'Bybit',
          direction: spread1h > 0 ? 'SHORT HL / LONG BYBIT' : 'LONG HL / SHORT BYBIT',
        });
      }
    }
  }
  
  // Sort by annual APR
  opportunities.sort((a, b) => Math.abs(b.annualApr) - Math.abs(a.annualApr));
  
  console.log(`Found ${opportunities.length} funding arb opportunities (>10% APR)\n`);
  console.log('Symbol     | HL 1h%   | CEX 1h%  | Spread 1h | Annual APR | Direction                  | HL Vol');
  console.log('───────────|──────────|──────────|───────────|────────────|────────────────────────────|───────');
  
  for (const o of opportunities.slice(0, 20)) {
    const cexFunding = o.binanceFunding || o.bybitFunding;
    const cexName = o.venue2;
    console.log(`${o.symbol.padEnd(10)}| ${(o.hlFunding).toFixed(4).padStart(8)}%| ${cexFunding.toFixed(4).padStart(8)}%| ${o.spread1h.toFixed(4).padStart(9)}%| ${o.annualApr.toFixed(0).padStart(10)}%| ${o.direction.padEnd(26)}| $${(o.hlVol/1e6).toFixed(1)}M`);
  }

  // 5. Economics
  console.log('\n── Arb Economics ──\n');
  const top5 = opportunities.slice(0, 5);
  let totalDailyIncome = 0;
  for (const o of top5) {
    const dailyIncome = 5000 * Math.abs(o.spread1h) / 100 * 24; // $5k per position, 24h
    totalDailyIncome += dailyIncome;
    console.log(`  ${o.symbol} ${o.venue1}↔${o.venue2}: ${o.annualApr.toFixed(0)}% APR → $${dailyIncome.toFixed(2)}/day on $5k`);
  }
  console.log(`\n  Top 5 total: $${totalDailyIncome.toFixed(2)}/day = $${(totalDailyIncome * 365).toFixed(0)}/yr`);
  console.log(`  Capital needed: $25k (5 × $5k positions)`);
  console.log(`  APR: ${(totalDailyIncome * 365 / 25000 * 100).toFixed(0)}%`);

  console.log('\n── Requirements ──\n');
  console.log('  1. HL account with USDC (for HL perp leg)');
  console.log('  2. Binance/Bybit account with USDT (for CEX perp leg)');
  console.log('  3. Both accounts need API keys for automated trading');
  console.log('  4. Capital: $5k per position, $25k total');
  console.log('');
  console.log('  This is REAL delta-neutral arbitrage:');
  console.log('    - Long on one venue, short on other');
  console.log('    - Net delta = 0 (no directional risk)');
  console.log('    - Profit = funding rate differential');
}

main().catch(console.error);
