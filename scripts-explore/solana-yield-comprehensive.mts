/**
 * Solana Yield Comprehensive Scanner
 *
 * Aggregates ALL Solana yield opportunities from DefiLlama:
 *   - LST staking yields (JitoSOL, mSOL, bSOL, JupSOL, etc.)
 *   - Stablecoin yields (USDC, USDT, PYUSD)
 *   - Jupiter LP (JLP) — perp liquidity provider
 *   - Solend, Kamino, MarginFi lending
 *   - Sanctum Infinity (LST liquidity)
 *   - Drift perp DEX yield
 *
 * Strategy:
 *   - Stablecoin yields: delta-neutral (no market exposure)
 *   - LST yields: minor exposure via LST (mostly delta-neutral via staking yield)
 *   - JLP: delta-neutral (perp LP = market making)
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

const LLAMA_API = 'https://yields.llama.fi';

interface SolanaPool {
  rank: number;
  symbol: string;
  project: string;
  apy: number;
  apy30d: number;
  tvlUsd: number;
  category: 'STABLE' | 'LST' | 'PERP_LP' | 'OTHER';
  riskScore: number;
  deltaNeutral: boolean;
  dailyProfitOn10k: number;
}

async function fetchSolanaPools(): Promise<SolanaPool[]> {
  try {
    const res = await fetch(`${LLAMA_API}/pools`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const j = await res.json() as any;
    return (j?.data || [])
      .filter((p: any) => p.chain === 'Solana')
      .filter((p: any) => p.ilRisk === 'no')  // no IL risk
      .filter((p: any) => p.apy > 0)
      .filter((p: any) => p.tvlUsd > 1_000_000)
      .map((p: any) => {
        const sym = (p.symbol || '').toLowerCase();
        let category: 'STABLE' | 'LST' | 'PERP_LP' | 'OTHER' = 'OTHER';
        if (p.stablecoin) category = 'STABLE';
        else if (sym.includes('jitosol') || sym.includes('msol') || sym.includes('bsol') ||
                 sym.includes('jupsol') || sym.includes('dsol') || sym.includes('bnsol') ||
                 sym.includes('bbsol') || sym.includes('jsol') || sym.includes('psol') ||
                 sym.includes('vsol') || sym.includes('inf') || sym.includes('dfdv') ||
                 sym.includes('sol-') || sym.includes('-sol')) {
          category = 'LST';
        } else if (sym.includes('jlp')) {
          category = 'PERP_LP';
        }
        const deltaNeutral = category === 'STABLE' || category === 'PERP_LP';
        let riskScore = 3;
        if (category === 'STABLE') riskScore = 2;
        if (category === 'LST') riskScore = 3;
        if (category === 'PERP_LP') riskScore = 4;
        if (p.tvlUsd > 100_000_000) riskScore = Math.max(1, riskScore - 1);
        return {
          rank: 0,
          symbol: p.symbol,
          project: p.project,
          apy: p.apy || 0,
          apy30d: p.apyMean30d || p.apy || 0,
          tvlUsd: p.tvlUsd || 0,
          category,
          riskScore,
          deltaNeutral,
          dailyProfitOn10k: 10000 * (p.apy || 0) / 100 / 365,
        };
      });
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
  console.log('  Solana Yield Comprehensive Scanner');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════\n');

  const pools = await fetchSolanaPools();
  console.log(`Total Solana pools (no IL, TVL > $1M): ${pools.length}\n`);

  // Sort by TVL (largest = safest)
  pools.sort((a, b) => b.tvlUsd - a.tvlUsd);
  pools.forEach((p, i) => { p.rank = i + 1; });

  console.log('── TOP 25 SOLANA POOLS BY TVL ──\n');
  console.log('#  | Symbol         | Project                    | APY%   | 30d APY | TVL       | Category | Risk | Delta-N');
  console.log('───|────────────────|────────────────────────────|────────|─────────|───────────|──────────|──────|────────');
  for (let i = 0; i < Math.min(25, pools.length); i++) {
    const p = pools[i];
    console.log(
      `${String(i + 1).padStart(2)} | ${p.symbol.slice(0, 14).padEnd(14)} | ${p.project.slice(0, 26).padEnd(26)} | ` +
      `${p.apy.toFixed(2).padStart(6)}% | ${p.apy30d.toFixed(2).padStart(7)}% | ${fmtUsd(p.tvlUsd).padStart(9)} | ` +
      `${p.category.padEnd(8)} | ${String(p.riskScore).padStart(4)}/10 | ${p.deltaNeutral ? '✓' : '✗'}`
    );
  }

  // Stablecoin yields
  const stablePools = pools.filter(p => p.category === 'STABLE').sort((a, b) => b.apy - a.apy);
  console.log(`\n── SOLANA STABLECOIN YIELDS (delta-neutral) ──\n`);
  console.log('#  | Symbol         | Project                    | APY%    | TVL       | Daily/$10k');
  console.log('───|────────────────|────────────────────────────|─────────|───────────|───────────');
  for (let i = 0; i < Math.min(15, stablePools.length); i++) {
    const p = stablePools[i];
    console.log(
      `${String(i + 1).padStart(2)} | ${p.symbol.slice(0, 14).padEnd(14)} | ${p.project.slice(0, 26).padEnd(26)} | ` +
      `${p.apy.toFixed(2).padStart(7)}% | ${fmtUsd(p.tvlUsd).padStart(9)} | ${fmtUsd(p.dailyProfitOn10k).padStart(9)}/d`
    );
  }

  // LST yields
  const lstPools = pools.filter(p => p.category === 'LST').sort((a, b) => b.tvlUsd - a.tvlUsd);
  console.log(`\n── SOLANA LST YIELDS ──\n`);
  console.log('#  | Symbol         | Project                    | APY%   | TVL       | Notes');
  console.log('───|────────────────|────────────────────────────|────────|───────────|──────');
  for (let i = 0; i < Math.min(15, lstPools.length); i++) {
    const p = lstPools[i];
    console.log(
      `${String(i + 1).padStart(2)} | ${p.symbol.slice(0, 14).padEnd(14)} | ${p.project.slice(0, 26).padEnd(26)} | ` +
      `${p.apy.toFixed(2).padStart(6)}% | ${fmtUsd(p.tvlUsd).padStart(9)} | Staking yield`
    );
  }

  // By project
  console.log('\n── TOP SOLANA PROJECTS BY TVL ──');
  const byProject: Record<string, { count: number; totalTvl: number; avgApy: number; maxApy: number }> = {};
  for (const p of pools) {
    if (!byProject[p.project]) byProject[p.project] = { count: 0, totalTvl: 0, avgApy: 0, maxApy: 0 };
    byProject[p.project].count++;
    byProject[p.project].totalTvl += p.tvlUsd;
    byProject[p.project].avgApy += p.apy;
    byProject[p.project].maxApy = Math.max(byProject[p.project].maxApy, p.apy);
  }
  console.log('Project                    | Pools | Total TVL  | Avg APY | Max APY');
  console.log('───────────────────────────|───────|────────────|─────────|─────────');
  for (const [proj, s] of Object.entries(byProject).sort((a, b) => b[1].totalTvl - a[1].totalTvl).slice(0, 15)) {
    console.log(`${proj.padEnd(25)} | ${String(s.count).padStart(5)} | ${fmtUsd(s.totalTvl).padStart(10)} | ${(s.avgApy / s.count).toFixed(2).padStart(7)}% | ${s.maxApy.toFixed(2).padStart(7)}%`);
  }

  // Portfolio projection — mix of stablecoin + LST
  console.log('\n── PORTFOLIO PROJECTION ($100k — 70% stablecoin, 30% LST) ──');
  const stableTop5 = stablePools.slice(0, 5);
  const lstTop3 = lstPools.filter(p => p.tvlUsd > 100_000_000).slice(0, 3);
  let totalAnnual = 0;
  let totalDaily = 0;
  let weightedRisk = 0;
  let totalAllocation = 0;

  console.log('  Stablecoin allocation (70% = $70k):');
  for (const p of stableTop5) {
    const allocation = 14000;
    const annual = allocation * p.apy / 100;
    totalAnnual += annual;
    totalDaily += annual / 365;
    weightedRisk += p.riskScore * allocation;
    totalAllocation += allocation;
    console.log(`    ${p.symbol.slice(0, 14).padEnd(14)} ${p.apy.toFixed(2).padStart(6)}%  ${fmtUsd(annual).padStart(8)}/yr  ${p.project}`);
  }
  console.log('  LST allocation (30% = $30k):');
  for (const p of lstTop3) {
    const allocation = 10000;
    const annual = allocation * p.apy / 100;
    totalAnnual += annual;
    totalDaily += annual / 365;
    weightedRisk += p.riskScore * allocation;
    totalAllocation += allocation;
    console.log(`    ${p.symbol.slice(0, 14).padEnd(14)} ${p.apy.toFixed(2).padStart(6)}%  ${fmtUsd(annual).padStart(8)}/yr  ${p.project}`);
  }
  weightedRisk /= totalAllocation;
  console.log(`\n  Total daily profit: ${fmtUsd(totalDaily)}`);
  console.log(`  Total monthly: ${fmtUsd(totalDaily * 30)}`);
  console.log(`  Total annual: ${fmtUsd(totalAnnual)}`);
  console.log(`  Portfolio yield: ${(totalAnnual / 100000 * 100).toFixed(2)}%/yr`);
  console.log(`  Weighted risk: ${weightedRisk.toFixed(1)}/10`);

  // Investor summary
  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  Total Solana pools: ${pools.length}`);
  console.log(`  Stablecoin pools: ${stablePools.length}`);
  console.log(`  LST pools: ${lstPools.length}`);
  console.log(`  Total TVL: ${fmtUsd(pools.reduce((s, p) => s + p.tvlUsd, 0))}`);
  console.log(`  Top yield: ${stablePools[0]?.apy.toFixed(2)}% APY (${stablePools[0]?.symbol})`);
  console.log(`  Top LST yield: ${lstPools[0]?.apy.toFixed(2)}% APY (${lstPools[0]?.symbol})`);
  console.log(`  Largest LST: JitoSOL ${fmtUsd(lstPools.find(p => p.symbol === 'JITOSOL')?.tvlUsd || 0)} TVL`);
  console.log(`  Portfolio yield on $100k: ${(totalAnnual / 100000 * 100).toFixed(2)}%/yr`);
  console.log(`  Risk: LOW (Solana, well-established protocols)`);
  console.log(`  Diversification: ${Object.keys(byProject).length} projects`);
}

main().catch(err => { console.error(err); process.exit(1); });
