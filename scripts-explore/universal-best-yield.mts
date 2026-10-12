/**
 * Universal Best Yield Finder
 *
 * The ultimate yield scanner — combines ALL yield sources and finds
 * the absolute best opportunities for any risk tolerance.
 *
 * Categories scanned:
 *   1. Stablecoin yields (24,000+ pools via DefiLlama)
 *   2. Pendle PT yields (principal-protected)
 *   3. RWA Treasury yields (BlackRock, Ondo, Circle)
 *   4. HL Funding Harvest (perp arbitrage)
 *   5. LST Carry Trades
 *   6. Perp LP Vaults (JLP, HLP, GLP)
 *   7. Hyperliquid L1 native yields
 *
 * Output: Best yield at each risk level (1-10)
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

const LLAMA_API = 'https://yields.llama.fi';
const HL_API = 'https://api.hyperliquid.xyz/info';

interface YieldOpportunity {
  category: string;
  symbol: string;
  project: string;
  chain: string;
  apy: number;
  tvlUsd: number;
  riskScore: number;
  liquidity: string;
  notes: string;
}

async function fetchDefiLlamaPools(): Promise<YieldOpportunity[]> {
  try {
    const res = await fetch(`${LLAMA_API}/pools`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const j = await res.json() as any;
    const opps: YieldOpportunity[] = [];

    for (const p of (j?.data || [])) {
      // Stablecoin yields
      if (p.stablecoin && p.ilRisk === 'no' && p.apy > 5 && p.tvlUsd > 10_000_000) {
        let risk = 3;
        if (p.tvlUsd > 1_000_000_000) risk = 1;
        else if (p.tvlUsd > 100_000_000) risk = 2;
        if (p.apy > 30) risk += 2;
        opps.push({
          category: 'Stablecoin',
          symbol: p.symbol,
          project: p.project,
          chain: p.chain,
          apy: p.apy,
          tvlUsd: p.tvlUsd,
          riskScore: Math.min(10, risk),
          liquidity: 'Instant',
          notes: 'Delta-neutral stablecoin yield',
        });
      }

      // Pendle PT (principal-protected)
      if ((p.project || '').includes('pendle') && p.apy > 5 && p.tvlUsd > 1_000_000) {
        opps.push({
          category: 'Pendle PT',
          symbol: p.symbol,
          project: p.project,
          chain: p.chain,
          apy: p.apy,
          tvlUsd: p.tvlUsd,
          riskScore: 2,
          liquidity: '30-180d to maturity',
          notes: 'Principal-protected fixed yield',
        });
      }

      // RWA Treasury
      const proj = (p.project || '').toLowerCase();
      const sym = (p.symbol || '').toLowerCase();
      if (proj.includes('blackrock') || proj.includes('ondo') || proj.includes('invesco') ||
          proj.includes('circle-usyc') || proj.includes('mountain') || proj.includes('openeden') ||
          sym.includes('buidl') || sym.includes('usdy') || sym.includes('usyc') || sym.includes('ustb') || sym.includes('tbill')) {
        if (p.apy > 0 && p.tvlUsd > 1_000_000) {
          opps.push({
            category: 'RWA Treasury',
            symbol: p.symbol,
            project: p.project,
            chain: p.chain,
            apy: p.apy,
            tvlUsd: p.tvlUsd,
            riskScore: 1,
            liquidity: 'Instant',
            notes: 'US Treasury-backed (lowest risk)',
          });
        }
      }

      // LST yields
      const s = (p.symbol || '').toLowerCase();
      if ((s.includes('jitosol') || s.includes('msol') || s.includes('bsol') || s.includes('jupsol') ||
           s.includes('steth') || s.includes('khype')) && p.apy > 0 && p.tvlUsd > 10_000_000) {
        opps.push({
          category: 'LST',
          symbol: p.symbol,
          project: p.project,
          chain: p.chain,
          apy: p.apy,
          tvlUsd: p.tvlUsd,
          riskScore: 3,
          liquidity: 'Instant',
          notes: 'Liquid staking token yield',
        });
      }

      // Perp LP
      if ((s.includes('jlp') || s.includes('glp') || s.includes('hlp')) && p.apy > 0 && p.tvlUsd > 1_000_000) {
        opps.push({
          category: 'Perp LP',
          symbol: p.symbol,
          project: p.project,
          chain: p.chain,
          apy: p.apy,
          tvlUsd: p.tvlUsd,
          riskScore: 4,
          liquidity: 'Instant',
          notes: 'Perp liquidity provider vault',
        });
      }
    }

    return opps;
  } catch {
    return [];
  }
}

async function fetchHLFundingOpps(): Promise<YieldOpportunity[]> {
  try {
    const r = await fetch(HL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    });
    const j = await r.json() as any;
    const universe = j?.[0]?.universe || [];
    const ctxs = j?.[1] || [];
    const opps: YieldOpportunity[] = [];
    for (let i = 0; i < universe.length; i++) {
      const u = universe[i];
      const ctx = ctxs[i];
      if (!u || !ctx || u.name.startsWith('@')) continue;
      const fundingHourly = parseFloat(ctx.funding) || 0;
      const fundingAnnual = fundingHourly * 24 * 365 * 100;
      if (Math.abs(fundingAnnual) < 30) continue;
      const oi = parseFloat(ctx.openInterest) * parseFloat(ctx.markPx);
      if (oi < 1_000_000) continue;
      opps.push({
        category: 'HL Funding',
        symbol: u.name,
        project: 'Hyperliquid',
        chain: 'Hyperliquid',
        apy: Math.abs(fundingAnnual),
        tvlUsd: oi,
        riskScore: fundingAnnual > 100 ? 6 : 4,
        liquidity: 'Instant',
        notes: `Funding ${fundingAnnual.toFixed(0)}/yr ${fundingAnnual > 0 ? 'SHORT harvest' : 'LONG harvest'}`,
      });
    }
    return opps;
  } catch {
    return [];
  }
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Universal Best Yield Finder');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('  Combines ALL yield sources');
  console.log('═══════════════════════════════════════════════════\n');

  const [defiLlamaOpps, hlFundingOpps] = await Promise.all([
    fetchDefiLlamaPools(),
    fetchHLFundingOpps(),
  ]);

  const allOpps = [...defiLlamaOpps, ...hlFundingOpps];
  console.log(`Total opportunities: ${allOpps.length}`);
  console.log(`  - DefiLlama (stablecoin + PT + RWA + LST + LP): ${defiLlamaOpps.length}`);
  console.log(`  - HL Funding Harvest: ${hlFundingOpps.length}\n`);

  // Sort by risk-adjusted yield (apy / riskScore)
  allOpps.sort((a, b) => (b.apy / b.riskScore) - (a.apy / a.riskScore));

  console.log('── TOP 30 OPPORTUNITIES BY RISK-ADJUSTED YIELD ──\n');
  console.log('#  | Category       | Symbol         | Project              | Chain              | APY%     | TVL       | Risk | Liquidity    ');
  console.log('───|────────────────|────────────────|──────────────────────|────────────────────|──────────|───────────|──────|──────────────');
  for (let i = 0; i < Math.min(30, allOpps.length); i++) {
    const o = allOpps[i];
    console.log(
      `${String(i + 1).padStart(2)} | ${o.category.padEnd(14)} | ${o.symbol.slice(0, 14).padEnd(14)} | ${o.project.slice(0, 20).padEnd(20)} | ${o.chain.slice(0, 18).padEnd(18)} | ` +
      `${o.apy.toFixed(2).padStart(8)}% | ${fmtUsd(o.tvlUsd).padStart(9)} | ${String(o.riskScore).padStart(4)}/10 | ${o.liquidity.padEnd(12)}`
    );
  }

  // Best yield at each risk level
  console.log('\n── BEST YIELD AT EACH RISK LEVEL ──\n');
  console.log('Risk   | Category       | Symbol         | APY%     | TVL       | Project              ');
  console.log('───────|────────────────|────────────────|──────────|───────────|──────────────────────');
  for (let risk = 1; risk <= 10; risk++) {
    const atRisk = allOpps.filter(o => o.riskScore === risk);
    if (atRisk.length === 0) continue;
    const best = atRisk.sort((a, b) => b.apy - a.apy)[0];
    console.log(
      `${String(risk).padStart(4)}/10 | ${best.category.padEnd(14)} | ${best.symbol.slice(0, 14).padEnd(14)} | ` +
      `${best.apy.toFixed(2).padStart(8)}% | ${fmtUsd(best.tvlUsd).padStart(9)} | ${best.project.slice(0, 20)}`
    );
  }

  // By category
  console.log('\n── BY CATEGORY ──');
  const byCat: Record<string, { count: number; totalTvl: number; avgApy: number; maxApy: number }> = {};
  for (const o of allOpps) {
    if (!byCat[o.category]) byCat[o.category] = { count: 0, totalTvl: 0, avgApy: 0, maxApy: 0 };
    byCat[o.category].count++;
    byCat[o.category].totalTvl += o.tvlUsd;
    byCat[o.category].avgApy += o.apy;
    byCat[o.category].maxApy = Math.max(byCat[o.category].maxApy, o.apy);
  }
  console.log('Category       | Count | Total TVL  | Avg APY | Max APY');
  console.log('───────────────|───────|────────────|─────────|─────────');
  for (const [cat, s] of Object.entries(byCat).sort((a, b) => b[1].totalTvl - a[1].totalTvl)) {
    console.log(`${cat.padEnd(13)} | ${String(s.count).padStart(5)} | ${fmtUsd(s.totalTvl).padStart(10)} | ${(s.avgApy / s.count).toFixed(2).padStart(7)}% | ${s.maxApy.toFixed(2).padStart(7)}%`);
  }

  // Portfolio projections at 3 risk levels
  console.log('\n── PORTFOLIO PROJECTIONS ──');

  const conservative = allOpps.filter(o => o.riskScore <= 2).slice(0, 10);
  const moderate = allOpps.filter(o => o.riskScore <= 4).slice(0, 10);
  const aggressive = allOpps.slice(0, 10);

  for (const [name, portfolio] of [['CONSERVATIVE (risk 1-2)', conservative], ['MODERATE (risk 1-4)', moderate], ['AGGRESSIVE (top 10)', aggressive]] as [string, YieldOpportunity[]][]) {
    console.log(`\n  ${name}:`);
    let totalYield = 0;
    let totalRisk = 0;
    for (const o of portfolio) {
      const allocation = 100000 / portfolio.length;
      const annual = allocation * o.apy / 100;
      totalYield += annual;
      totalRisk += o.riskScore * allocation;
      console.log(`    ${o.symbol.slice(0, 14).padEnd(14)} ${o.category.padEnd(14)} ${o.apy.toFixed(2).padStart(6)}%  ${fmtUsd(annual).padStart(8)}/yr  risk ${o.riskScore}/10`);
    }
    const weightedRisk = totalRisk / 100000;
    const totalDaily = totalYield / 365;
    console.log(`    Total daily: ${fmtUsd(totalDaily)}`);
    console.log(`    Total annual: ${fmtUsd(totalYield)}`);
    console.log(`    Portfolio yield: ${(totalYield / 100000 * 100).toFixed(2)}%/yr`);
    console.log(`    Weighted risk: ${weightedRisk.toFixed(1)}/10`);
  }

  // Investor summary
  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  Total opportunities: ${allOpps.length}`);
  console.log(`  Total TVL: ${fmtUsd(allOpps.reduce((s, o) => s + o.tvlUsd, 0))}`);
  console.log(`  Top yield: ${allOpps[0]?.apy.toFixed(2)}% APY (${allOpps[0]?.symbol} on ${allOpps[0]?.project})`);
  console.log(`  Categories: ${Object.keys(byCat).length}`);
  console.log(`  Chains: ${new Set(allOpps.map(o => o.chain)).size}`);
  console.log(`  Best risk 1 yield: ${allOpps.filter(o => o.riskScore === 1).sort((a, b) => b.apy - a.apy)[0]?.apy.toFixed(2)}% APY`);
  console.log(`  Best risk 5+ yield: ${allOpps.filter(o => o.riskScore >= 5).sort((a, b) => b.apy - a.apy)[0]?.apy.toFixed(2)}% APY`);
}

main().catch(err => { console.error(err); process.exit(1); });
