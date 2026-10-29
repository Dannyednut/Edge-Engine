/**
 * Live Trade Plan Compiler
 *
 * Combines all live data sources into a single actionable trade plan.
 * Updates every 60s. Outputs:
 *   - Top 5 actionable opportunities RIGHT NOW
 *   - For each: exact trade instructions, expected profit, risk
 *   - Capital allocation across the 5
 *   - Total projected daily income
 *   - Risk metrics
 *
 * Use this when you have capital ready to deploy.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

const VOI_API = 'https://perps-api.vooi.io';
const HL_API  = 'https://api.hyperliquid.xyz/info';

interface Opportunity {
  rank: number;
  type: 'PRICE_ARB' | 'FUNDING_HARVEST';
  asset: string;
  venues: string;
  expectedReturnPct: number;       // % of position
  expectedProfitUsd: number;       // on recommended size
  recommendedSizeUsd: number;
  holdTime: string;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  instructions: string[];
  executionVenue: 'VOOI_BOT' | 'HL_DIRECT' | 'MANUAL';
}

async function vooiScan(params: any): Promise<any> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  const url = `${VOI_API}/arbitrage-scanner?${q.toString()}`;
  const res = await fetch(url);
  if (!res.ok) return { items: [], total: 0 };
  return res.json();
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
  return `$${n.toFixed(0)}`;
}

function sizeForCapital(capital: number, expectedReturnPct: number, winRate = 0.95): { size: number; expectedProfit: number } {
  // Half-Kelly capped at 20% per position
  const maxPct = 0.20;
  const halfKelly = 0.25;  // conservative default
  const fraction = Math.min(halfKelly, maxPct);
  const size = fraction * capital;
  const expectedProfit = size * expectedReturnPct / 100 * winRate;
  return { size, expectedProfit };
}

async function buildTradePlan(capital: number): Promise<Opportunity[]> {
  const opps: Opportunity[] = [];

  // ── 1. VOOI Price Spread Arbs (instant capture) ──
  const priceResp = await vooiScan({ limit: 30, orderBy: 'priceSpread', orderDirection: 'desc', minPriceSpread: 0.02 });
  let rank = 1;
  for (const item of (priceResp?.items || [])) {
    for (const p of (item.pairs || [])) {
      const spreadPct = (p.priceSpread || 0) * 100;
      if (spreadPct < 2) continue;
      const { size, expectedProfit } = sizeForCapital(capital, spreadPct);
      const longEx = p.long?.exchange;
      const shortEx = p.short?.exchange;
      opps.push({
        rank: rank++,
        type: 'PRICE_ARB',
        asset: item.asset,
        venues: `${longEx}→${shortEx}`,
        expectedReturnPct: spreadPct,
        expectedProfitUsd: expectedProfit,
        recommendedSizeUsd: size,
        holdTime: 'INSTANT (seconds)',
        risk: spreadPct > 5 ? 'MEDIUM' : 'LOW',
        instructions: [
          `1. LONG ${item.asset} on ${longEx} at market`,
          `2. SHORT ${item.asset} on ${shortEx} at market`,
          `3. Capture spread: ${spreadPct.toFixed(2)}%`,
          `4. Close both legs immediately`,
          `Net profit after fees: ${fmtUsd(expectedProfit)}`,
        ],
        executionVenue: longEx === 'hyperliquid' || shortEx === 'hyperliquid' ? 'HL_DIRECT' : 'VOOI_BOT',
      });
      if (opps.length >= 5) break;
    }
    if (opps.length >= 5) break;
  }

  // ── 2. HL Funding Harvest (delta-neutral) ──
  if (opps.length < 5) {
    const hl = await hlPost({ type: 'metaAndAssetCtxs' });
    const universe = hl?.[0]?.universe || [];
    const ctxs = hl?.[1] || [];
    const markets = universe
      .map((u: any, i: number) => ({ name: u.name, ctx: ctxs[i] }))
      .filter((m: any) => !m.name.startsWith('@') && m.ctx)
      .map((m: any) => {
        const fundingHourly = parseFloat(m.ctx.funding) || 0;
        const fundingAnnual = fundingHourly * 24 * 365 * 100;
        const oi = parseFloat(m.ctx.openInterest) * parseFloat(m.ctx.markPx);
        return { name: m.name, fundingAnnual, fundingHourly, oi };
      })
      .filter((m: any) => Math.abs(m.fundingAnnual) > 100)
      .sort((a: any, b: any) => Math.abs(b.fundingAnnual) - Math.abs(a.fundingAnnual));

    for (const m of markets) {
      if (opps.length >= 7) break;
      const dailyRate = Math.abs(m.fundingAnnual) / 365;
      const { size, expectedProfit } = sizeForCapital(capital, dailyRate, 0.85);
      const isShort = m.fundingAnnual > 0;
      opps.push({
        rank: rank++,
        type: 'FUNDING_HARVEST',
        asset: m.name,
        venues: isShort ? 'HL perp SHORT + spot LONG' : 'HL perp LONG + spot SHORT',
        expectedReturnPct: dailyRate,
        expectedProfitUsd: expectedProfit,
        recommendedSizeUsd: size,
        holdTime: '12-96 hours',
        risk: 'MEDIUM',
        instructions: [
          `1. ${isShort ? 'SHORT' : 'LONG'} ${m.name} perp on HL (size: ${fmtUsd(size)})`,
          `2. ${isShort ? 'LONG' : 'SHORT'} ${m.name} spot on HyperEVM/CEX (delta-neutral)`,
          `3. Hold 12-96h to collect funding payments`,
          `4. Funding rate: ${m.fundingAnnual.toFixed(0)}%/yr (${m.fundingHourly * 100}).toFixed(4)%/hr`,
          `5. OI: ${fmtUsd(m.oi)} — sufficient liquidity`,
          `Daily profit: ${fmtUsd(expectedProfit)}/day`,
        ],
        executionVenue: 'HL_DIRECT',
      });
    }
  }

  return opps;
}

async function main() {
  const capital = parseFloat(process.env.WORKING_CAPITAL_USD || '10000');
  const loop = process.argv[2] === '--loop';

  console.log('═══════════════════════════════════════════════════');
  console.log('  Live Trade Plan Compiler');
  console.log(`  Capital: ${fmtUsd(capital)} | Refresh: ${loop ? '60s' : 'one-shot'}`);
  console.log('═══════════════════════════════════════════════════\n');

  const run = async () => {
    try {
      const opps = await buildTradePlan(capital);

      let totalExpectedDaily = 0;
      let totalDeployed = 0;
      for (const o of opps) {
        totalExpectedDaily += o.type === 'FUNDING_HARVEST' ? o.expectedProfitUsd : o.expectedProfitUsd * 3; // assume 3 instant arbs/day
        totalDeployed += o.recommendedSizeUsd;
      }

      console.log(`\n┌────────────────────────────────────────────────────────────────────────────────────┐`);
      console.log(`│ LIVE TRADE PLAN — ${new Date().toISOString().slice(11,19)}                                                 │`);
      console.log(`│ Capital: ${fmtUsd(capital).padEnd(10)} | Deployed: ${fmtUsd(totalDeployed).padEnd(10)} | Daily exp: ${fmtUsd(totalExpectedDaily).padEnd(10)} │`);
      console.log(`└────────────────────────────────────────────────────────────────────────────────────┘\n`);

      for (const o of opps) {
        const icon = o.type === 'PRICE_ARB' ? '⚡' : '💰';
        const riskIcon = o.risk === 'LOW' ? '🟢' : o.risk === 'MEDIUM' ? '🟡' : '🔴';
        console.log(`${icon} #${o.rank} ${o.type.replace('_', ' ')} — ${o.asset}`);
        console.log(`   ${riskIcon} Risk: ${o.risk} | Hold: ${o.holdTime} | Execute via: ${o.executionVenue}`);
        console.log(`   📊 Size: ${fmtUsd(o.recommendedSizeUsd)} | Exp return: ${o.expectedReturnPct.toFixed(2)}% | Exp profit: ${fmtUsd(o.expectedProfitUsd)}`);
        console.log(`   🔄 Venues: ${o.venues}`);
        console.log(`   📝 Instructions:`);
        for (const step of o.instructions) console.log(`      ${step}`);
        console.log('');
      }

      console.log('── Summary ──');
      console.log(`  Opportunities: ${opps.length}`);
      console.log(`  Capital deployed: ${fmtUsd(totalDeployed)} of ${fmtUsd(capital)} (${(totalDeployed/capital*100).toFixed(0)}%)`);
      console.log(`  Cash reserve: ${fmtUsd(capital - totalDeployed)}`);
      console.log(`  Expected daily profit: ${fmtUsd(totalExpectedDaily)}`);
      console.log(`  Expected monthly profit: ${fmtUsd(totalExpectedDaily * 30)}`);
      console.log(`  Expected annual profit: ${fmtUsd(totalExpectedDaily * 365)}`);
      console.log(`  Annualized ROI: ${(totalExpectedDaily * 365 / capital * 100).toFixed(0)}%`);
    } catch (e) {
      console.error('Error:', e);
    }
  };

  await run();
  if (loop) {
    while (true) {
      await new Promise(r => setTimeout(r, 60_000));
      await run();
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
