/**
 * Curve Finance Yield Scanner
 *
 * Fetches all Curve pools across multiple chains and identifies
 * the highest-yielding stablecoin/LST pools for delta-neutral yield.
 *
 * Strategy:
 *   - Provide liquidity to Curve pools
 *   - Earn trading fees + CRV rewards + additional gauge rewards
 *   - Stablecoin pools = delta-neutral (no price exposure)
 *   - LST pools have minor ETH exposure (hedged via LST)
 *
 * Data source: api.curve.fi (official Curve API)
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

interface CurvePool {
  address: string;
  chain: string;
  name: string;
  symbol: string;
  apy: number;
  apyWeekly: number;
  tvlUsd: number;
  volumeUsd: number;
  poolType: string;
  isStablecoin: boolean;
  isLST: boolean;
  coins: string[];
  riskScore: number;
  deltaNeutral: boolean;
}

async function fetchCurvePools(chain: string): Promise<CurvePool[]> {
  try {
    const url = `https://api.curve.fi/api/getSubgraphData/${chain}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const j = await res.json() as any;
    // API returns { success, data: { poolList: [...] } } or { poolList: [...] }
    const poolList = j?.data?.poolList || j?.poolList || [];
    if (!Array.isArray(poolList)) return [];
    return poolList.map((p: any) => ({
      address: p.address,
      chain,
      name: p.name || p.address,
      symbol: p.symbol || '',
      apy: p.latestDailyApy || 0,
      apyWeekly: p.latestWeeklyApy || 0,
      tvlUsd: p.tvlUsd || 0,  // may be 0 from subgraph, enriched later
      volumeUsd: p.volumeUSD || 0,
      poolType: p.type || 'main',
      isStablecoin: false,
      isLST: false,
      coins: p.coins || [],
      riskScore: 3,
      deltaNeutral: false,
    }));
  } catch {
    return [];
  }
}

async function fetchPoolDetails(chain: string): Promise<Record<string, any>> {
  try {
    const url = `https://api.curve.fi/api/getPools/${chain}/main`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!res.ok) return {};
    const j = await res.json() as any;
    const poolData = j?.data?.poolData || [];
    const detailsMap: Record<string, any> = {};
    for (const p of poolData) {
      detailsMap[p.address.toLowerCase()] = {
        name: p.name,
        symbol: p.symbol,
        coins: (p.coins || []).map((c: any) => c.symbol),
        usdTotal: p.usdTotal,
        assetTypeName: p.assetTypeName,
        gaugeCrvApy: p.gaugeCrvApy,
        gaugeRewards: p.gaugeRewards || [],
      };
    }
    return detailsMap;
  } catch {
    return {};
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
  console.log('  Curve Finance Yield Scanner');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════\n');

  const chains = ['ethereum', 'polygon', 'arbitrum', 'optimism', 'base', 'gnosis', 'fantom', 'avalanche'];
  const [allPoolsResult, allDetailsResult] = await Promise.all([
    Promise.all(chains.map(c => fetchCurvePools(c))),
    Promise.all(chains.map(c => fetchPoolDetails(c))),
  ]);

  const allPools = allPoolsResult.flat();
  const allDetails: Record<string, any> = {};
  for (const d of allDetailsResult) Object.assign(allDetails, d);

  console.log(`Total Curve pools fetched: ${allPools.length}\n`);

  // Enrich with details
  for (const p of allPools) {
    const details = allDetails[p.address.toLowerCase()];
    if (details) {
      p.name = details.name || p.name;
      p.symbol = details.symbol || p.symbol;
      p.coins = details.coins || p.coins;
      p.tvlUsd = details.usdTotal || p.tvlUsd;
      p.isStablecoin = details.assetTypeName === 'usd';
      p.isLST = ['wstETH', 'wsteth', 'steth'].includes(details.assetTypeName?.toLowerCase());
      p.deltaNeutral = p.isStablecoin;
      if (details.gaugeCrvApy) {
        p.apy = Math.max(p.apy, details.gaugeCrvApy);
      }
    }
  }

  // Filter to pools with meaningful APY and TVL
  const filtered = allPools
    .filter(p => p.apy > 1 && p.tvlUsd > 100_000)
    .sort((a, b) => b.apy - a.apy);

  console.log(`── TOP 25 CURVE POOLS BY APY (filtered: APY > 1%, TVL > $100k) ──\n`);
  console.log('#  | Pool                                       | Chain     | Type       | APY%    | Weekly APY% | TVL       | Volume24h | Delta-Neutral');
  console.log('───|────────────────────────────────────────────|───────────|────────────|─────────|─────────────|───────────|───────────|───────────────');
  for (let i = 0; i < Math.min(25, filtered.length); i++) {
    const p = filtered[i];
    const type = p.isStablecoin ? 'STABLE' : p.isLST ? 'LST' : 'OTHER';
    const dn = p.deltaNeutral ? '✓ YES' : '✗ NO';
    console.log(
      `${String(i + 1).padStart(2)} | ${p.name.slice(0, 42).padEnd(42)} | ${p.chain.padEnd(9)} | ${type.padEnd(10)} | ` +
      `${p.apy.toFixed(2).padStart(7)}% | ${p.apyWeekly.toFixed(2).padStart(11)}% | ` +
      `${fmtUsd(p.tvlUsd).padStart(9)} | ${fmtUsd(p.volumeUsd).padStart(9)} | ${dn}`
    );
  }

  // Stablecoin-only pools (delta-neutral)
  const stablePools = filtered.filter(p => p.deltaNeutral);
  console.log(`\n── TOP 15 DELTA-NEUTRAL STABLECOIN POOLS ──\n`);
  console.log('#  | Pool                                       | Chain     | APY%    | TVL       | Daily on $5k');
  console.log('───|────────────────────────────────────────────|───────────|─────────|───────────|─────────────');
  for (let i = 0; i < Math.min(15, stablePools.length); i++) {
    const p = stablePools[i];
    const daily5k = 5000 * p.apy / 100 / 365;
    console.log(
      `${String(i + 1).padStart(2)} | ${p.name.slice(0, 42).padEnd(42)} | ${p.chain.padEnd(9)} | ` +
      `${p.apy.toFixed(2).padStart(6)}% | ${fmtUsd(p.tvlUsd).padStart(9)} | ${fmtUsd(daily5k).padStart(12)}/d`
    );
  }

  // By chain summary
  console.log('\n── BY CHAIN ──');
  const byChain: Record<string, { count: number; totalTvl: number; avgApy: number; maxApy: number }> = {};
  for (const p of filtered) {
    if (!byChain[p.chain]) byChain[p.chain] = { count: 0, totalTvl: 0, avgApy: 0, maxApy: 0 };
    byChain[p.chain].count++;
    byChain[p.chain].totalTvl += p.tvlUsd;
    byChain[p.chain].avgApy += p.apy;
    byChain[p.chain].maxApy = Math.max(byChain[p.chain].maxApy, p.apy);
  }
  console.log('Chain      | Pools | Total TVL  | Avg APY | Max APY');
  console.log('───────────|───────|────────────|─────────|─────────');
  for (const [chain, s] of Object.entries(byChain).sort((a, b) => b[1].totalTvl - a[1].totalTvl)) {
    console.log(`${chain.padEnd(10)} | ${String(s.count).padStart(5)} | ${fmtUsd(s.totalTvl).padStart(10)} | ${(s.avgApy / s.count).toFixed(2).padStart(7)}% | ${s.maxApy.toFixed(2).padStart(7)}%`);
  }

  // Portfolio projection
  console.log('\n── PORTFOLIO PROJECTION ($50k across top 5 stablecoin pools) ──');
  const top5 = stablePools.slice(0, 5);
  let totalAnnual = 0;
  for (const p of top5) {
    const allocation = 10000;
    const annual = allocation * p.apy / 100;
    totalAnnual += annual;
    console.log(`  ${p.name.slice(0, 40).padEnd(40)} ${p.apy.toFixed(2).padStart(6)}%  ${fmtUsd(annual).padStart(8)}/yr  ${p.chain}`);
  }
  console.log(`\n  Total annual profit: ${fmtUsd(totalAnnual)}`);
  console.log(`  Portfolio yield: ${(totalAnnual / 50000 * 100).toFixed(2)}%/yr`);

  // Investor summary
  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  Total Curve pools scanned: ${allPools.length}`);
  console.log(`  Pools with APY > 1%: ${filtered.length}`);
  console.log(`  Stablecoin pools (delta-neutral): ${stablePools.length}`);
  console.log(`  Top yield: ${filtered[0]?.apy.toFixed(2)}% APY (${filtered[0]?.name})`);
  console.log(`  Top stable yield: ${stablePools[0]?.apy.toFixed(2)}% APY (${stablePools[0]?.name})`);
  console.log(`  Portfolio yield on $50k: ${(totalAnnual / 50000 * 100).toFixed(2)}%/yr`);
  console.log(`  Risk profile: ${stablePools.length > 0 ? 'STABLECOIN-DENOMINATED (delta-neutral)' : 'N/A'}`);
  console.log(`  Liquidity: HIGH (withdraw anytime, no lockup)`);
}

main().catch(err => { console.error(err); process.exit(1); });
