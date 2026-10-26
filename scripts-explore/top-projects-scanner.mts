/**
 * Top Yield Projects Scanner
 *
 * Ranks all DeFi projects by average APY (with > 5 pools and > $50M TVL).
 * Identifies the most consistently high-yielding protocols.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

const LLAMA_API = 'https://yields.llama.fi';

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Top Yield Projects Scanner');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════\n');

  const res = await fetch(`${LLAMA_API}/pools`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
  });
  const j = await res.json();
  const pools = j?.data || [];
  console.log(`Total pools scanned: ${pools.length}\n`);

  // Group by project
  const byProj = {};
  for (const p of pools) {
    if (p.ilRisk !== 'no') continue;
    if (!byProj[p.project]) byProj[p.project] = { count: 0, totalTvl: 0, totalApy: 0, maxApy: 0, chains: new Set(), stableCount: 0 };
    byProj[p.project].count++;
    byProj[p.project].totalTvl += p.tvlUsd || 0;
    byProj[p.project].totalApy += p.apy || 0;
    byProj[p.project].maxApy = Math.max(byProj[p.project].maxApy, p.apy || 0);
    byProj[p.project].chains.add(p.chain);
    if (p.stablecoin) byProj[p.project].stableCount++;
  }

  // Top 30 projects by avg APY (filter: > 5 pools, > $50M TVL)
  const top = Object.entries(byProj)
    .filter(([_, s]) => s.count >= 5 && s.totalTvl > 50_000_000)
    .map(([proj, s]) => ({
      project: proj,
      count: s.count,
      totalTvl: s.totalTvl,
      avgApy: s.totalApy / s.count,
      maxApy: s.maxApy,
      chains: s.chains.size,
      stableCount: s.stableCount,
    }))
    .sort((a, b) => b.avgApy - a.avgApy);

  console.log('── TOP 30 PROJECTS BY AVG APY (> 5 pools, > $50M TVL) ──\n');
  console.log('#  | Project              | Pools | Stable | Chains | Total TVL  | Avg APY | Max APY');
  console.log('───|──────────────────────|───────|────────|────────|────────────|─────────|─────────');
  for (let i = 0; i < Math.min(30, top.length); i++) {
    const p = top[i];
    console.log(
      `${String(i + 1).padStart(2)} | ${p.project.padEnd(20)} | ${String(p.count).padStart(5)} | ${String(p.stableCount).padStart(6)} | ${String(p.chains).padStart(6)} | $${(p.totalTvl / 1e6).toFixed(2).padStart(8)}M | ${p.avgApy.toFixed(2).padStart(7)}% | ${p.maxApy.toFixed(2).padStart(7)}%`
    );
  }

  // Top 30 by total TVL (safest)
  const byTvl = [...top].sort((a, b) => b.totalTvl - a.totalTvl);
  console.log('\n── TOP 30 PROJECTS BY TVL (safest) ──\n');
  console.log('#  | Project              | Pools | Total TVL  | Avg APY | Max APY');
  console.log('───|──────────────────────|───────|────────────|─────────|─────────');
  for (let i = 0; i < Math.min(30, byTvl.length); i++) {
    const p = byTvl[i];
    console.log(
      `${String(i + 1).padStart(2)} | ${p.project.padEnd(20)} | ${String(p.count).padStart(5)} | $${(p.totalTvl / 1e9).toFixed(2).padStart(8)}B | ${p.avgApy.toFixed(2).padStart(7)}% | ${p.maxApy.toFixed(2).padStart(7)}%`
    );
  }

  // Sweet spot: high avg APY + high TVL
  console.log('\n── SWEET SPOT: Avg APY > 8% AND TVL > $100M ──\n');
  const sweetSpot = top.filter(p => p.avgApy > 8 && p.totalTvl > 100_000_000);
  console.log('#  | Project              | Pools | Total TVL  | Avg APY | Max APY | Stable Pools');
  console.log('───|──────────────────────|───────|────────────|─────────|─────────|─────────────');
  for (let i = 0; i < sweetSpot.length; i++) {
    const p = sweetSpot[i];
    console.log(
      `${String(i + 1).padStart(2)} | ${p.project.padEnd(20)} | ${String(p.count).padStart(5)} | $${(p.totalTvl / 1e6).toFixed(2).padStart(8)}M | ${p.avgApy.toFixed(2).padStart(7)}% | ${p.maxApy.toFixed(2).padStart(7)}% | ${p.stableCount}/${p.count}`
    );
  }

  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  Total projects analyzed: ${Object.keys(byProj).length}`);
  console.log(`  Projects with > 5 pools & > $50M TVL: ${top.length}`);
  console.log(`  Top avg APY: ${top[0]?.avgApy.toFixed(2)}% (${top[0]?.project})`);
  console.log(`  Top TVL project: ${byTvl[0]?.project} ($${(byTvl[0]?.totalTvl / 1e9).toFixed(2)}B)`);
  console.log(`  Sweet spot projects (APY > 8% & TVL > $100M): ${sweetSpot.length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
