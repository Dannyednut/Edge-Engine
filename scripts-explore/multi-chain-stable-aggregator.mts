/**
 * Multi-Chain Stablecoin Yield Aggregator
 *
 * Aggregates top stablecoin yields across ALL chains including emerging:
 *   - Ethereum, Base, Arbitrum, Solana (major chains)
 *   - Sui, Aptos (Move chains)
 *   - Hyperliquid L1 (native HL ecosystem)
 *   - Monad, Sei (emerging)
 *   - Stacks (Bitcoin DeFi)
 *   - All others
 *
 * Strategy:
 *   - Find the best stablecoin yield on each chain
 *   - Diversify across chains to reduce chain-specific risk
 *   - All pools: delta-neutral (stablecoin, no IL)
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

const LLAMA_API = 'https://yields.llama.fi';

interface ChainBestYield {
  chain: string;
  symbol: string;
  project: string;
  apy: number;
  apy30d: number;
  tvlUsd: number;
  riskScore: number;
  dailyProfitOn10k: number;
}

async function fetchAllStablePools() {
  try {
    const res = await fetch(`${LLAMA_API}/pools`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const j = await res.json() as any;
    return (j?.data || [])
      .filter((p: any) => p.stablecoin)
      .filter((p: any) => p.ilRisk === 'no')
      .filter((p: any) => p.apy > 3)
      .filter((p: any) => p.tvlUsd > 1_000_000);
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

function calcRisk(pool: any): number {
  let score = 3;
  if (pool.tvlUsd > 100_000_000) score = 1;
  else if (pool.tvlUsd > 10_000_000) score = 2;
  else if (pool.tvlUsd < 2_000_000) score = 4;
  if (pool.apy > 30) score += 2;
  else if (pool.apy > 15) score += 1;
  const establishedProjects = ['morpho-blue', 'pendle-v2', 'aave-v3', 'sparklend', 'maple', 'sky-lending', 'jupiter-lend'];
  if (establishedProjects.includes(pool.project)) score = Math.max(1, score - 1);
  return Math.max(1, Math.min(10, score));
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Multi-Chain Stablecoin Yield Aggregator');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('  Best stablecoin yield on each chain');
  console.log('═══════════════════════════════════════════════════\n');

  const allPools = await fetchAllStablePools();
  console.log(`Total stablecoin pools scanned: ${allPools.length}\n`);

  // Find best yield on each chain
  const byChain: Record<string, any> = {};
  for (const p of allPools) {
    if (!byChain[p.chain] || (p.apy || 0) > (byChain[p.chain].apy || 0)) {
      byChain[p.chain] = p;
    }
  }

  const chainBest = Object.entries(byChain)
    .map(([chain, p]: [string, any]) => ({
      chain,
      symbol: p.symbol,
      project: p.project,
      apy: p.apy || 0,
      apy30d: p.apyMean30d || p.apy || 0,
      tvlUsd: p.tvlUsd || 0,
      riskScore: calcRisk(p),
      dailyProfitOn10k: 10000 * (p.apy || 0) / 100 / 365,
    }))
    .sort((a, b) => b.apy - a.apy);

  console.log('── BEST STABLECOIN YIELD ON EACH CHAIN ──\n');
  console.log('#  | Chain              | Symbol         | Project              | APY%    | 30d APY | TVL       | Risk | Daily/$10k');
  console.log('───|────────────────────|────────────────|──────────────────────|─────────|─────────|───────────|──────|───────────');
  for (let i = 0; i < chainBest.length; i++) {
    const p = chainBest[i];
    console.log(
      `${String(i + 1).padStart(2)} | ${p.chain.padEnd(18)} | ${p.symbol.slice(0, 14).padEnd(14)} | ${p.project.slice(0, 20).padEnd(20)} | ` +
      `${p.apy.toFixed(2).padStart(7)}% | ${p.apy30d.toFixed(2).padStart(7)}% | ${fmtUsd(p.tvlUsd).padStart(9)} | ` +
      `${String(p.riskScore).padStart(4)}/10 | ${fmtUsd(p.dailyProfitOn10k).padStart(9)}/d`
    );
  }

  // Top 10 by TVL (safest)
  console.log('\n── TOP 10 CHAINS BY TVL (safest) ──\n');
  const byTvl = [...chainBest].sort((a, b) => b.tvlUsd - a.tvlUsd);
  console.log('#  | Chain              | Symbol         | Project              | APY%    | TVL       | Risk');
  console.log('───|────────────────────|────────────────|──────────────────────|─────────|───────────|──────');
  for (let i = 0; i < Math.min(10, byTvl.length); i++) {
    const p = byTvl[i];
    console.log(
      `${String(i + 1).padStart(2)} | ${p.chain.padEnd(18)} | ${p.symbol.slice(0, 14).padEnd(14)} | ${p.project.slice(0, 20).padEnd(20)} | ` +
      `${p.apy.toFixed(2).padStart(7)}% | ${fmtUsd(p.tvlUsd).padStart(9)} | ${String(p.riskScore).padStart(4)}/10`
    );
  }

  // Portfolio projection — best yield on each of top 10 chains
  console.log('\n── PORTFOLIO PROJECTION ($100k across top 10 chains, $10k each) ──');
  const top10 = chainBest.slice(0, 10);
  let totalAnnual = 0;
  let totalDaily = 0;
  let weightedRisk = 0;
  for (const p of top10) {
    const allocation = 10000;
    const annual = allocation * p.apy / 100;
    const daily = annual / 365;
    totalAnnual += annual;
    totalDaily += daily;
    weightedRisk += p.riskScore * allocation;
    console.log(`  ${p.chain.padEnd(18)} ${p.symbol.slice(0, 14).padEnd(14)} ${p.apy.toFixed(2).padStart(6)}%  ${fmtUsd(annual).padStart(8)}/yr  risk ${p.riskScore}/10`);
  }
  weightedRisk /= 100000;
  console.log(`\n  Total daily profit: ${fmtUsd(totalDaily)}`);
  console.log(`  Total monthly: ${fmtUsd(totalDaily * 30)}`);
  console.log(`  Total annual: ${fmtUsd(totalAnnual)}`);
  console.log(`  Portfolio yield: ${(totalAnnual / 100000 * 100).toFixed(2)}%/yr`);
  console.log(`  Weighted risk: ${weightedRisk.toFixed(1)}/10`);

  // Conservative portfolio — only established chains (TVL > $100M)
  console.log('\n── CONSERVATIVE PORTFOLIO (only TVL > $100M, $100k) ──');
  const conservative = byTvl.filter(p => p.tvlUsd > 100_000_000).slice(0, 10);
  let consAnnual = 0;
  let consRisk = 0;
  for (const p of conservative) {
    const allocation = 100000 / conservative.length;
    const annual = allocation * p.apy / 100;
    consAnnual += annual;
    consRisk += p.riskScore * allocation;
    console.log(`  ${p.chain.padEnd(18)} ${p.symbol.slice(0, 14).padEnd(14)} ${p.apy.toFixed(2).padStart(6)}%  ${fmtUsd(annual).padStart(8)}/yr  TVL ${fmtUsd(p.tvlUsd)}`);
  }
  consRisk /= 100000;
  console.log(`\n  Total annual: ${fmtUsd(consAnnual)}`);
  console.log(`  Portfolio yield: ${(consAnnual / 100000 * 100).toFixed(2)}%/yr`);
  console.log(`  Weighted risk: ${consRisk.toFixed(1)}/10 (LOWER)`);

  // Investor summary
  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  Total chains with stablecoin yields: ${chainBest.length}`);
  console.log(`  Total stablecoin pools scanned: ${allPools.length}`);
  console.log(`  Top yield: ${chainBest[0]?.apy.toFixed(2)}% APY (${chainBest[0]?.symbol} on ${chainBest[0]?.chain})`);
  console.log(`  Top TVL chain: ${byTvl[0]?.chain} (${fmtUsd(byTvl[0]?.tvlUsd || 0)} TVL)`);
  console.log(`  Aggressive portfolio yield on $100k: ${(totalAnnual / 100000 * 100).toFixed(2)}%/yr`);
  console.log(`  Conservative portfolio yield on $100k: ${(consAnnual / 100000 * 100).toFixed(2)}%/yr`);
  console.log(`  Risk: Aggressive ${weightedRisk.toFixed(1)}/10, Conservative ${consRisk.toFixed(1)}/10`);
  console.log(`  All pools: delta-neutral (stablecoin, no IL risk)`);
  console.log(`  Diversification: ${chainBest.length} chains (max chain-specific risk diversification)`);
}

main().catch(err => { console.error(err); process.exit(1); });
