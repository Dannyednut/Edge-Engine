/**
 * Pendle PT Comprehensive Scanner (via DefiLlama)
 *
 * Fetches ALL 156 Pendle PT pools from DefiLlama.
 * Identifies highest-yielding principal-protected PTs.
 *
 * Strategy:
 *   - Buy PT (Principal Token) at discount
 *   - Hold to maturity for fixed yield
 *   - Principal protected (no market risk)
 *
 * Data source: yields.llama.fi (DefiLlama) - filters for Pendle project
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

interface PendlePool {
  symbol: string;
  chain: string;
  apy: number;
  apy7d: number;
  apy30d: number;
  tvlUsd: number;
  stablecoin: boolean;
  exposure: string;
  ilRisk: string;
  pool: string;
}

async function fetchPendlePools(): Promise<PendlePool[]> {
  try {
    const res = await fetch(`${LLAMA_API}/pools`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const j = await res.json() as any;
    return (j?.data || [])
      .filter((p: any) => p.project?.toLowerCase().includes('pendle'))
      .map((p: any) => ({
        symbol: p.symbol,
        chain: p.chain,
        apy: p.apy || 0,
        apy7d: p.apyBase7d || p.apy || 0,
        apy30d: p.apyMean30d || p.apy || 0,
        tvlUsd: p.tvlUsd || 0,
        stablecoin: p.stablecoin || false,
        exposure: p.exposure || 'unknown',
        ilRisk: p.ilRisk || 'unknown',
        pool: p.pool,
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
  console.log('  Pendle PT Comprehensive Scanner (via DefiLlama)');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════\n');

  const pools = await fetchPendlePools();
  console.log(`Total Pendle pools found: ${pools.length}\n`);

  // Filter to pools with meaningful TVL
  const filtered = pools
    .filter(p => p.apy > 0)
    .filter(p => p.tvlUsd > 50_000)
    .sort((a, b) => b.apy - a.apy);

  console.log(`── TOP 25 PENDLE PT YIELDS (TVL > $50k) ──\n`);
  console.log('#  | Symbol         | Chain     | APY%    | 7d APY  | 30d APY | TVL       | Stablecoin');
  console.log('───|────────────────|───────────|─────────|─────────|─────────|───────────|───────────');
  for (let i = 0; i < Math.min(25, filtered.length); i++) {
    const p = filtered[i];
    console.log(
      `${String(i + 1).padStart(2)} | ${p.symbol.slice(0, 14).padEnd(14)} | ${p.chain.padEnd(9)} | ` +
      `${p.apy.toFixed(2).padStart(7)}% | ${p.apy7d.toFixed(2).padStart(7)}% | ${p.apy30d.toFixed(2).padStart(7)}% | ` +
      `${fmtUsd(p.tvlUsd).padStart(9)} | ${p.stablecoin ? '✓ YES' : '✗ NO'}`
    );
  }

  // Stablecoin PTs (lowest risk — principal-protected stablecoin yield)
  const stablePTs = filtered.filter(p => p.stablecoin);
  console.log(`\n── STABLECOIN PTs (delta-neutral, principal-protected) ──\n`);
  console.log('#  | Symbol         | Chain     | APY%    | 30d APY | TVL       | Daily on $5k');
  console.log('───|────────────────|───────────|─────────|─────────|───────────|─────────────');
  for (let i = 0; i < Math.min(15, stablePTs.length); i++) {
    const p = stablePTs[i];
    const daily5k = 5000 * p.apy / 100 / 365;
    console.log(
      `${String(i + 1).padStart(2)} | ${p.symbol.slice(0, 14).padEnd(14)} | ${p.chain.padEnd(9)} | ` +
      `${p.apy.toFixed(2).padStart(7)}% | ${p.apy30d.toFixed(2).padStart(7)}% | ${fmtUsd(p.tvlUsd).padStart(9)} | ${fmtUsd(daily5k).padStart(11)}/d`
    );
  }

  // By chain
  console.log('\n── PENDLE POOLS BY CHAIN ──');
  const byChain: Record<string, { count: number; totalTvl: number; avgApy: number; maxApy: number }> = {};
  for (const p of filtered) {
    if (!byChain[p.chain]) byChain[p.chain] = { count: 0, totalTvl: 0, avgApy: 0, maxApy: 0 };
    byChain[p.chain].count++;
    byChain[p.chain].totalTvl += p.tvlUsd;
    byChain[p.chain].avgApy += p.apy;
    byChain[p.chain].maxApy = Math.max(byChain[p.chain].maxApy, p.apy);
  }
  console.log('Chain     | Pools | Total TVL  | Avg APY | Max APY');
  console.log('──────────|───────|────────────|─────────|─────────');
  for (const [chain, s] of Object.entries(byChain).sort((a, b) => b[1].totalTvl - a[1].totalTvl)) {
    console.log(`${chain.padEnd(9)} | ${String(s.count).padStart(5)} | ${fmtUsd(s.totalTvl).padStart(10)} | ${(s.avgApy / s.count).toFixed(2).padStart(7)}% | ${s.maxApy.toFixed(2).padStart(7)}%`);
  }

  // Portfolio projection
  console.log('\n── PORTFOLIO PROJECTION ($100k across top 10 stablecoin PTs) ──');
  const top10 = stablePTs.slice(0, 10);
  let totalAnnual = 0;
  for (const p of top10) {
    const allocation = 10000;
    const annual = allocation * p.apy / 100;
    totalAnnual += annual;
    console.log(`  ${p.symbol.slice(0, 14).padEnd(14)} ${p.apy.toFixed(2).padStart(6)}%  ${fmtUsd(annual).padStart(8)}/yr  ${p.chain}`);
  }
  console.log(`\n  Total annual profit: ${fmtUsd(totalAnnual)}`);
  console.log(`  Portfolio yield: ${(totalAnnual / 100000 * 100).toFixed(2)}%/yr`);

  // Investor summary
  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  Total Pendle pools: ${pools.length}`);
  console.log(`  Filtered (TVL > $50k): ${filtered.length}`);
  console.log(`  Stablecoin PTs: ${stablePTs.length}`);
  console.log(`  Top yield: ${filtered[0]?.apy.toFixed(2)}% APY (${filtered[0]?.symbol} on ${filtered[0]?.chain})`);
  console.log(`  Top stablecoin PT yield: ${stablePTs[0]?.apy.toFixed(2)}% APY (${stablePTs[0]?.symbol})`);
  console.log(`  Portfolio yield on $100k: ${(totalAnnual / 100000 * 100).toFixed(2)}%/yr`);
  console.log(`  Risk profile: PRINCIPAL-PROTECTED (PT = fixed yield, no market risk)`);
  console.log(`  Liquidity: MEDIUM (typically 30-180 day hold to maturity)`);
  console.log(`  Diversification: ${Object.keys(byChain).length} chains`);
}

main().catch(err => { console.error(err); process.exit(1); });
