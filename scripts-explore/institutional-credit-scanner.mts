/**
 * Institutional Credit Yield Scanner
 *
 * Scans institutional credit protocols:
 *   - Maple Finance ($4.02B TVL)
 *   - Centrifuge ($885M TVL)
 *   - BlackRock BUIDL ($2.96B TVL)
 *   - Ondo Finance ($2.53B TVL)
 *   - Invesco USTB ($593M TVL)
 *   - Midas RWA ($192M TVL)
 *   - Pareto Credit ($127M TVL)
 *   - OpenEden ($63M TVL)
 *
 * All pools: stablecoin-denominated, delta-neutral
 * Backed by real-world assets (Treasuries, credit, invoices)
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

const LLAMA_API = 'https://yields.llama.fi';

const INSTITUTIONAL_PROJECTS = [
  'maple', 'centrifuge-protocol', 'blackrock-buidl', 'ondo-yield-assets',
  'invesco-ustb', 'midas-rwa', 'pareto-credit', 'openeden-tbill',
  'circle-usyc', 'mountain', 'clearpool-lending', 'huma', 'goldfinch',
  'vaneck-treasury-fund', 'superstate', 'backed-finance',
];

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Institutional Credit Yield Scanner');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════\n');

  const res = await fetch(`${LLAMA_API}/pools`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
  });
  const j = await res.json();
  const pools = (j?.data || [])
    .filter(p => INSTITUTIONAL_PROJECTS.includes(p.project))
    .filter(p => p.tvlUsd > 1_000_000)
    .filter(p => p.apy > 0)
    .sort((a, b) => b.tvlUsd - a.tvlUsd);

  console.log(`Total institutional credit pools: ${pools.length}`);
  console.log(`Total TVL: $${(pools.reduce((s, p) => s + p.tvlUsd, 0) / 1e9).toFixed(2)}B\n`);

  console.log('── ALL INSTITUTIONAL CREDIT POOLS (by TVL) ──\n');
  console.log('#  | Symbol | Project              | Chain     | APY%   | TVL       | Daily/$100k');
  console.log('───|────────|──────────────────────|───────────|────────|───────────|────────────');
  for (let i = 0; i < pools.length; i++) {
    const p = pools[i];
    const daily = 100000 * (p.apy || 0) / 100 / 365;
    console.log(
      `${String(i + 1).padStart(2)} | ${(p.symbol || '').slice(0, 6).padEnd(6)} | ${(p.project || '').slice(0, 20).padEnd(20)} | ${(p.chain || '').padEnd(9)} | ` +
      `${(p.apy || 0).toFixed(2).padStart(6)}% | $${((p.tvlUsd || 0) / 1e6).toFixed(2).padStart(7)}M | $${daily.toFixed(2).padStart(10)}/d`
    );
  }

  // Group by project
  console.log('\n── BY PROJECT ──');
  const byProj = {};
  for (const p of pools) {
    if (!byProj[p.project]) byProj[p.project] = { count: 0, tvl: 0, totalApy: 0, maxApy: 0 };
    byProj[p.project].count++;
    byProj[p.project].tvl += p.tvlUsd;
    byProj[p.project].totalApy += p.apy || 0;
    byProj[p.project].maxApy = Math.max(byProj[p.project].maxApy, p.apy || 0);
  }
  console.log('Project               | Pools | Total TVL  | Avg APY | Max APY');
  console.log('──────────────────────|───────|────────────|─────────|─────────');
  for (const [proj, s] of Object.entries(byProj).sort((a, b) => b[1].tvl - a[1].tvl)) {
    console.log(`${proj.padEnd(20)} | ${String(s.count).padStart(5)} | $${(s.tvl / 1e9).toFixed(2).padStart(8)}B | ${(s.totalApy / s.count).toFixed(2).padStart(7)}% | ${s.maxApy.toFixed(2).padStart(7)}%`);
  }

  // Portfolio projection
  console.log('\n── PORTFOLIO PROJECTION ($1M diversified across top 10) ──');
  const top10 = pools.slice(0, 10);
  let totalAnnual = 0;
  for (const p of top10) {
    const allocation = 100000;
    const annual = allocation * (p.apy || 0) / 100;
    totalAnnual += annual;
    console.log(`  ${(p.symbol || '').slice(0, 6).padEnd(7)} on ${(p.project || '').slice(0, 20).padEnd(20)} ${(p.apy || 0).toFixed(2).padStart(6)}%  $${annual.toFixed(0).padStart(7)}/yr`);
  }
  console.log(`\n  Total annual: $${totalAnnual.toFixed(0)}`);
  console.log(`  Portfolio yield: ${(totalAnnual / 1_000_000 * 100).toFixed(2)}%/yr`);

  // Returns at multiple capital levels
  const avgYield = totalAnnual / 1_000_000 * 100;
  console.log('\n── RETURNS AT MULTIPLE CAPITAL LEVELS ──');
  console.log('Capital    | Daily      | Monthly    | Annual     ');
  console.log('───────────|────────────|────────────|────────────');
  for (const cap of [100000, 500000, 1_000_000, 5_000_000, 10_000_000, 50_000_000]) {
    const daily = cap * avgYield / 100 / 365;
    const monthly = daily * 30;
    const annual = daily * 365;
    console.log(`$${(cap / 1e6).toFixed(2).padStart(8)}M | $${daily.toFixed(0).padStart(10)} | $${monthly.toFixed(0).padStart(10)} | $${annual.toFixed(0).padStart(10)}`);
  }

  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  Total institutional pools: ${pools.length}`);
  console.log(`  Total TVL: $${(pools.reduce((s, p) => s + p.tvlUsd, 0) / 1e9).toFixed(2)}B`);
  console.log(`  Top yield: ${(pools[0]?.apy || 0).toFixed(2)}% APY (${pools[0]?.symbol} on ${pools[0]?.project})`);
  console.log(`  Largest pool: ${pools[0]?.symbol} on ${pools[0]?.project} ($${((pools[0]?.tvlUsd || 0) / 1e6).toFixed(2)}M TVL)`);
  console.log(`  Portfolio yield on $1M: ${(totalAnnual / 1_000_000 * 100).toFixed(2)}%/yr`);
  console.log(`  Risk profile: INSTITUTIONAL (RWA-backed, audited, regulated)`);
  console.log(`  Backing: US Treasuries, credit instruments, real-world assets`);
  console.log(`  Best for: Large capital seeking institutional-grade yield with RWA backing`);
  console.log(`  Compare to: Money market funds (4-5%/yr) — better yield + on-chain`);
}

main().catch(err => { console.error(err); process.exit(1); });
