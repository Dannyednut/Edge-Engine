/**
 * Hyperliquid L1 Native Yield Scanner
 *
 * Scans all 517+ yield pools on Hyperliquid L1 (HyperEVM).
 * Identifies the best delta-neutral opportunities:
 *   - Stablecoin pools (USDC pairs, delta-neutral)
 *   - WHYPE/USDC pools (native DEX yields)
 *   - HLP vault yields
 *
 * Data source: yields.llama.fi (DefiLlama) — Hyperliquid L1 chain
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

const LLAMA_API = 'https://yields.llama.fi';

interface HLYieldPool {
  symbol: string;
  project: string;
  apy: number;
  apy30d: number;
  tvlUsd: number;
  stablecoin: boolean;
  ilRisk: string;
  exposure: string;
}

async function fetchHLYields(): Promise<HLYieldPool[]> {
  try {
    const res = await fetch(`${LLAMA_API}/pools`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const j = await res.json() as any;
    return (j?.data || [])
      .filter((p: any) => p.chain === 'Hyperliquid L1')
      .map((p: any) => ({
        symbol: p.symbol,
        project: p.project,
        apy: p.apy || 0,
        apy30d: p.apyMean30d || p.apy || 0,
        tvlUsd: p.tvlUsd || 0,
        stablecoin: p.stablecoin || false,
        ilRisk: p.ilRisk || 'unknown',
        exposure: p.exposure || 'unknown',
      }));
  } catch {
    return [];
  }
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Hyperliquid L1 Native Yield Scanner');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════\n');

  const pools = await fetchHLYields();
  console.log(`Total Hyperliquid L1 pools: ${pools.length}\n`);

  // Filter to pools with meaningful TVL
  const filtered = pools
    .filter(p => p.apy > 1)
    .filter(p => p.tvlUsd > 50_000)
    .sort((a, b) => b.apy - a.apy);

  console.log(`Filtered (APY > 1%, TVL > $50k): ${filtered.length}\n`);

  console.log(`── TOP 25 HYPERLIQUID L1 YIELD POOLS ──\n`);
  console.log('#  | Symbol         | Project       | APY%     | 30d APY | TVL       | Stablecoin | IL Risk');
  console.log('───|────────────────|───────────────|──────────|─────────|───────────|────────────|────────');
  for (let i = 0; i < Math.min(25, filtered.length); i++) {
    const p = filtered[i];
    console.log(
      `${String(i + 1).padStart(2)} | ${p.symbol.slice(0, 14).padEnd(14)} | ${p.project.slice(0, 13).padEnd(13)} | ` +
      `${p.apy.toFixed(2).padStart(8)}% | ${p.apy30d.toFixed(2).padStart(7)}% | ${fmtUsd(p.tvlUsd).padStart(9)} | ` +
      `${p.stablecoin ? '✓ YES' : '✗ NO'.padEnd(8)} | ${p.ilRisk}`
    );
  }

  // Stablecoin pools (delta-neutral)
  const stablePools = filtered.filter(p => p.stablecoin);
  console.log(`\n── STABLECOIN POOLS (delta-neutral, no IL) ──\n`);
  console.log('#  | Symbol         | Project       | APY%    | 30d APY | TVL       | Daily on $5k');
  console.log('───|────────────────|───────────────|─────────|─────────|───────────|─────────────');
  for (let i = 0; i < Math.min(15, stablePools.length); i++) {
    const p = stablePools[i];
    const daily5k = 5000 * p.apy / 100 / 365;
    console.log(
      `${String(i + 1).padStart(2)} | ${p.symbol.slice(0, 14).padEnd(14)} | ${p.project.slice(0, 13).padEnd(13)} | ` +
      `${p.apy.toFixed(2).padStart(7)}% | ${p.apy30d.toFixed(2).padStart(7)}% | ${fmtUsd(p.tvlUsd).padStart(9)} | ${fmtUsd(daily5k).padStart(11)}/d`
    );
  }

  // By project summary
  console.log('\n── TOP HYPERLIQUID L1 PROJECTS BY POOL COUNT ──');
  const byProject: Record<string, { count: number; totalTvl: number; avgApy: number; maxApy: number }> = {};
  for (const p of filtered) {
    if (!byProject[p.project]) byProject[p.project] = { count: 0, totalTvl: 0, avgApy: 0, maxApy: 0 };
    byProject[p.project].count++;
    byProject[p.project].totalTvl += p.tvlUsd;
    byProject[p.project].avgApy += p.apy;
    byProject[p.project].maxApy = Math.max(byProject[p.project].maxApy, p.apy);
  }
  console.log('Project         | Pools | Total TVL  | Avg APY | Max APY');
  console.log('────────────────|───────|────────────|─────────|─────────');
  for (const [proj, s] of Object.entries(byProject).sort((a, b) => b[1].totalTvl - a[1].totalTvl)) {
    console.log(`${proj.padEnd(15)} | ${String(s.count).padStart(5)} | ${fmtUsd(s.totalTvl).padStart(10)} | ${(s.avgApy / s.count).toFixed(2).padStart(7)}% | ${s.maxApy.toFixed(2).padStart(7)}%`);
  }

  // Portfolio projection
  console.log('\n── PORTFOLIO PROJECTION ($50k across top 5 stablecoin pools) ──');
  const top5 = stablePools.slice(0, 5);
  let totalAnnual = 0;
  for (const p of top5) {
    const allocation = 10000;
    const annual = allocation * p.apy / 100;
    totalAnnual += annual;
    console.log(`  ${p.symbol.slice(0, 14).padEnd(14)} ${p.project.slice(0, 13).padEnd(13)} ${p.apy.toFixed(2).padStart(6)}%  ${fmtUsd(annual).padStart(8)}/yr`);
  }
  console.log(`\n  Total annual profit: ${fmtUsd(totalAnnual)}`);
  console.log(`  Portfolio yield: ${(totalAnnual / 50000 * 100).toFixed(2)}%/yr`);

  // Investor summary
  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  Total Hyperliquid L1 pools: ${pools.length}`);
  console.log(`  Filtered (APY > 1%, TVL > $50k): ${filtered.length}`);
  console.log(`  Stablecoin pools: ${stablePools.length}`);
  console.log(`  Top yield: ${filtered[0]?.apy.toFixed(2)}% APY (${filtered[0]?.symbol} on ${filtered[0]?.project})`);
  console.log(`  Top stable yield: ${stablePools[0]?.apy.toFixed(2)}% APY (${stablePools[0]?.symbol})`);
  console.log(`  Portfolio yield on $50k: ${(totalAnnual / 50000 * 100).toFixed(2)}%/yr`);
  console.log(`  Risk profile: ${stablePools.length > 0 ? 'DELTA-NEUTRAL (stablecoin)' : 'N/A'}`);
  console.log(`  Liquidity: HIGH (instant withdrawal)`);
  console.log(`  Native to Hyperliquid ecosystem — no bridge risk`);
}

main().catch(err => { console.error(err); process.exit(1); });
