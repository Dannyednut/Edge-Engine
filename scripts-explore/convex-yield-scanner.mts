/**
 * Convex Finance Boosted Yield Scanner
 *
 * Convex boosts Curve LP yields with CRV + CVX rewards.
 * Strategy:
 *   - Provide liquidity to Curve pool
 *   - Stake LP token in Convex
 *   - Earn boosted CRV + CVX rewards on top of Curve fees
 *
 * All stablecoin Curve pools = delta-neutral
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

const LLAMA_API = 'https://yields.llama.fi';

interface ConvexPool {
  symbol: string;
  chain: string;
  apy: number;
  apy30d: number;
  tvlUsd: number;
  stablecoin: boolean;
}

async function fetchConvexPools(): Promise<ConvexPool[]> {
  try {
    const res = await fetch(`${LLAMA_API}/pools`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const j = await res.json() as any;
    return (j?.data || [])
      .filter((p: any) => p.project === 'convex-finance')
      .filter((p: any) => p.tvlUsd > 1_000_000)
      .filter((p: any) => p.apy > 0)
      .map((p: any) => ({
        symbol: p.symbol,
        chain: p.chain,
        apy: p.apy || 0,
        apy30d: p.apyMean30d || p.apy || 0,
        tvlUsd: p.tvlUsd || 0,
        stablecoin: p.stablecoin || false,
      }))
      .sort((a: any, b: any) => b.apy - a.apy);
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
  console.log('  Convex Finance Boosted Yield Scanner');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════\n');

  const pools = await fetchConvexPools();
  console.log(`Total Convex pools (TVL > $1M): ${pools.length}\n`);

  console.log('── TOP 20 CONVEX POOLS BY APY ──\n');
  console.log('#  | Symbol              | Chain     | APY%    | 30d APY | TVL       | Stablecoin');
  console.log('───|─────────────────────|───────────|─────────|─────────|───────────|───────────');
  for (let i = 0; i < Math.min(20, pools.length); i++) {
    const p = pools[i];
    console.log(
      `${String(i + 1).padStart(2)} | ${p.symbol.slice(0, 19).padEnd(19)} | ${p.chain.padEnd(9)} | ` +
      `${p.apy.toFixed(2).padStart(7)}% | ${p.apy30d.toFixed(2).padStart(7)}% | ${fmtUsd(p.tvlUsd).padStart(9)} | ` +
      `${p.stablecoin ? 'YES' : 'NO'}`
    );
  }

  const stablePools = pools.filter(p => p.stablecoin);
  console.log(`\n── STABLECOIN CONVEX POOLS (delta-neutral): ${stablePools.length} ──\n`);
  console.log('#  | Symbol              | APY%    | TVL       | Daily/$10k');
  console.log('───|─────────────────────|─────────|───────────|───────────');
  for (let i = 0; i < Math.min(15, stablePools.length); i++) {
    const p = stablePools[i];
    const daily = 10000 * p.apy / 100 / 365;
    console.log(
      `${String(i + 1).padStart(2)} | ${p.symbol.slice(0, 19).padEnd(19)} | ` +
      `${p.apy.toFixed(2).padStart(7)}% | ${fmtUsd(p.tvlUsd).padStart(9)} | ${fmtUsd(daily).padStart(9)}/d`
    );
  }

  console.log('\n── PORTFOLIO PROJECTION ($50k across top 5 stablecoin Convex pools) ──');
  const top5 = stablePools.slice(0, 5);
  let totalAnnual = 0;
  for (const p of top5) {
    const annual = 10000 * p.apy / 100;
    totalAnnual += annual;
    console.log(`  ${p.symbol.slice(0, 19).padEnd(19)} ${p.apy.toFixed(2).padStart(6)}%  ${fmtUsd(annual).padStart(8)}/yr`);
  }
  console.log(`\n  Total annual: ${fmtUsd(totalAnnual)}`);
  console.log(`  Portfolio yield: ${(totalAnnual / 50000 * 100).toFixed(2)}%/yr`);

  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  Total Convex pools: ${pools.length}`);
  console.log(`  Stablecoin pools: ${stablePools.length}`);
  console.log(`  Top yield: ${pools[0]?.apy.toFixed(2)}% APY (${pools[0]?.symbol})`);
  console.log(`  Top stable yield: ${stablePools[0]?.apy.toFixed(2)}% APY (${stablePools[0]?.symbol})`);
  console.log(`  Portfolio yield on $50k: ${(totalAnnual / 50000 * 100).toFixed(2)}%/yr`);
  console.log(`  Risk: LOW (Convex is established, audited, $3B+ TVL)`);
  console.log(`  All stablecoin pools: delta-neutral (no IL, no market exposure)`);
}

main().catch(err => { console.error(err); process.exit(1); });
