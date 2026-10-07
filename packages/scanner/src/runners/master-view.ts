/**
 * Master View — single command showing ALL opportunities across ALL sources.
 *
 * Usage: pnpm --filter @edge/scanner start:master-view
 *
 * Shows:
 *   1. VOOI Price Spread Arbs (instant capture) — top 5
 *   2. VOOI Funding Rate Arbs (8-24h hold) — top 5
 *   3. kHYPE LST Carry Arb
 *   4. Euler HL Lending Arbs — top 3
 *   5. Summary with combined potential
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { VooiClient } from '@edge/vooi-client';
import { HlLstArbScanner } from '../strategies/hl-lst-arb-scanner.js';
import { EulerLendingArbScanner } from '../strategies/euler-lending-arb-scanner.js';
import { getAliasInfo } from '../lib/alias-ticker-map.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..', '..');

try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch {}

const VOOI_VENUES = new Set(['hyperliquid', 'lighter', 'aster', 'extended', 'trade.xyz', 'kinetiq', 'robinhood', 'ondo', 'binance', 'bybit', 'mexc', 'gate']);

async function main() {
  console.log('================================================================');
  console.log('  EDGE-ENGINE MASTER VIEW — ALL Opportunities');
  console.log(`  ${new Date().toISOString()}`);
  console.log('================================================================\n');

  let totalDailyUsd = 0;
  let totalAnnualUsd = 0;
  let totalCapital = 0;

  // ── 1. VOOI Price Spread Arbs ──
  console.log('── 1. VOOI PRICE SPREAD ARBS (INSTANT capture) ──\n');
  try {
    const vooi = new VooiClient({ apiToken: process.env.VOOI_API_TOKEN });
    const r = await vooi.scanArbitrage({
      minFundingSpread: 0, minOpenInterest: 100_000, notionalUsd: 5000,
      orderBy: 'priceSpread', orderDirection: 'desc', limit: 100,
    });

    const opps: Array<{name: string, spreadPct: number, profitUsd: number, buyVenue: string, sellVenue: string, longOi: number, shortOi: number}> = [];
    for (const item of r.items) {
      for (const p of item.pairs) {
        const longOi = Number(p.long.openInterest) * Number(p.long.price);
        const shortOi = Number(p.short.openInterest) * Number(p.short.price);
        if (longOi < 100_000 || shortOi < 100_000) continue;
        if (!VOOI_VENUES.has(p.long.exchange) || !VOOI_VENUES.has(p.short.exchange)) continue;
        const longPrice = Number(p.long.price), shortPrice = Number(p.short.price);
        if (longPrice <= 0 || shortPrice <= 0) continue;
        const spreadPct = Math.abs((longPrice - shortPrice) / Math.min(longPrice, shortPrice)) * 100;
        if (spreadPct < 2.0) continue;
        const info = getAliasInfo(item.asset);
        const name = info ? `${info.realTicker} (${info.realName})` : item.asset;
        opps.push({
          name, spreadPct,
          profitUsd: ((spreadPct - 0.3) / 100) * 5000,
          buyVenue: longPrice < shortPrice ? p.long.exchange : p.short.exchange,
          sellVenue: longPrice < shortPrice ? p.short.exchange : p.long.exchange,
          longOi, shortOi,
        });
      }
    }
    // Deduplicate
    const seen = new Set<string>();
    const unique = opps.filter(o => {
      const key = `${o.name}|${o.buyVenue}|${o.sellVenue}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    unique.sort((a, b) => b.profitUsd - a.profitUsd);

    for (const o of unique.slice(0, 5)) {
      console.log(`  ${o.name.slice(0, 35)}`);
      console.log(`    ${o.buyVenue} -> ${o.sellVenue}  ${o.spreadPct.toFixed(1)}%  $${o.profitUsd.toFixed(0)}/cycle`);
      console.log(`    OI: $${(o.longOi / 1e6).toFixed(0)}M / $${(o.shortOi / 1e6).toFixed(0)}M`);
    }
    const top5 = unique.slice(0, 5).reduce((s, o) => s + o.profitUsd, 0);
    console.log(`\n  Top 5: $${top5.toFixed(0)}/cycle (INSTANT)`);
    console.log(`  At 3 cycles/day: $${(top5 * 3).toFixed(0)}/day = $${(top5 * 3 * 365 / 1000).toFixed(0)}k/yr on $25k\n`);
    totalDailyUsd += top5 * 3;
    totalAnnualUsd += top5 * 3 * 365;
    totalCapital += 25000;
  } catch (e: any) { console.log(`  Error: ${e.message}\n`); }

  // ── 2. VOOI Funding Rate Arbs ──
  console.log('── 2. VOOI FUNDING RATE ARBS (8-24h hold) ──\n');
  try {
    const vooi = new VooiClient({ apiToken: process.env.VOOI_API_TOKEN });
    const r = await vooi.scanArbitrage({
      minFundingSpread: 0, minOpenInterest: 100_000, notionalUsd: 5000,
      orderBy: 'fundingSpread1h', orderDirection: 'desc', limit: 100,
    });

    const opps: Array<{name: string, apr: number, dailyUsd: number, longVenue: string, shortVenue: string}> = [];
    for (const item of r.items) {
      const best = item.pairs[0];
      if (!best) continue;
      const longOi = Number(best.long.openInterest) * Number(best.long.price);
      const shortOi = Number(best.short.openInterest) * Number(best.short.price);
      if (longOi < 100_000 || shortOi < 100_000) continue;
      if (!VOOI_VENUES.has(best.long.exchange) || !VOOI_VENUES.has(best.short.exchange)) continue;
      const apr = best.fundingSpread1h * 24 * 365 * 100;
      if (apr < 100) continue;
      const info = getAliasInfo(item.asset);
      const name = info ? `${info.realTicker} (${info.realName})` : item.asset;
      opps.push({ name, apr, dailyUsd: (apr / 100 / 365) * 5000, longVenue: best.long.exchange, shortVenue: best.short.exchange });
    }
    opps.sort((a, b) => b.dailyUsd - a.dailyUsd);

    for (const o of opps.slice(0, 5)) {
      console.log(`  ${o.name.slice(0, 35)}`);
      console.log(`    ${o.longVenue} -> ${o.shortVenue}  ${o.apr.toFixed(0)}% APR  $${o.dailyUsd.toFixed(0)}/day`);
    }
    const top5 = opps.slice(0, 5).reduce((s, o) => s + o.dailyUsd, 0);
    console.log(`\n  Top 5: $${top5.toFixed(0)}/day = $${(top5 * 365 / 1000).toFixed(0)}k/yr on $25k\n`);
    totalDailyUsd += top5;
    totalAnnualUsd += top5 * 365;
    totalCapital += 25000;
  } catch (e: any) { console.log(`  Error: ${e.message}\n`); }

  // ── 3. kHYPE LST Carry Arb ──
  console.log('── 3. kHYPE LST CARRY ARB (7-day hold) ──\n');
  try {
    const hlLstArb = new HlLstArbScanner({ minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100 });
    const alerts = await hlLstArb.scan();
    for (const a of alerts) {
      const annualProfit = a.estimatedProfitUsd * (365 / 8);
      console.log(`  kHYPE/WHYPE: ${a.discountPct.toFixed(2)}% discount`);
      console.log(`    Profit per 8-day cycle: $${a.estimatedProfitUsd.toFixed(2)}`);
      console.log(`    Annualized: $${annualProfit.toFixed(0)} (${((annualProfit / 5000) * 100).toFixed(0)}% APR)\n`);
      totalAnnualUsd += annualProfit;
      totalCapital += 5000;
    }
  } catch (e: any) { console.log(`  Error: ${e.message}\n`); }

  // ── 4. Euler HL Lending Arb ──
  console.log('── 4. EULER HL LENDING ARB ──\n');
  try {
    const eulerArb = new EulerLendingArbScanner({ minSpreadPct: 2.0, minLiquidityUsd: 50_000, maxSizeUsd: 5_000 });
    const alerts = await eulerArb.scan();
    for (const a of alerts.slice(0, 3)) {
      console.log(`  ${a.assetSymbol}: ${a.spreadPct.toFixed(1)}% spread`);
      console.log(`    Deposit: ${a.depositVault.apyPct.toFixed(2)}%  Borrow: ${a.borrowVault.apyPct.toFixed(2)}%`);
      console.log(`    Profit: $${a.estimatedProfitUsd.toFixed(0)}/yr on $5k\n`);
      totalAnnualUsd += a.estimatedProfitUsd;
      totalCapital += 5000;
    }
  } catch (e: any) { console.log(`  Error: ${e.message}\n`); }

  // ── Summary ──
  console.log('================================================================');
  console.log('  SUMMARY');
  console.log('================================================================');
  console.log(`  Total capital needed: $${totalCapital.toLocaleString()}`);
  console.log(`  Total daily profit:   $${totalDailyUsd.toFixed(0)}/day`);
  console.log(`  Total annual profit:  $${(totalAnnualUsd / 1000).toFixed(0)}k/yr`);
  console.log(`  Combined APR:         ${((totalAnnualUsd / totalCapital) * 100).toFixed(0)}%`);
  console.log('================================================================');
  console.log('\n  BLOCKERS:');
  console.log('  1. VOOI capital deposit ($25-50k) on ultra.vooi.io');
  console.log('  2. Agent wallet ($10k HYPE + USDC) on HyperEVM');
  console.log('  3. Principal approval to go live');
  console.log('\n  Telegram commands: /status /opportunities /vooi /pricespread /khype /euler');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
