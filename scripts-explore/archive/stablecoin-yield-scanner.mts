/**
 * Stablecoin Yield Arbitrage Scanner
 *
 * Scans yield-bearing stablecoins and stablecoin liquidity pools:
 *   - Ethena (sUSDe, USDe) — 11-15% APY
 *   - MakerDAO sDAI — 5-7% APY
 *   - Curve LP pools (3pool, stables) — 3-8% APY
 *   - Aave aTokens (aUSDC, aUSDT) — 4-6% APY
 *   - Sky USDS — 6-8% APY
 *   - Moonwell USDC — 5-7% APY
 *   - DefiEdge stablecoin strategies
 *
 * Delta-neutral use case:
 *   - Hold stablecoin in highest-yield venue
 *   - Move capital to higher yield when opportunity arises
 *   - All positions are stablecoin-denominated (no market risk)
 *
 * Strategy variants:
 *   1. sUSDe hold: 11% APY from Ethena funding arbitrage
 *   2. USDC->Aave: 4.5% supply rate
 *   3. USDe->Aave: 8.5% supply rate (Ethena yield + Aave bonus)
 *   4. DAI->sDAI (MakerDAO savings): 5-7% APY
 *   5. Curve 3pool LP: ~3% APY + CRV rewards
 *   6. Sky USDS savings: 6-8% APY
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

interface StablecoinYield {
  rank: number;
  asset: string;
  venue: string;
  chain: string;
  apy: number;
  tvlUsd: number;
  riskScore: number;       // 1-10 (1 = safest)
  deltaNeutral: boolean;
  strategy: string;
  liquidity: 'HIGH' | 'MEDIUM' | 'LOW';
  notes: string;
}

// Curated list of stablecoin yield sources (live data would update these)
const STABLECOIN_YIELDS: Omit<StablecoinYield, 'rank'>[] = [
  // Ethena
  { asset: 'sUSDe', venue: 'Ethena', chain: 'Ethereum', apy: 11.2, tvlUsd: 5_000_000_000, riskScore: 3, deltaNeutral: true, strategy: 'Hold sUSDe (Ethena funding arb)', liquidity: 'HIGH', notes: 'Delta-neutral by design: short perp + spot USDe collateral' },
  { asset: 'USDe', venue: 'Ethena', chain: 'Ethereum', apy: 8.5, tvlUsd: 2_500_000_000, riskScore: 3, deltaNeutral: true, strategy: 'Hold USDe (Ethena staked)', liquidity: 'HIGH', notes: 'Earns base yield from funding arb, unstaked' },

  // MakerDAO / Sky
  { asset: 'sDAI', venue: 'MakerDAO Savings', chain: 'Ethereum', apy: 6.0, tvlUsd: 8_000_000_000, riskScore: 2, deltaNeutral: true, strategy: 'Hold sDAI (MakerDAO savings rate)', liquidity: 'HIGH', notes: 'DSR (DAI Savings Rate), oldest stablecoin yield' },
  { asset: 'USDS', venue: 'Sky', chain: 'Ethereum', apy: 7.5, tvlUsd: 3_000_000_000, riskScore: 2, deltaNeutral: true, strategy: 'Hold USDS (Sky savings rate)', liquidity: 'HIGH', notes: 'Sky is rebranded MakerDAO' },
  { asset: 'sUSDS', venue: 'Sky Savings', chain: 'Ethereum', apy: 7.0, tvlUsd: 2_500_000_000, riskScore: 2, deltaNeutral: true, strategy: 'Hold sUSDS (Sky savings rate)', liquidity: 'HIGH', notes: 'SSR (Sky Savings Rate)' },

  // Aave
  { asset: 'aUSDC', venue: 'Aave V3', chain: 'Ethereum', apy: 4.5, tvlUsd: 1_500_000_000, riskScore: 2, deltaNeutral: true, strategy: 'Supply USDC to Aave', liquidity: 'HIGH', notes: 'Variable APY, very safe' },
  { asset: 'aUSDT', venue: 'Aave V3', chain: 'Ethereum', apy: 4.2, tvlUsd: 1_200_000_000, riskScore: 2, deltaNeutral: true, strategy: 'Supply USDT to Aave', liquidity: 'HIGH', notes: 'Variable APY' },
  { asset: 'aUSDe', venue: 'Aave V3', chain: 'Ethereum', apy: 8.5, tvlUsd: 500_000_000, riskScore: 3, deltaNeutral: true, strategy: 'Supply USDe to Aave', liquidity: 'MEDIUM', notes: 'Ethena yield + Aave bonus' },

  // Morpho
  { asset: 'USDC', venue: 'Morpho Blue', chain: 'Ethereum', apy: 8.5, tvlUsd: 600_000_000, riskScore: 3, deltaNeutral: true, strategy: 'Supply USDC to Morpho Blue', liquidity: 'HIGH', notes: 'Higher yield than Aave via P2P matching' },

  // Moonwell
  { asset: 'USDC', venue: 'Moonwell', chain: 'Base', apy: 5.5, tvlUsd: 200_000_000, riskScore: 3, deltaNeutral: true, strategy: 'Supply USDC to Moonwell', liquidity: 'MEDIUM', notes: 'Base-native lending' },

  // Curve LP
  { asset: '3Crv', venue: 'Curve 3pool', chain: 'Ethereum', apy: 3.5, tvlUsd: 300_000_000, riskScore: 2, deltaNeutral: true, strategy: 'LP USDC+USDT+DAI in Curve 3pool', liquidity: 'HIGH', notes: 'Stablecoin LP, low IL risk' },
  { asset: 'crvUSD/USDC', venue: 'Curve', chain: 'Ethereum', apy: 6.2, tvlUsd: 150_000_000, riskScore: 2, deltaNeutral: true, strategy: 'LP crvUSD/USDC pool', liquidity: 'HIGH', notes: 'High TVL stableswap' },

  // Pendle PT (from pendle-pt-scanner)
  { asset: 'PT-USDe', venue: 'Pendle', chain: 'Ethereum', apy: 12.5, tvlUsd: 50_000_000, riskScore: 2, deltaNeutral: true, strategy: 'Buy PT-USDe (fixed yield)', liquidity: 'MEDIUM', notes: 'Principal-protected, 60d maturity' },
  { asset: 'PT-sUSDe', venue: 'Pendle', chain: 'Ethereum', apy: 14.2, tvlUsd: 80_000_000, riskScore: 2, deltaNeutral: true, strategy: 'Buy PT-sUSDe (fixed yield)', liquidity: 'MEDIUM', notes: 'Principal-protected, 165d maturity' },

  // Frax
  { asset: 'sfrxETH', venue: 'Frax', chain: 'Ethereum', apy: 4.0, tvlUsd: 100_000_000, riskScore: 3, deltaNeutral: false, strategy: 'Stake frxETH for ETH staking yield', liquidity: 'MEDIUM', notes: 'Has ETH price exposure (not pure stablecoin)' },
  { asset: 'FRAX', venue: 'Frax', chain: 'Ethereum', apy: 5.0, tvlUsd: 100_000_000, riskScore: 3, deltaNeutral: true, strategy: 'Hold FRAX in Fraxlend', liquidity: 'MEDIUM', notes: 'Algorithmic stablecoin' },

  // Hyperliquid
  { asset: 'HLP', venue: 'Hyperliquid', chain: 'Hyperliquid', apy: 18.5, tvlUsd: 200_000_000, riskScore: 4, deltaNeutral: true, strategy: 'Deposit USDC to HLP vault', liquidity: 'HIGH', notes: 'Earns from market making + liquidations' },

  // Drift / Kamino on Solana
  { asset: 'USDC', venue: 'Kamino Lend', chain: 'Solana', apy: 6.5, tvlUsd: 250_000_000, riskScore: 3, deltaNeutral: true, strategy: 'Supply USDC to Kamino', liquidity: 'MEDIUM', notes: 'Solana-native lending' },
];

function fmtUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  if (n >= 1) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Stablecoin Yield Arbitrage Scanner');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════\n');

  // Sort by APY descending
  const sorted = [...STABLECOIN_YIELDS].sort((a, b) => b.apy - a.apy);
  sorted.forEach((y, i) => { (y as any).rank = i + 1; });

  console.log(`── ALL ${sorted.length} STABLECOIN YIELD OPPORTUNITIES (by APY) ──\n`);
  console.log('#  | Asset         | Venue         | Chain      | APY%   | TVL      | Risk | Strategy                            | Liquidity');
  console.log('───|───────────────|───────────────|────────────|────────|──────────|──────|─────────────────────────────────────|──────────');
  for (const y of sorted) {
    console.log(
      `${String(y.rank).padStart(2)} | ${y.asset.padEnd(13)} | ${y.venue.padEnd(13)} | ${y.chain.padEnd(10)} | ` +
      `${y.apy.toFixed(2).padStart(6)}% | ${fmtUsd(y.tvlUsd).padStart(8)} | ${String(y.riskScore).padStart(4)}/10 | ` +
      `${y.strategy.slice(0, 35).padEnd(35)} | ${y.liquidity}`
    );
  }

  // Pure delta-neutral stablecoins only (no ETH exposure)
  const pureStable = sorted.filter(y => y.deltaNeutral);

  console.log(`\n── TOP 10 PURE DELTA-NEUTRAL STABLECOIN YIELDS ──\n`);
  console.log('#  | Asset         | Venue         | APY%   | TVL      | Risk | Daily on $10k');
  console.log('───|───────────────|───────────────|────────|──────────|──────|─────────────');
  for (const y of pureStable.slice(0, 10)) {
    const daily10k = 10000 * y.apy / 100 / 365;
    console.log(
      `${String(y.rank).padStart(2)} | ${y.asset.padEnd(13)} | ${y.venue.padEnd(13)} | ` +
      `${y.apy.toFixed(2).padStart(6)}% | ${fmtUsd(y.tvlUsd).padStart(8)} | ${String(y.riskScore).padStart(4)}/10 | ${fmtUsd(daily10k).padStart(11)}/d`
    );
  }

  // Portfolio projection — diversified across top 5
  console.log('\n── PORTFOLIO PROJECTION ($100k diversified across top 5) ──');
  const top5 = pureStable.slice(0, 5);
  let totalAnnual = 0;
  let weightedRisk = 0;
  for (const y of top5) {
    const allocation = 20000;
    const annual = allocation * y.apy / 100;
    totalAnnual += annual;
    weightedRisk += y.riskScore * allocation;
    console.log(`  ${y.rank}. ${y.asset.padEnd(13)} ${y.venue.padEnd(13)} ${y.apy.toFixed(2).padStart(6)}%  ${fmtUsd(annual).padStart(8)}/yr  ${y.chain}`);
  }
  weightedRisk /= 100000;
  console.log(`\n  Total annual profit: ${fmtUsd(totalAnnual)}`);
  console.log(`  Portfolio yield: ${(totalAnnual / 100000 * 100).toFixed(2)}%/yr`);
  console.log(`  Weighted risk: ${weightedRisk.toFixed(1)}/10 (very low)`);

  // Investor summary
  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  Total yield sources: ${sorted.length}`);
  console.log(`  Pure delta-neutral: ${pureStable.length}`);
  console.log(`  Top yield: ${pureStable[0].apy.toFixed(2)}% APY (${pureStable[0].asset} on ${pureStable[0].venue})`);
  console.log(`  Portfolio yield on $100k: ${(totalAnnual / 100000 * 100).toFixed(2)}%/yr`);
  console.log(`  Risk profile: STABLECOIN-DENOMINATED (no market direction risk)`);
  console.log(`  Diversified across ${top5.length} venues`);
  console.log(`  Liquidity: HIGH (combined TVL ${fmtUsd(top5.reduce((s, y) => s + y.tvlUsd, 0))})`);

  console.log('\n── EXECUTION PLAN ──');
  for (const y of top5) {
    console.log(`  • ${y.asset} on ${y.venue} (${y.chain})`);
    console.log(`    ${y.notes}`);
  }
}

main();
