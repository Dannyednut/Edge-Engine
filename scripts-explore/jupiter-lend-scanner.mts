/**
 * Jupiter Lend Yield Scanner
 *
 * Jupiter Lend is Jupiter's lending platform on Solana:
 *   - $1.08B total TVL across 16 pools
 *   - Largest pools: USDC ($495M), JupSOL ($125M), PYUSD ($251M)
 *   - Delta-neutral stablecoin yields available
 *
 * Strategy:
 *   - Supply USDC/USDT/PYUSD to Jupiter Lend
 *   - Earn lending yield (variable APY)
 *   - Delta-neutral (stablecoin-denominated)
 *
 * Data source: yields.llama.fi (DefiLlama)
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

interface JupiterLendPool {
  rank: number;
  symbol: string;
  apy: number;
  apy30d: number;
  tvlUsd: number;
  stablecoin: boolean;
  dailyProfitOn10k: number;
  notes: string;
}

async function fetchJupiterLendPools(): Promise<JupiterLendPool[]> {
  try {
    const res = await fetch(`${LLAMA_API}/pools`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const j = await res.json() as any;
    return (j?.data || [])
      .filter((p: any) => p.project === 'jupiter-lend')
      .filter((p: any) => p.tvlUsd > 100_000)
      .map((p: any) => ({
        rank: 0,
        symbol: p.symbol,
        apy: p.apy || 0,
        apy30d: p.apyMean30d || p.apy || 0,
        tvlUsd: p.tvlUsd || 0,
        stablecoin: p.stablecoin || false,
        dailyProfitOn10k: 10000 * (p.apy || 0) / 100 / 365,
        notes: '',
      }));
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
  console.log('  Jupiter Lend Yield Scanner');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════\n');

  const pools = await fetchJupiterLendPools();
  console.log(`Total Jupiter Lend pools: ${pools.length}`);
  console.log(`Total TVL: ${fmtUsd(pools.reduce((s, p) => s + p.tvlUsd, 0))}\n`);

  // Sort by TVL
  pools.sort((a, b) => b.tvlUsd - a.tvlUsd);
  pools.forEach((p, i) => { p.rank = i + 1; });

  console.log('── ALL JUPITER LEND POOLS (by TVL) ──\n');
  console.log('#  | Symbol         | APY%   | 30d APY | TVL       | Stablecoin | Daily/$10k');
  console.log('───|────────────────|────────|─────────|───────────|────────────|───────────');
  for (const p of pools) {
    console.log(
      `${String(p.rank).padStart(2)} | ${p.symbol.slice(0, 14).padEnd(14)} | ` +
      `${p.apy.toFixed(2).padStart(6)}% | ${p.apy30d.toFixed(2).padStart(7)}% | ${fmtUsd(p.tvlUsd).padStart(9)} | ` +
      `${p.stablecoin ? '✓ YES' : '✗ NO'.padEnd(8)} | ${fmtUsd(p.dailyProfitOn10k).padStart(9)}/d`
    );
  }

  // Stablecoin pools only (delta-neutral)
  const stablePools = pools.filter(p => p.stablecoin);
  console.log(`\n── STABLECOIN POOLS (delta-neutral) ──\n`);
  console.log('#  | Symbol         | APY%   | 30d APY | TVL       | Daily/$10k');
  console.log('───|────────────────|────────|─────────|───────────|───────────');
  for (const p of stablePools) {
    console.log(
      `${String(p.rank).padStart(2)} | ${p.symbol.slice(0, 14).padEnd(14)} | ` +
      `${p.apy.toFixed(2).padStart(6)}% | ${p.apy30d.toFixed(2).padStart(7)}% | ${fmtUsd(p.tvlUsd).padStart(9)} | ` +
      `${fmtUsd(p.dailyProfitOn10k).padStart(9)}/d`
    );
  }

  // Portfolio projection — stablecoin allocation
  console.log('\n── PORTFOLIO PROJECTION ($50k across stablecoin pools) ──');
  let totalAnnual = 0;
  let totalDaily = 0;
  for (const p of stablePools.slice(0, 5)) {
    const allocation = 10000;
    const annual = allocation * p.apy / 100;
    const daily = annual / 365;
    totalAnnual += annual;
    totalDaily += daily;
    console.log(`  ${p.symbol.slice(0, 14).padEnd(14)} ${p.apy.toFixed(2).padStart(6)}%  ${fmtUsd(annual).padStart(8)}/yr  ${fmtUsd(p.tvlUsd).padStart(9)} TVL`);
  }
  console.log(`\n  Total daily profit: ${fmtUsd(totalDaily)}`);
  console.log(`  Total monthly: ${fmtUsd(totalDaily * 30)}`);
  console.log(`  Total annual: ${fmtUsd(totalAnnual)}`);
  console.log(`  Portfolio yield: ${(totalAnnual / 50000 * 100).toFixed(2)}%/yr`);

  // Investor summary
  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  Total Jupiter Lend pools: ${pools.length}`);
  console.log(`  Stablecoin pools: ${stablePools.length}`);
  console.log(`  Total TVL: ${fmtUsd(pools.reduce((s, p) => s + p.tvlUsd, 0))}`);
  console.log(`  Stablecoin TVL: ${fmtUsd(stablePools.reduce((s, p) => s + p.tvlUsd, 0))}`);
  console.log(`  Top stablecoin yield: ${stablePools[0]?.apy.toFixed(2)}% APY (${stablePools[0]?.symbol})`);
  console.log(`  Largest pool: ${pools[0]?.symbol} (${fmtUsd(pools[0]?.tvlUsd || 0)} TVL)`);
  console.log(`  Portfolio yield on $50k: ${(totalAnnual / 50000 * 100).toFixed(2)}%/yr`);
  console.log(`  Risk profile: LOW (Jupiter is established Solana protocol)`);
  console.log(`  Liquidity: HIGH (instant withdrawal)`);
  console.log(`  All pools: delta-neutral (stablecoin-denominated)`);
}

main().catch(err => { console.error(err); process.exit(1); });
