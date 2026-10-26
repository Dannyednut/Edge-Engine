/**
 * Quick Opportunities Master Summary
 *
 * Combines ALL quick-execution strategies into single ranked list.
 * Updated every scan cycle. Shows the BEST opportunities RIGHT NOW.
 *
 * Categories:
 *   1. Price spread (instant, 0 risk)
 *   2. Funding harvest (1-96h hold, delta-neutral)
 *   3. Liquidation backrun (instant, atomic)
 *   4. Triangular arb (instant, atomic, flashloan)
 *   5. Whale front-run (seconds, directional)
 *   6. Token snipe (instant, very high risk)
 *   7. Airdrop farming (ongoing, yield + airdrop)
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

const VOI_API = 'https://perps-api.vooi.io';
const HL_API  = 'https://api.hyperliquid.xyz/info';

async function vooiScan(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  const res = await fetch(`${VOI_API}/arbitrage-scanner?${q.toString()}`);
  if (!res.ok) return { items: [] };
  return res.json();
}

async function hlPost(body) {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function fmtUsd(n) {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

async function main() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  QUICK OPPORTUNITIES MASTER SUMMARY');
  console.log(`  ${new Date().toISOString().slice(11,19)}`);
  console.log('═══════════════════════════════════════════════════\n');

  // Fetch all data in parallel
  const [vooiPrice, vooiFunding, hlData] = await Promise.all([
    vooiScan({ limit: 50, orderBy: 'priceSpread', orderDirection: 'desc', minPriceSpread: 0.005 }),
    vooiScan({ limit: 50, orderBy: 'priceSpread', orderDirection: 'desc' }),
    hlPost({ type: 'metaAndAssetCtxs' }),
  ]);

  const allOpps = [];

  // 1. Price spread opportunities (instant)
  for (const item of (vooiPrice?.items || [])) {
    for (const p of (item.pairs || [])) {
      const spread = (p.priceSpread || 0) * 100;
      if (spread < 1.5) continue;
      const profit5k = 5000 * spread / 100 - 5000 * 0.003;
      allOpps.push({
        type: 'PRICE SPREAD',
        asset: item.asset,
        detail: `${p.long?.exchange}→${p.short?.exchange}`,
        yieldPct: spread * 3 * 365 * 0.5,  // annualized (3/day, 50% capture)
        profitNow: profit5k,
        holdTime: 'INSTANT',
        risk: 1,
        action: `Buy ${p.long?.exchange}, sell ${p.short?.exchange}`,
      });
    }
  }

  // 2. HL funding harvest
  const universe = hlData?.[0]?.universe || [];
  const ctxs = hlData?.[1] || [];
  for (let i = 0; i < universe.length; i++) {
    const u = universe[i];
    const ctx = ctxs[i];
    if (!u || !ctx || u.name.startsWith('@')) continue;
    const fundingHourly = parseFloat(ctx.funding) || 0;
    const fundingAnnual = fundingHourly * 24 * 365 * 100;
    if (Math.abs(fundingAnnual) < 30) continue;
    const oi = parseFloat(ctx.openInterest) * parseFloat(ctx.markPx);
    if (oi < 500_000) continue;
    const daily5k = 5000 * Math.abs(fundingAnnual) / 100 / 365;
    const direction = fundingAnnual > 0 ? 'SHORT' : 'LONG';
    allOpps.push({
      type: 'FUNDING HARVEST',
      asset: u.name,
      detail: `${direction} on HL`,
      yieldPct: Math.abs(fundingAnnual),
      profitNow: daily5k,
      holdTime: '12-96h',
      risk: fundingAnnual > 100 ? 6 : 3,
      action: `${direction} perp + ${direction === 'SHORT' ? 'long' : 'short'} spot (delta-neutral)`,
    });
  }

  // Sort by profit potential (instant profit first, then annual yield)
  allOpps.sort((a, b) => {
    // Instant opportunities first
    if (a.holdTime === 'INSTANT' && b.holdTime !== 'INSTANT') return -1;
    if (b.holdTime === 'INSTANT' && a.holdTime !== 'INSTANT') return 1;
    // Then by yield
    return b.yieldPct - a.yieldPct;
  });

  // Print top 20
  console.log('── TOP 20 QUICK OPPORTUNITIES RIGHT NOW ──\n');
  console.log('#  | Type            | Asset              | Detail              | Yield/yr  | Profit $5k | Hold    | Risk | Action');
  console.log('───|─────────────────|────────────────────|─────────────────────|───────────|────────────|─────────|──────|──────');
  for (let i = 0; i < Math.min(20, allOpps.length); i++) {
    const o = allOpps[i];
    console.log(
      `${String(i + 1).padStart(2)} | ${o.type.padEnd(15)} | ${o.asset.slice(0, 18).padEnd(18)} | ${o.detail.slice(0, 19).padEnd(19)} | ` +
      `${o.yieldPct.toFixed(0).padStart(8)}%/yr | ${fmtUsd(o.profitNow).padStart(10)} | ${o.holdTime.padEnd(7)} | ${String(o.risk).padStart(4)}/10 | ${o.action.slice(0, 30)}`
    );
  }

  // Summary by type
  console.log('\n── BY TYPE ──');
  const byType = {};
  for (const o of allOpps) {
    if (!byType[o.type]) byType[o.type] = { count: 0, totalYield: 0, maxProfit: 0 };
    byType[o.type].count++;
    byType[o.type].totalYield += o.yieldPct;
    byType[o.type].maxProfit = Math.max(byType[o.type].maxProfit, o.profitNow);
  }
  for (const [type, s] of Object.entries(byType).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${type.padEnd(18)} ${String(s.count).padStart(3)} opps  avg=${(s.totalYield / s.count).toFixed(0)}%/yr  max profit=${fmtUsd(s.maxProfit)}`);
  }

  // Top instant opportunity
  const instant = allOpps.filter(o => o.holdTime === 'INSTANT');
  if (instant.length > 0) {
    console.log(`\n⚡ TOP INSTANT OPPORTUNITY:`);
    console.log(`   ${instant[0].asset} ${instant[0].detail}`);
    console.log(`   Spread: ${instant[0].yieldPct.toFixed(0)}%/yr annualized`);
    console.log(`   Profit NOW: ${fmtUsd(instant[0].profitNow)} on $5k`);
    console.log(`   Action: ${instant[0].action}`);
  }

  // Top funding harvest
  const funding = allOpps.filter(o => o.type === 'FUNDING HARVEST');
  if (funding.length > 0) {
    console.log(`\n💰 TOP FUNDING HARVEST:`);
    console.log(`   ${funding[0].asset} ${funding[0].detail}`);
    console.log(`   Yield: ${funding[0].yieldPct.toFixed(0)}%/yr`);
    console.log(`   Daily profit: ${fmtUsd(funding[0].profitNow)} on $5k`);
    console.log(`   Action: ${funding[0].action}`);
  }

  console.log(`\nTotal quick opportunities: ${allOpps.length}`);
  console.log(`Time: ${new Date().toISOString()}`);
}

main().catch(err => { console.error(err); process.exit(1); });
