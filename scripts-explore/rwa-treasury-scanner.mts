/**
 * RWA Treasury Yield Scanner
 *
 * Scans Real World Asset (RWA) tokenized Treasury yields:
 *   - BlackRock BUIDL (tokenized T-bills, $3.4B+ TVL)
 *   - Ondo USDY (yield-bearing USD, $2.2B+ TVL)
 *   - Ondo OUSG (tokenized BlackRock ETF)
 *   - Circle USYC (yield-bearing stablecoin)
 *   - Invesco USTB (tokenized T-bills)
 *   - OpenEden TBILL
 *   - Mountain Protocol wUSDM
 *
 * Strategy:
 *   - Hold tokenized T-bills for risk-free Treasury yield
 *   - All tokens are 1:1 backed by US Treasuries
 *   - Yield = Treasury yield (currently ~3.5-5.5%)
 *   - Delta-neutral by design (USD-denominated)
 *
 * Lowest risk in entire DeFi ecosystem
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

interface RwaPool {
  rank: number;
  symbol: string;
  project: string;
  chain: string;
  apy: number;
  apy30d: number;
  tvlUsd: number;
  riskScore: number;
  dailyProfitOn10k: number;
  backingAsset: string;
  notes: string;
}

async function fetchRwaPools(): Promise<RwaPool[]> {
  try {
    const res = await fetch(`${LLAMA_API}/pools`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const j = await res.json() as any;
    return (j?.data || [])
      .filter((p: any) => {
        const sym = (p.symbol || '').toLowerCase();
        const proj = (p.project || '').toLowerCase();
        return sym.includes('buidl') || sym.includes('usdy') || sym.includes('usyc') ||
               sym.includes('ustb') || sym.includes('tbill') || sym.includes('usdm') ||
               proj.includes('blackrock') || proj.includes('ondo') || proj.includes('invesco') ||
               proj.includes('circle-usyc') || proj.includes('mountain') || proj.includes('openeden');
      })
      .filter((p: any) => p.tvlUsd > 100_000)
      .filter((p: any) => p.apy > 0)
      .map((p: any) => {
        let backing = 'US Treasuries';
        if ((p.symbol || '').includes('BUIDL')) backing = 'BlackRock BUIDL (T-bills)';
        else if ((p.symbol || '').includes('USDY')) backing = 'Ondo USDY (T-bills + bank deposits)';
        else if ((p.symbol || '').includes('OUSG')) backing = 'Ondo OUSG (BlackRock iShares ETF)';
        else if ((p.symbol || '').includes('USYC')) backing = 'Circle USYC (T-bills)';
        else if ((p.symbol || '').includes('USTB')) backing = 'Invesco USTB (T-bills)';
        else if ((p.symbol || '').includes('TBILL')) backing = 'OpenEden TBILL (T-bills)';
        else if ((p.symbol || '').includes('USDM')) backing = 'Mountain USDM (T-bills)';
        return {
          rank: 0,
          symbol: p.symbol,
          project: p.project,
          chain: p.chain,
          apy: p.apy || 0,
          apy30d: p.apyMean30d || p.apy || 0,
          tvlUsd: p.tvlUsd || 0,
          riskScore: 1,  // RWA = lowest risk
          dailyProfitOn10k: 10000 * (p.apy || 0) / 100 / 365,
          backingAsset: backing,
          notes: '',
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
  console.log('  RWA Treasury Yield Scanner');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('  Lowest risk in DeFi — backed by US Treasuries');
  console.log('═══════════════════════════════════════════════════\n');

  const pools = await fetchRwaPools();
  console.log(`Found ${pools.length} RWA Treasury yield pools\n`);

  // Sort by TVL (largest = safest)
  pools.sort((a, b) => b.tvlUsd - a.tvlUsd);
  pools.forEach((p, i) => { p.rank = i + 1; });

  console.log('── ALL RWA TREASURY YIELD POOLS (by TVL) ──\n');
  console.log('#  | Symbol | Project              | Chain      | APY%   | 30d APY | TVL       | Backing Asset                          | Daily/$10k');
  console.log('───|────────|──────────────────────|────────────|────────|─────────|───────────|────────────────────────────────────────|───────────');
  for (const p of pools) {
    console.log(
      `${String(p.rank).padStart(2)} | ${p.symbol.padEnd(6)} | ${p.project.slice(0, 20).padEnd(20)} | ${p.chain.padEnd(10)} | ` +
      `${p.apy.toFixed(2).padStart(6)}% | ${p.apy30d.toFixed(2).padStart(7)}% | ${fmtUsd(p.tvlUsd).padStart(9)} | ` +
      `${p.backingAsset.padEnd(38)} | ${fmtUsd(p.dailyProfitOn10k).padStart(9)}/d`
    );
  }

  // Aggregate by backing type
  console.log('\n── BY BACKING ASSET ──');
  const byBacking: Record<string, { count: number; totalTvl: number; avgApy: number; maxApy: number }> = {};
  for (const p of pools) {
    if (!byBacking[p.backingAsset]) byBacking[p.backingAsset] = { count: 0, totalTvl: 0, avgApy: 0, maxApy: 0 };
    byBacking[p.backingAsset].count++;
    byBacking[p.backingAsset].totalTvl += p.tvlUsd;
    byBacking[p.backingAsset].avgApy += p.apy;
    byBacking[p.backingAsset].maxApy = Math.max(byBacking[p.backingAsset].maxApy, p.apy);
  }
  console.log('Backing Asset                                       | Pools | Total TVL  | Avg APY | Max APY');
  console.log('─────────────────────────────────────────────────────|───────|────────────|─────────|─────────');
  for (const [backing, s] of Object.entries(byBacking).sort((a, b) => b[1].totalTvl - a[1].totalTvl)) {
    console.log(`${backing.padEnd(51)} | ${String(s.count).padStart(5)} | ${fmtUsd(s.totalTvl).padStart(10)} | ${(s.avgApy / s.count).toFixed(2).padStart(7)}% | ${s.maxApy.toFixed(2).padStart(7)}%`);
  }

  // By chain
  console.log('\n── BY CHAIN ──');
  const byChain: Record<string, { count: number; totalTvl: number; avgApy: number }> = {};
  for (const p of pools) {
    if (!byChain[p.chain]) byChain[p.chain] = { count: 0, totalTvl: 0, avgApy: 0 };
    byChain[p.chain].count++;
    byChain[p.chain].totalTvl += p.tvlUsd;
    byChain[p.chain].avgApy += p.apy;
  }
  console.log('Chain      | Pools | Total TVL  | Avg APY');
  console.log('───────────|───────|────────────|─────────');
  for (const [chain, s] of Object.entries(byChain).sort((a, b) => b[1].totalTvl - a[1].totalTvl)) {
    console.log(`${chain.padEnd(10)} | ${String(s.count).padStart(5)} | ${fmtUsd(s.totalTvl).padStart(10)} | ${(s.avgApy / s.count).toFixed(2).padStart(7)}%`);
  }

  // Portfolio projection — diversified across top 5
  console.log('\n── PORTFOLIO PROJECTION ($100k diversified across top 5 RWA pools) ──');
  const top5 = pools.slice(0, 5);
  let totalAnnual = 0;
  let totalDaily = 0;
  for (const p of top5) {
    const allocation = 20000;
    const annual = allocation * p.apy / 100;
    const daily = annual / 365;
    totalAnnual += annual;
    totalDaily += daily;
    console.log(`  ${p.rank}. ${p.symbol.padEnd(7)} ${p.chain.padEnd(10)} ${p.apy.toFixed(2).padStart(6)}%  ${fmtUsd(annual).padStart(8)}/yr  ${p.backingAsset.slice(0, 30)}`);
  }
  console.log(`\n  Total daily profit: ${fmtUsd(totalDaily)}`);
  console.log(`  Total monthly: ${fmtUsd(totalDaily * 30)}`);
  console.log(`  Total annual: ${fmtUsd(totalAnnual)}`);
  console.log(`  Portfolio yield: ${(totalAnnual / 100000 * 100).toFixed(2)}%/yr`);

  // Investor summary
  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  Total RWA pools: ${pools.length}`);
  console.log(`  Total TVL: ${fmtUsd(pools.reduce((s, p) => s + p.tvlUsd, 0))}`);
  console.log(`  Top yield: ${pools[0]?.apy.toFixed(2)}% APY (${pools[0]?.symbol} on ${pools[0]?.chain})`);
  console.log(`  Largest pool: ${pools[0]?.symbol} on ${pools[0]?.project} (${fmtUsd(pools[0]?.tvlUsd || 0)} TVL)`);
  console.log(`  Portfolio yield on $100k: ${(totalAnnual / 100000 * 100).toFixed(2)}%/yr`);
  console.log(`  Risk profile: LOWEST (US Treasury-backed)`);
  console.log(`  Backing: US Treasuries (BlackRock, Ondo, Circle, Invesco, OpenEden)`);
  console.log(`  Liquidity: HIGH (most pools allow instant withdrawal)`);
  console.log(`  Diversification: ${Object.keys(byChain).length} chains, ${Object.keys(byBacking).length} backing assets`);
  console.log(`\n  Best for: Capital preservation portion of portfolio`);
  console.log(`  Compare to: US Treasuries 4.5% APY (RWA gives similar yield, on-chain)`);
}

main().catch(err => { console.error(err); process.exit(1); });
