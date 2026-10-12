/**
 * Tokenized Equity Arbitrage Scanner
 *
 * Scans tokenized equity markets (Stocks, Indexes, ETFs) across:
 *   - HL perps (alias:anthropic, alias:openai, etc. — pre-IPO companies)
 *   - Backed (Backed Finance) — tokenized ETFs/stocks on Base
 *   - Injective Pre-IPO perps
 *   - Ondo Finance tokenized treasuries
 *   - RealT tokenized real estate
 *
 * Strategy types:
 *   1. Pre-IPO perp vs private valuation (HL alias:anthropic vs latest Anthropic $61B valuation)
 *   2. Tokenized equity spot vs perp (Backed ETF vs HL perp)
 *   3. Ondo USDY vs USDC stablecoin yield (delta-neutral)
 *   4. RealT rental yield (delta-neutral real estate)
 *
 * Focus: delta-neutral yield from tokenized real-world assets.
 */

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
const VOI_API = 'https://perps-api.vooi.io';

interface EquityOpp {
  rank: number;
  asset: string;
  type: string;
  venue: string;
  yieldPct: number;
  riskScore: number;
  notes: string;
  capitalRequired: number;
  dailyProfitOn5k: number;
}

async function hlPost(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
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

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

async function getHlAliasFunding(): Promise<EquityOpp[]> {
  try {
    const r = await hlPost({ type: 'metaAndAssetCtxs' });
    const universe = r?.[0]?.universe || [];
    const ctxs = r?.[1] || [];
    const opps: EquityOpp[] = [];
    for (let i = 0; i < universe.length; i++) {
      const u = universe[i];
      const ctx = ctxs[i];
      if (!u || !ctx || !u.name.startsWith('alias:')) continue;
      const fundingHourly = parseFloat(ctx.funding) || 0;
      const fundingAnnual = fundingHourly * 24 * 365 * 100;
      if (Math.abs(fundingAnnual) < 10) continue;
      const oi = parseFloat(ctx.openInterest) * parseFloat(ctx.markPx);
      if (oi < 50_000) continue;

      const daily5k = 5000 * Math.abs(fundingAnnual) / 100 / 365;
      opps.push({
        rank: 0,
        asset: u.name,
        type: 'Pre-IPO Perp Funding',
        venue: 'HL',
        yieldPct: Math.abs(fundingAnnual),
        riskScore: 5,
        notes: `Funding ${fundingAnnual.toFixed(0)}/yr, OI ${fmtUsd(oi)}`,
        capitalRequired: 5000,
        dailyProfitOn5k: daily5k,
      });
    }
    return opps;
  } catch {
    return [];
  }
}

async function getVooiAliasSpreads(): Promise<EquityOpp[]> {
  try {
    const resp = await vooiScan({ limit: 50, orderBy: 'priceSpread', orderDirection: 'desc', minPriceSpread: 0.01 });
    const opps: EquityOpp[] = [];
    for (const item of (resp?.items || [])) {
      if (!item.asset.startsWith('alias:')) continue;
      for (const p of (item.pairs || [])) {
        const spread = (p.priceSpread || 0) * 100;
        if (spread < 1.5) continue;
        const annualized = spread * 3 * 365 * 0.5;  // 3 arbs/day, 50% capture
        const daily5k = 5000 * spread / 100 * 0.5;
        opps.push({
          rank: 0,
          asset: item.asset,
          type: 'Pre-IPO Price Spread',
          venue: `${p.long?.exchange}→${p.short?.exchange}`,
          yieldPct: annualized,
          riskScore: 2,
          notes: `Spread ${spread.toFixed(2)}% instant capture`,
          capitalRequired: 5000,
          dailyProfitOn5k: daily5k,
        });
      }
    }
    return opps;
  } catch {
    return [];
  }
}

// Tokenized RWA yields (curated)
function getTokenizedRwaYields(): EquityOpp[] {
  return [
    // Ondo Finance
    { rank: 0, asset: 'USDY', type: 'RWA Yield', venue: 'Ondo Finance', yieldPct: 5.5, riskScore: 2, notes: 'Tokenized T-Bills, USD yield', capitalRequired: 5000, dailyProfitOn5k: 5000 * 5.5 / 100 / 365 },
    { rank: 0, asset: 'OUSG', type: 'RWA Yield', venue: 'Ondo Finance', yieldPct: 5.0, riskScore: 2, notes: 'Tokenized BlackRock ETF', capitalRequired: 5000, dailyProfitOn5k: 5000 * 5.0 / 100 / 365 },

    // Backed Finance
    { rank: 0, asset: 'bCSPX', type: 'Tokenized ETF', venue: 'Backed Finance', yieldPct: 10.0, riskScore: 4, notes: 'S&P 500 ETF tokenized on Base', capitalRequired: 5000, dailyProfitOn5k: 5000 * 10.0 / 100 / 365 },
    { rank: 0, asset: 'bQQQ', type: 'Tokenized ETF', venue: 'Backed Finance', yieldPct: 9.5, riskScore: 4, notes: 'Nasdaq 100 ETF tokenized', capitalRequired: 5000, dailyProfitOn5k: 5000 * 9.5 / 100 / 365 },
    { rank: 0, asset: 'bCOIN', type: 'Tokenized Stock', venue: 'Backed Finance', yieldPct: 12.0, riskScore: 5, notes: 'Coinbase stock tokenized', capitalRequired: 5000, dailyProfitOn5k: 5000 * 12.0 / 100 / 365 },

    // RealT (tokenized real estate)
    { rank: 0, asset: 'RealT', type: 'Tokenized RE', venue: 'RealT', yieldPct: 7.5, riskScore: 3, notes: 'Tokenized US rental properties, monthly rent payouts', capitalRequired: 5000, dailyProfitOn5k: 5000 * 7.5 / 100 / 365 },

    // Mountain Protocol (wrapped US Treasury)
    { rank: 0, asset: 'wUSDM', type: 'RWA Yield', venue: 'Mountain Protocol', yieldPct: 5.0, riskScore: 3, notes: 'Wrapped US Treasury yield', capitalRequired: 5000, dailyProfitOn5k: 5000 * 5.0 / 100 / 365 },

    // Splint Invest (fractional alternative assets)
    { rank: 0, asset: 'SplintInvest', type: 'Alt Assets', venue: 'Splint Invest', yieldPct: 6.0, riskScore: 4, notes: 'Fractional wine, art, watches', capitalRequired: 5000, dailyProfitOn5k: 5000 * 6.0 / 100 / 365 },
  ];
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Tokenized Equity / RWA Arbitrage Scanner');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════\n');

  const [hlAlias, vooiAlias, rwa] = await Promise.all([
    getHlAliasFunding(),
    getVooiAliasSpreads(),
    Promise.resolve(getTokenizedRwaYields()),
  ]);

  const allOpps = [...hlAlias, ...vooiAlias, ...rwa];
  allOpps.sort((a, b) => b.yieldPct - a.yieldPct);
  allOpps.forEach((o, i) => { o.rank = i + 1; });

  console.log(`── ALL ${allOpps.length} TOKENIZED EQUITY / RWA OPPORTUNITIES ──\n`);
  console.log('#  | Asset              | Type                  | Venue              | Yield/yr | Daily/$5k | Risk');
  console.log('───|────────────────────|──────────────────────|───────────────────|──────────|───────────|────');
  for (const o of allOpps) {
    console.log(
      `${String(o.rank).padStart(2)} | ${o.asset.padEnd(18)} | ${o.type.padEnd(20)} | ${o.venue.padEnd(18)} | ` +
      `${o.yieldPct.toFixed(1).padStart(8)}%/yr | ${fmtUsd(o.dailyProfitOn5k).padStart(9)}/d | ${o.riskScore}/10`
    );
    console.log(`   └─ ${o.notes}`);
  }

  // Portfolio projection
  console.log('\n── PORTFOLIO PROJECTION ($50k across top 5) ──');
  const top5 = allOpps.slice(0, 5);
  let totalDaily = 0;
  for (const o of top5) {
    const daily = 10000 * o.yieldPct / 100 / 365;
    totalDaily += daily;
    console.log(`  ${o.rank}. ${o.asset.padEnd(18)} ${o.yieldPct.toFixed(1).padStart(6)}%/yr  ${fmtUsd(daily).padStart(7)}/day  ${o.type}`);
  }
  console.log(`\n  Total daily profit: ${fmtUsd(totalDaily)}`);
  console.log(`  Total monthly: ${fmtUsd(totalDaily * 30)}`);
  console.log(`  Total annual: ${fmtUsd(totalDaily * 365)}`);
  console.log(`  Portfolio yield: ${(totalDaily * 365 / 50000 * 100).toFixed(1)}%/yr`);

  // By type
  console.log('\n── BY TYPE ──');
  const byType: Record<string, { count: number; avgYield: number }> = {};
  for (const o of allOpps) {
    if (!byType[o.type]) byType[o.type] = { count: 0, avgYield: 0 };
    byType[o.type].count++;
    byType[o.type].avgYield += o.yieldPct;
  }
  for (const [t, s] of Object.entries(byType).sort((a, b) => b[1].avgYield / b[1].count - a[1].avgYield / a[1].count)) {
    console.log(`  ${t.padEnd(22)} ${String(s.count).padStart(3)} opps  avg yield ${(s.avgYield / s.count).toFixed(1)}%/yr`);
  }

  // Investor summary
  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  Total opportunities: ${allOpps.length}`);
  console.log(`  Top yield: ${allOpps[0]?.yieldPct.toFixed(1)}%/yr (${allOpps[0]?.asset})`);
  console.log(`  Portfolio yield on $50k: ${(totalDaily * 365 / 50000 * 100).toFixed(1)}%/yr`);
  console.log(`  Risk: Mix of delta-neutral (RWA yield) and pre-IPO speculation`);
  console.log(`  Best for: Diversification across real-world and pre-IPO assets`);
}

main().catch(err => { console.error(err); process.exit(1); });
