/**
 * Perp-Spot Basis Trade Executor
 *
 * Delta-neutral basis trade:
 *   - LONG spot (HyperEVM spot market or other DEX/CEX)
 *   - SHORT perp (HL perp)
 *   - Capture funding payments as yield
 *
 * Or inverse:
 *   - SHORT spot (borrow + sell)
 *   - LONG perp
 *   - Capture negative funding payments
 *
 * Perpetual futures typically trade at a premium/discount to spot.
 * Funding rate compensates the difference. By being long spot + short perp:
 *   - If perp > spot: positive funding (longs pay shorts) → we earn
 *   - If perp < spot: negative funding (shorts pay longs) → we'd lose
 *
 * We only execute when funding is favorable.
 *
 * Inputs:
 *   - HL perp funding rates (live)
 *   - Spot prices (HL spot market, HyperEVM)
 *
 * Output:
 *   - Ranked list of basis trade opportunities
 *   - Execution plan for each
 *   - Expected yield, risk, capital requirement
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

const HL_API = 'https://api.hyperliquid.xyz/info';

interface BasisOpp {
  rank: number;
  coin: string;
  perpPrice: number;
  spotPrice: number;
  basisPct: number;          // (perp - spot) / spot * 100
  fundingAnnualPct: number;
  expectedYieldPct: number;  // net yield after costs
  direction: 'LONG_SPOT_SHORT_PERP' | 'LONG_PERP_SHORT_SPOT';
  dailyProfitOn5k: number;
  riskScore: number;
  capitalRequired: number;
  executionSteps: string[];
}

async function hlPost(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

async function getSpotMarkets(): Promise<Array<{ name: string; spotMarkPx: number }>> {
  try {
    // HL spot meta — but this only returns PURR/USDC and @-indices
    // We need to use spotMeta + spotAssetCtxs combined with tokens mapping
    // For now, also use the regular perp prices as a fallback
    // (Most perp coins don't have spot markets on HL — we'd use external CEX/DEX)

    // Get HL spot markets (limited but available)
    const r = await hlPost({ type: 'spotMetaAndAssetCtxs' });
    const meta = r?.[0];
    const ctxs = r?.[1];
    const result: Array<{ name: string; spotMarkPx: number }> = [];

    if (meta?.universe && Array.isArray(ctxs)) {
      for (let i = 0; i < meta.universe.length; i++) {
        const u = meta.universe[i];
        const ctx = ctxs[i];
        if (!u || !ctx) continue;
        if (u.name.startsWith('@')) continue;
        const markPx = parseFloat(ctx.markPx || ctx.midPx || '0');
        if (markPx > 0) {
          const baseAsset = u.name.split('/')[0];
          result.push({ name: baseAsset, spotMarkPx: markPx });
        }
      }
    }

    // Also include HL perp oracle prices as "spot" approximation
    // (HL perp oracle price tracks the underlying spot)
    const perpMeta = await hlPost({ type: 'metaAndAssetCtxs' });
    const universe = perpMeta?.[0]?.universe || [];
    const perpCtxs = perpMeta?.[1] || [];
    for (let i = 0; i < universe.length; i++) {
      const u = universe[i];
      const ctx = perpCtxs[i];
      if (!u || !ctx || u.name.startsWith('@')) continue;
      const oraclePx = parseFloat(ctx.oraclePx);
      if (oraclePx > 0) {
        // Use oracle as spot price (this is the index price HL uses for funding calc)
        const exists = result.find(r => r.name === u.name);
        if (!exists) {
          result.push({ name: u.name, spotMarkPx: oraclePx });
        }
      }
    }

    return result;
  } catch (e) {
    console.error('[spot] error:', e);
    return [];
  }
}

async function getPerpMarkets(): Promise<Array<{ name: string; perpMarkPx: number; fundingHourly: number; fundingAnnual: number; oi: number }>> {
  try {
    const r = await hlPost({ type: 'metaAndAssetCtxs' });
    const universe = r?.[0]?.universe || [];
    const ctxs = r?.[1] || [];
    const result: any[] = [];
    for (let i = 0; i < universe.length; i++) {
      const u = universe[i];
      const ctx = ctxs[i];
      if (!u || !ctx || u.name.startsWith('@')) continue;
      const markPx = parseFloat(ctx.markPx);
      const fundingHourly = parseFloat(ctx.funding) || 0;
      const fundingAnnual = fundingHourly * 24 * 365 * 100;
      const oi = parseFloat(ctx.openInterest) * markPx;
      result.push({
        name: u.name,
        perpMarkPx: markPx,
        fundingHourly,
        fundingAnnual,
        oi,
      });
    }
    return result;
  } catch (e) {
    console.error('[perp] error:', e);
    return [];
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Perp-Spot Basis Trade Scanner');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════\n');

  const [spot, perps] = await Promise.all([
    getSpotMarkets(),
    getPerpMarkets(),
  ]);

  console.log(`Found ${spot.length} spot markets and ${perps.length} perp markets on HL\n`);

  // Find matching markets (spot name = perp name + " spot" suffix on HL, or just same name)
  // HL spot names are like "BTC" while perps are also "BTC"
  // Actually HL spot uses "@1" prefixes for spot indices — but coins use same name
  const opps: BasisOpp[] = [];

  for (const p of perps) {
    // Try to find spot market for this perp
    const matchingSpot = spot.find(s => s.name === p.name);
    if (!matchingSpot) continue;

    const basisPct = (p.perpMarkPx - matchingSpot.spotMarkPx) / matchingSpot.spotMarkPx * 100;
    const absBasis = Math.abs(basisPct);

    // Only consider if basis or funding is significant
    if (absBasis < 0.05 && Math.abs(p.fundingAnnual) < 20) continue;
    if (p.oi < 500_000) continue;

    // Funding positive → perp trades at premium → long spot + short perp
    // Funding negative → perp at discount → long perp + short spot (need to borrow)
    const direction = p.fundingAnnual > 0
      ? 'LONG_SPOT_SHORT_PERP'
      : 'LONG_PERP_SHORT_SPOT';

    // Net yield = funding - costs
    // Costs: ~0.15% entry/exit for both legs = 0.6% total round trip
    // If borrow needed for short spot: +2%/yr typical borrow rate
    const costRoundTrip = 0.6;  // %
    const borrowCostAnnual = direction === 'LONG_PERP_SHORT_SPOT' ? 2.0 : 0;
    const expectedYield = Math.abs(p.fundingAnnual) - borrowCostAnnual - (costRoundTrip / 30 * 365 / 12);  // amortize cost over 30d hold

    if (expectedYield < 5) continue;

    const dailyProfit5k = 5000 * expectedYield / 100 / 365;
    const riskScore = Math.min(10, Math.max(1, 3 + Math.floor(absBasis * 10)));

    const executionSteps = direction === 'LONG_SPOT_SHORT_PERP'
      ? [
          `1. Buy ${p.name} spot at ${matchingSpot.spotMarkPx} ($5k worth)`,
          `2. Short ${p.name} perp at ${p.perpMarkPx} ($5k worth)`,
          `3. Hold position to collect funding`,
          `4. Funding rate: ${p.fundingHourly * 100}%/hr (${p.fundingAnnual.toFixed(0)}%/yr)`,
          `5. Net delta: 0 (fully hedged)`,
          `6. Close both legs after 12-96h or when funding flips`,
        ]
      : [
          `1. Borrow ${p.name} spot (cost ~2%/yr)`,
          `2. Sell ${p.name} spot at ${matchingSpot.spotMarkPx} ($5k worth)`,
          `3. Long ${p.name} perp at ${p.perpMarkPx} ($5k worth)`,
          `4. Hold position to collect negative funding`,
          `5. Funding rate: ${p.fundingHourly * 100}%/hr (${p.fundingAnnual.toFixed(0)}%/yr)`,
          `6. Net delta: 0 (fully hedged)`,
          `7. Close both legs after 12-96h or when funding flips`,
        ];

    opps.push({
      rank: 0,
      coin: p.name,
      perpPrice: p.perpMarkPx,
      spotPrice: matchingSpot.spotMarkPx,
      basisPct,
      fundingAnnualPct: p.fundingAnnual,
      expectedYieldPct: expectedYield,
      direction,
      dailyProfitOn5k: dailyProfit5k,
      riskScore,
      capitalRequired: 5000,
      executionSteps,
    });
  }

  // Rank by expected yield
  opps.sort((a, b) => b.expectedYieldPct - a.expectedYieldPct);
  opps.forEach((o, i) => { o.rank = i + 1; });

  console.log('── TOP 20 PERP-SPOT BASIS TRADE OPPORTUNITIES ──');
  console.log('');
  console.log('#  | Coin    | Perp $   | Spot $   | Basis % | Funding/yr | Exp Yield | Direction           | Daily/$5k | Risk');
  console.log('───|─────────|──────────|──────────|─────────|────────────|───────────|─────────────────────|───────────|────');
  for (const o of opps.slice(0, 20)) {
    console.log(
      `${String(o.rank).padStart(2)} | ${o.coin.padEnd(7)} | ${String(o.perpPrice.toFixed(2)).padStart(8)} | ${String(o.spotPrice.toFixed(2)).padStart(8)} | ` +
      `${o.basisPct.toFixed(2).padStart(7)}% | ${o.fundingAnnualPct.toFixed(0).padStart(10)}/yr | ` +
      `${o.expectedYieldPct.toFixed(1).padStart(9)}/yr | ${o.direction.padEnd(19)} | ${fmtUsd(o.dailyProfitOn5k).padStart(9)}/d | ${o.riskScore}/10`
    );
  }

  // Portfolio projection
  console.log('\n── PORTFOLIO PROJECTION ($50k across top 5) ──');
  const top5 = opps.slice(0, 5);
  let totalDaily = 0;
  for (const o of top5) {
    const daily = 10000 * o.expectedYieldPct / 100 / 365;
    totalDaily += daily;
    console.log(`  ${o.rank}. ${o.coin.padEnd(7)} ${o.expectedYieldPct.toFixed(1).padStart(6)}/yr  ${fmtUsd(daily).padStart(7)}/day  ${o.direction}`);
  }
  console.log(`\n  Total daily profit: ${fmtUsd(totalDaily)}`);
  console.log(`  Total monthly: ${fmtUsd(totalDaily * 30)}`);
  console.log(`  Total annual: ${fmtUsd(totalDaily * 365)}`);
  console.log(`  Portfolio yield: ${(totalDaily * 365 / 50000 * 100).toFixed(1)}%/yr`);

  // Detailed plan for top opp
  if (opps.length > 0) {
    console.log('\n── EXECUTION PLAN FOR TOP OPPORTUNITY ──');
    const top = opps[0];
    console.log(`  ${top.coin}: ${top.direction}`);
    console.log(`  Expected yield: ${top.expectedYieldPct.toFixed(1)}/yr`);
    console.log(`  Risk score: ${top.riskScore}/10`);
    console.log(`  Steps:`);
    for (const s of top.executionSteps) console.log(`    ${s}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
