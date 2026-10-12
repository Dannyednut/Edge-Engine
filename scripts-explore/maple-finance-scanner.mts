/**
 * Maple Finance Institutional Lending Scanner
 *
 * Maple Finance is the largest institutional credit protocol in DeFi:
 *   - $4.02B TVL (largest RWA lending protocol)
 *   - Offers USDC, USDT, USDG pools
 *   - Backed by institutional borrowers (hedge funds, trading firms)
 *   - Yields from real-world business loans
 *
 * Strategy:
 *   - Supply USDC/USDT/USDG to Maple pools
 *   - Earn fixed yield from institutional borrowers
 *   - Delta-neutral (stablecoin-denominated)
 *   - Insurance fund covers defaults
 *
 * Risk: counterparty (institutional borrowers) — but insured
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

interface MaplePool {
  rank: number;
  symbol: string;
  apy: number;
  apy30d: number;
  tvlUsd: number;
  dailyProfitOn10k: number;
  notes: string;
}

async function fetchMaplePools(): Promise<MaplePool[]> {
  try {
    const res = await fetch(`${LLAMA_API}/pools`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const j = await res.json() as any;
    return (j?.data || [])
      .filter((p: any) => p.project === 'maple')
      .map((p: any) => ({
        rank: 0,
        symbol: p.symbol,
        apy: p.apy || 0,
        apy30d: p.apyMean30d || p.apy || 0,
        tvlUsd: p.tvlUsd || 0,
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
  console.log('  Maple Finance Institutional Lending Scanner');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════\n');

  const pools = await fetchMaplePools();
  console.log(`Total Maple pools: ${pools.length}`);
  console.log(`Total TVL: ${fmtUsd(pools.reduce((s, p) => s + p.tvlUsd, 0))}\n`);

  pools.sort((a, b) => b.tvlUsd - a.tvlUsd);
  pools.forEach((p, i) => { p.rank = i + 1; });

  console.log('── ALL MAPLE POOLS (by TVL) ──\n');
  console.log('#  | Symbol | APY%   | 30d APY | TVL       | Daily/$10k | Daily/$100k | Daily/$1M');
  console.log('───|────────|────────|─────────|───────────|────────────|─────────────|───────────');
  for (const p of pools) {
    console.log(
      `${String(p.rank).padStart(2)} | ${p.symbol.padEnd(6)} | ` +
      `${p.apy.toFixed(2).padStart(6)}% | ${p.apy30d.toFixed(2).padStart(7)}% | ${fmtUsd(p.tvlUsd).padStart(9)} | ` +
      `${fmtUsd(p.dailyProfitOn10k).padStart(10)}/d | ${fmtUsd(p.dailyProfitOn10k * 10).padStart(11)}/d | ${fmtUsd(p.dailyProfitOn10k * 100).padStart(9)}/d`
    );
  }

  // Portfolio projection
  console.log('\n── PORTFOLIO PROJECTION ($100k across all Maple pools) ──');
  let totalAnnual = 0;
  let totalDaily = 0;
  for (const p of pools) {
    const allocation = 100000 / pools.length;
    const annual = allocation * p.apy / 100;
    const daily = annual / 365;
    totalAnnual += annual;
    totalDaily += daily;
    console.log(`  ${p.symbol.padEnd(7)} ${p.apy.toFixed(2).padStart(6)}%  ${fmtUsd(annual).padStart(8)}/yr  ${fmtUsd(p.tvlUsd).padStart(9)} TVL`);
  }
  console.log(`\n  Total daily profit: ${fmtUsd(totalDaily)}`);
  console.log(`  Total monthly: ${fmtUsd(totalDaily * 30)}`);
  console.log(`  Total annual: ${fmtUsd(totalAnnual)}`);
  console.log(`  Portfolio yield: ${(totalAnnual / 100000 * 100).toFixed(2)}%/yr`);

  // At multiple capital levels
  console.log('\n── RETURNS AT MULTIPLE CAPITAL LEVELS ──');
  const avgYield = totalAnnual / 100000 * 100;
  console.log('Capital    | Daily      | Monthly    | Annual     ');
  console.log('───────────|────────────|────────────|────────────');
  for (const cap of [10000, 50000, 100000, 500000, 1_000_000, 5_000_000]) {
    const daily = cap * avgYield / 100 / 365;
    const monthly = daily * 30;
    const annual = daily * 365;
    console.log(`${fmtUsd(cap).padEnd(10)} | ${fmtUsd(daily).padStart(10)} | ${fmtUsd(monthly).padStart(10)} | ${fmtUsd(annual).padStart(10)}`);
  }

  // Investor summary
  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  Total Maple pools: ${pools.length}`);
  console.log(`  Total TVL: ${fmtUsd(pools.reduce((s, p) => s + p.tvlUsd, 0))}`);
  console.log(`  Top yield: ${pools[0]?.apy.toFixed(2)}% APY (${pools[0]?.symbol})`);
  console.log(`  Largest pool: ${pools[0]?.symbol} (${fmtUsd(pools[0]?.tvlUsd || 0)} TVL)`);
  console.log(`  Portfolio yield on $100k: ${(totalAnnual / 100000 * 100).toFixed(2)}%/yr`);
  console.log(`  Risk profile: INSTITUTIONAL (counterparty = hedge funds, trading firms)`);
  console.log(`  Insurance: Maple has insurance fund to cover defaults`);
  console.log(`  Liquidity: MEDIUM (some pools have 30-day lockup)`);
  console.log(`  All pools: delta-neutral (stablecoin-denominated)`);
  console.log(`\n  Best for: Large capital seeking institutional-grade yield`);
  console.log(`  Compare to: Hedge fund returns (8-12%/yr) with better liquidity`);
  console.log(`  Note: Maple is the largest institutional credit protocol in DeFi`);
}

main().catch(err => { console.error(err); process.exit(1); });
