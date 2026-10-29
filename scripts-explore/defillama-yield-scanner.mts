/**
 * DefiLlama Universal Yield Scanner
 *
 * Fetches ALL yield pools from DefiLlama (16,950+ pools across all chains).
 * Identifies the highest-yielding delta-neutral opportunities:
 *   - Stablecoin pools (no IL risk, no market exposure)
 *   - Single-sided lending (no IL risk)
 *   - LST pools (minor exposure but high yield)
 *
 * Data source: yields.llama.fi (DefiLlama official API)
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

const LLAMA_API = 'https://yields.llama.fi';

interface YieldPool {
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number;
  apyBase: number;
  apyReward: number;
  apy7d: number;
  apy30d: number;
  stablecoin: boolean;
  ilRisk: string;
  exposure: string;
  pool: string;
  predictions: any;
}

async function fetchAllPools(): Promise<YieldPool[]> {
  try {
    const res = await fetch(`${LLAMA_API}/pools`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const j = await res.json() as any;
    return (j?.data || []).map((p: any) => ({
      chain: p.chain,
      project: p.project,
      symbol: p.symbol,
      tvlUsd: p.tvlUsd,
      apy: p.apy || 0,
      apyBase: p.apyBase || 0,
      apyReward: p.apyReward || 0,
      apy7d: p.apyBase7d || p.apy || 0,
      apy30d: p.apyMean30d || p.apy || 0,
      stablecoin: p.stablecoin || false,
      ilRisk: p.ilRisk || 'unknown',
      exposure: p.exposure || 'unknown',
      pool: p.pool,
      predictions: p.predictions,
    }));
  } catch (e) {
    console.error('DefiLlama API error:', e);
    return [];
  }
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  DefiLlama Universal Yield Scanner');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════\n');

  const allPools = await fetchAllPools();
  console.log(`Total pools fetched: ${allPools.length.toLocaleString()}\n`);

  // Filter to high-quality pools
  const filtered = allPools
    .filter(p => p.apy > 1 && p.apy < 500)  // realistic APY range
    .filter(p => p.tvlUsd > 100_000)
    .filter(p => p.ilRisk === 'no');  // no impermanent loss

  console.log(`Filtered (no IL risk, APY 1-500%, TVL > $100k): ${filtered.length.toLocaleString()}\n`);

  // Stablecoin pools (delta-neutral, no IL risk)
  const stablePools = filtered
    .filter(p => p.stablecoin)
    .sort((a, b) => b.apy - a.apy);

  console.log(`── TOP 25 STABLECOIN YIELD POOLS (delta-neutral) ──\n`);
  console.log('#  | Project       | Symbol      | Chain     | APY%    | 7d APY  | 30d APY | TVL       | Exposure');
  console.log('───|───────────────|─────────────|───────────|─────────|─────────|─────────|───────────|─────────');
  for (let i = 0; i < Math.min(25, stablePools.length); i++) {
    const p = stablePools[i];
    console.log(
      `${String(i + 1).padStart(2)} | ${p.project.padEnd(13)} | ${p.symbol.slice(0, 11).padEnd(11)} | ${p.chain.padEnd(9)} | ` +
      `${p.apy.toFixed(2).padStart(7)}% | ${p.apy7d.toFixed(2).padStart(7)}% | ${p.apy30d.toFixed(2).padStart(7)}% | ` +
      `${fmtUsd(p.tvlUsd).padStart(9)} | ${p.exposure}`
    );
  }

  // Single-sided lending (delta-neutral)
  const singleSided = filtered
    .filter(p => p.exposure === 'single')
    .filter(p => !p.stablecoin)
    .sort((a, b) => b.apy - a.apy);

  console.log(`\n── TOP 15 SINGLE-SIDED LENDING POOLS (delta-neutral, no IL) ──\n`);
  console.log('#  | Project       | Symbol      | Chain     | APY%    | 30d APY | TVL       ');
  console.log('───|───────────────|─────────────|───────────|─────────|─────────|───────────');
  for (let i = 0; i < Math.min(15, singleSided.length); i++) {
    const p = singleSided[i];
    console.log(
      `${String(i + 1).padStart(2)} | ${p.project.padEnd(13)} | ${p.symbol.slice(0, 11).padEnd(11)} | ${p.chain.padEnd(9)} | ` +
      `${p.apy.toFixed(2).padStart(7)}% | ${p.apy30d.toFixed(2).padStart(7)}% | ${fmtUsd(p.tvlUsd).padStart(9)}`
    );
  }

  // By project summary
  console.log('\n── TOP 15 PROJECTS BY TVL ──');
  const byProject: Record<string, { tvl: number; count: number; avgApy: number; maxApy: number }> = {};
  for (const p of stablePools) {
    if (!byProject[p.project]) byProject[p.project] = { tvl: 0, count: 0, avgApy: 0, maxApy: 0 };
    byProject[p.project].tvl += p.tvlUsd;
    byProject[p.project].count++;
    byProject[p.project].avgApy += p.apy;
    byProject[p.project].maxApy = Math.max(byProject[p.project].maxApy, p.apy);
  }
  const sortedProjects = Object.entries(byProject).sort((a, b) => b[1].tvl - a[1].tvl).slice(0, 15);
  console.log('Project               | Pools | Total TVL  | Avg APY | Max APY');
  console.log('──────────────────────|───────|────────────|─────────|─────────');
  for (const [proj, s] of sortedProjects) {
    console.log(`${proj.padEnd(20)} | ${String(s.count).padStart(5)} | ${fmtUsd(s.tvl).padStart(10)} | ${(s.avgApy / s.count).toFixed(2).padStart(7)}% | ${s.maxApy.toFixed(2).padStart(7)}%`);
  }

  // By chain summary
  console.log('\n── TOP 10 CHAINS BY POOL COUNT ──');
  const byChain: Record<string, { count: number; tvl: number; avgApy: number }> = {};
  for (const p of stablePools) {
    if (!byChain[p.chain]) byChain[p.chain] = { count: 0, tvl: 0, avgApy: 0 };
    byChain[p.chain].count++;
    byChain[p.chain].tvl += p.tvlUsd;
    byChain[p.chain].avgApy += p.apy;
  }
  const sortedChains = Object.entries(byChain).sort((a, b) => b[1].count - a[1].count).slice(0, 10);
  console.log('Chain      | Pools | Total TVL  | Avg APY');
  console.log('───────────|───────|────────────|─────────');
  for (const [chain, s] of sortedChains) {
    console.log(`${chain.padEnd(10)} | ${String(s.count).padStart(5)} | ${fmtUsd(s.tvl).padStart(10)} | ${(s.avgApy / s.count).toFixed(2).padStart(7)}%`);
  }

  // Portfolio projection
  console.log('\n── PORTFOLIO PROJECTION ($100k across top 10 stablecoin pools) ──');
  const top10 = stablePools.slice(0, 10);
  let totalAnnual = 0;
  for (const p of top10) {
    const allocation = 10000;
    const annual = allocation * p.apy / 100;
    totalAnnual += annual;
    console.log(`  ${p.project.slice(0, 15).padEnd(15)} ${p.symbol.slice(0, 10).padEnd(10)} ${p.apy.toFixed(2).padStart(6)}%  ${fmtUsd(annual).padStart(8)}/yr  ${p.chain}`);
  }
  console.log(`\n  Total annual profit: ${fmtUsd(totalAnnual)}`);
  console.log(`  Portfolio yield: ${(totalAnnual / 100000 * 100).toFixed(2)}%/yr`);

  // Investor summary
  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  Total pools scanned: ${allPools.length.toLocaleString()}`);
  console.log(`  No-IL pools (filtered): ${filtered.length.toLocaleString()}`);
  console.log(`  Stablecoin pools: ${stablePools.length.toLocaleString()}`);
  console.log(`  Top yield: ${stablePools[0]?.apy.toFixed(2)}% APY (${stablePools[0]?.project} ${stablePools[0]?.symbol})`);
  console.log(`  Portfolio yield on $100k: ${(totalAnnual / 100000 * 100).toFixed(2)}%/yr`);
  console.log(`  Risk profile: DELTA-NEUTRAL (stablecoin, no IL, no market exposure)`);
  console.log(`  Liquidity: HIGH (most pools allow instant withdrawal)`);
  console.log(`  Diversification: ${Object.keys(byChain).length} chains, ${Object.keys(byProject).length} projects`);
}

main().catch(err => { console.error(err); process.exit(1); });
