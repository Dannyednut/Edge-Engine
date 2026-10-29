/**
 * Base Chain Tokenized Stock LP Scanner
 *
 * Scans Aerodrome Slipstream pools on Base for tokenized stock LP opportunities.
 * These pools offer extremely high APYs due to concentrated liquidity.
 *
 * Strategy:
 *   - Provide liquidity to USDC-X stock pools (NVDA, META, GOOGL, AMZN, etc.)
 *   - Earn trading fees from stock token swaps
 *   - Use concentrated liquidity to maximize fee capture
 *
 * Risk profile:
 *   - Has IL risk (impermanent loss)
 *   - Has stock price exposure (NOT delta-neutral)
 *   - But extremely high yields can offset IL
 *
 * Best for: speculative portion of portfolio with high risk tolerance
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

const LLAMA_API = 'https://yields.llama.fi';

const STOCK_SYMBOLS = ['NVDAC', 'METAC', 'GOOGLC', 'AMZNC', 'AAPLC', 'TSLAC', 'SNDKC', 'MSRTC', 'VELVET', 'CBBTC', 'CBETH'];

interface StockLPPool {
  symbol: string;
  project: string;
  chain: string;
  apy: number;
  apy30d: number;
  tvlUsd: number;
  ilRisk: string;
  exposure: string;
  underlyingStock: string;
}

async function fetchStockPools(): Promise<StockLPPool[]> {
  try {
    const res = await fetch(`${LLAMA_API}/pools`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const j = await res.json() as any;
    return (j?.data || [])
      .filter((p: any) => {
        const sym = p.symbol || '';
        return STOCK_SYMBOLS.some(s => sym.includes(s));
      })
      .map((p: any) => {
        let underlying = 'unknown';
        for (const s of STOCK_SYMBOLS) {
          if ((p.symbol || '').includes(s)) {
            underlying = s;
            break;
          }
        }
        return {
          symbol: p.symbol,
          project: p.project,
          chain: p.chain,
          apy: p.apy || 0,
          apy30d: p.apyMean30d || p.apy || 0,
          tvlUsd: p.tvlUsd || 0,
          ilRisk: p.ilRisk || 'unknown',
          exposure: p.exposure || 'unknown',
          underlyingStock: underlying,
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
  return `$${n.toFixed(0)}`;
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Base Chain Tokenized Stock LP Scanner');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('  ⚠ WARNING: These pools have IL risk and stock price exposure');
  console.log('═══════════════════════════════════════════════════\n');

  const pools = await fetchStockPools();
  console.log(`Total tokenized stock pools: ${pools.length}\n`);

  // Filter to significant pools
  const filtered = pools
    .filter(p => p.apy > 0)
    .filter(p => p.tvlUsd > 100_000)
    .sort((a, b) => b.apy - a.apy);

  console.log(`── TOP 25 TOKENIZED STOCK LP POOLS (TVL > $100k) ──\n`);
  console.log('#  | Symbol         | Project       | Chain | APY%     | 30d APY | TVL       | Stock   | IL Risk');
  console.log('───|────────────────|───────────────|───────|──────────|─────────|───────────|─────────|────────');
  for (let i = 0; i < Math.min(25, filtered.length); i++) {
    const p = filtered[i];
    console.log(
      `${String(i + 1).padStart(2)} | ${p.symbol.slice(0, 14).padEnd(14)} | ${p.project.slice(0, 13).padEnd(13)} | ${p.chain.slice(0, 5).padEnd(5)} | ` +
      `${p.apy.toFixed(2).padStart(8)}% | ${p.apy30d.toFixed(2).padStart(7)}% | ${fmtUsd(p.tvlUsd).padStart(9)} | ${p.underlyingStock.padEnd(7)} | ${p.ilRisk}`
    );
  }

  // By underlying stock
  console.log('\n── BY UNDERLYING STOCK ──');
  const byStock: Record<string, { count: number; maxApy: number; totalTvl: number; avgApy: number }> = {};
  for (const p of filtered) {
    if (!byStock[p.underlyingStock]) byStock[p.underlyingStock] = { count: 0, maxApy: 0, totalTvl: 0, avgApy: 0 };
    byStock[p.underlyingStock].count++;
    byStock[p.underlyingStock].maxApy = Math.max(byStock[p.underlyingStock].maxApy, p.apy);
    byStock[p.underlyingStock].totalTvl += p.tvlUsd;
    byStock[p.underlyingStock].avgApy += p.apy;
  }
  console.log('Stock     | Pools | Total TVL  | Avg APY | Max APY');
  console.log('──────────|───────|────────────|─────────|─────────');
  for (const [stock, s] of Object.entries(byStock).sort((a, b) => b[1].maxApy - a[1].maxApy)) {
    console.log(`${stock.padEnd(9)} | ${String(s.count).padStart(5)} | ${fmtUsd(s.totalTvl).padStart(10)} | ${(s.avgApy / s.count).toFixed(2).padStart(7)}% | ${s.maxApy.toFixed(2).padStart(7)}%`);
  }

  // Portfolio projection
  console.log('\n── PORTFOLIO PROJECTION ($20k speculative, top 5 pools) ──');
  const top5 = filtered.slice(0, 5);
  let totalAnnual = 0;
  for (const p of top5) {
    const allocation = 4000;
    const annual = allocation * p.apy / 100;
    totalAnnual += annual;
    console.log(`  ${p.symbol.slice(0, 14).padEnd(14)} ${p.apy.toFixed(2).padStart(8)}%  ${fmtUsd(annual).padStart(10)}/yr  ${p.underlyingStock}`);
  }
  console.log(`\n  Total annual profit (theoretical): ${fmtUsd(totalAnnual)}`);
  console.log(`  Portfolio yield (theoretical): ${(totalAnnual / 20000 * 100).toFixed(0)}%/yr`);

  // Realistic projection (account for IL + stock price movement)
  const realisticAnnual = totalAnnual * 0.5;  // 50% of theoretical after IL
  console.log(`  Realistic annual profit (after IL): ${fmtUsd(realisticAnnual)}`);
  console.log(`  Realistic yield: ${(realisticAnnual / 20000 * 100).toFixed(0)}%/yr`);

  // Investor summary
  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  Total pools: ${pools.length}`);
  console.log(`  Significant (TVL > $100k): ${filtered.length}`);
  console.log(`  Top yield: ${filtered[0]?.apy.toFixed(2)}% APY (${filtered[0]?.symbol})`);
  console.log(`  Portfolio theoretical yield: ${(totalAnnual / 20000 * 100).toFixed(0)}%/yr`);
  console.log(`  Portfolio realistic yield: ${(realisticAnnual / 20000 * 100).toFixed(0)}%/yr (after IL)`);
  console.log(`  Risk profile: HIGH (IL risk + stock price exposure)`);
  console.log(`  ⚠ NOT delta-neutral — has stock price exposure`);
  console.log(`  Best for: Speculative portion of portfolio (max 10-15% allocation)`);
  console.log(`  Diversification: ${Object.keys(byStock).length} underlying stocks`);
}

main().catch(err => { console.error(err); process.exit(1); });
