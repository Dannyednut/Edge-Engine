/**
 * Strategy Backtester — uses historical opp database
 *
 * Tests trading strategies against historical opportunities
 * recorded in the SQLite database.
 *
 * Strategies tested:
 *   1. CONSERVATIVE: Only trade opps with spread > 5%
 *   2. MODERATE: Trade opps with spread > 2%
 *   3. AGGRESSIVE: Trade all opps with spread > 0.5%
 *   4. FUNDING_HARVEST: Hold all extreme funding opps for 24h
 *   5. TOP_PICKS: Top 5 opps by spread, $2k each
 *
 * For each strategy:
 *   - Total profit (assuming 50% of theoretical max due to competition)
 *   - Win rate
 *   - Average profit per trade
 *   - Capital efficiency (profit / capital deployed)
 *   - Best/worst trades
 *   - Sharpe-like metric (mean / std-dev)
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

const OPP_DB_PATH = resolve(REPO_ROOT, 'data', 'opportunities.db');
const CAPITAL = 10_000;
const POSITION_SIZE = 2_000; // $2k per trade (max 5 concurrent)
const FEE_PCT = 0.15; // average fee per leg
const CAPTURE_EFFICIENCY = 0.50; // we capture 50% of theoretical spread (competition, slippage)

interface BacktestResult {
  strategyName: string;
  totalTrades: number;
  totalProfitUsd: number;
  winRate: number;
  avgProfitPerTrade: number;
  maxWin: number;
  maxLoss: number;
  capitalEfficiency: number;
  sharpeLike: number;
  bestAsset: string;
  worstAsset: string;
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function backtestStrategy(
  name: string,
  opps: any[],
  filterFn: (o: any) => boolean,
  positionSize: number = POSITION_SIZE
): BacktestResult {
  const trades: Array<{ asset: string; profit: number; spread: number }> = [];
  const seenAssets = new Set<string>();

  // For each opp that passes the filter, simulate a trade
  for (const o of opps) {
    if (!filterFn(o)) continue;
    // Only trade each asset once per scan cycle (avoid duplicates within same scan)
    const assetKey = `${o.asset}|${o.venues}|${Math.floor(o.ts / 60_000)}`;
    if (seenAssets.has(assetKey)) continue;
    seenAssets.add(assetKey);

    const spreadPct = o.spread || 0;
    const grossProfit = positionSize * spreadPct / 100;
    const fees = positionSize * FEE_PCT / 100 * 2; // both legs
    const slippage = positionSize * 0.05 / 100 * 2; // 0.05% per leg
    const netProfit = (grossProfit - fees - slippage) * CAPTURE_EFFICIENCY;

    trades.push({ asset: o.asset, profit: netProfit, spread: spreadPct });
  }

  const wins = trades.filter(t => t.profit > 0);
  const losses = trades.filter(t => t.profit < 0);
  const totalProfit = trades.reduce((s, t) => s + t.profit, 0);
  const avgProfit = trades.length > 0 ? totalProfit / trades.length : 0;
  const maxWin = trades.length > 0 ? Math.max(...trades.map(t => t.profit)) : 0;
  const maxLoss = trades.length > 0 ? Math.min(...trades.map(t => t.profit)) : 0;

  // Sharpe-like: mean / std-dev
  const mean = avgProfit;
  const variance = trades.length > 0
    ? trades.reduce((s, t) => s + (t.profit - mean) ** 2, 0) / trades.length
    : 0;
  const stdDev = Math.sqrt(variance);
  const sharpeLike = stdDev > 0 ? mean / stdDev : 0;

  // Best/worst asset
  const byAsset: Record<string, number> = {};
  for (const t of trades) {
    byAsset[t.asset] = (byAsset[t.asset] || 0) + t.profit;
  }
  const sorted = Object.entries(byAsset).sort((a, b) => b[1] - a[1]);
  const bestAsset = sorted[0]?.[0] || '-';
  const worstAsset = sorted[sorted.length - 1]?.[0] || '-';

  const capitalEfficiency = totalProfit / CAPITAL * 100;

  return {
    strategyName: name,
    totalTrades: trades.length,
    totalProfitUsd: totalProfit,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    avgProfitPerTrade: avgProfit,
    maxWin,
    maxLoss,
    capitalEfficiency,
    sharpeLike,
    bestAsset,
    worstAsset,
  };
}

function backtestFundingStrategy(
  name: string,
  opps: any[],
  filterFn: (o: any) => boolean,
  positionSize: number = POSITION_SIZE,
  holdHours: number = 24
): BacktestResult {
  const trades: Array<{ asset: string; profit: number; funding: number }> = [];
  const seenAssets = new Set<string>();

  for (const o of opps) {
    if (!filterFn(o)) continue;
    // Only one funding position per asset at a time
    if (seenAssets.has(o.asset)) continue;
    seenAssets.add(o.asset);

    const fundingAnnual = o.funding || 0;
    const dailyRate = Math.abs(fundingAnnual) / 365 / 100;
    const grossDailyProfit = positionSize * dailyRate;
    const fees = positionSize * FEE_PCT / 100 * 2; // entry + exit
    const holdProfit = grossDailyProfit * holdHours / 24;
    const netProfit = (holdProfit - fees) * CAPTURE_EFFICIENCY;

    trades.push({ asset: o.asset, profit: netProfit, funding: fundingAnnual });
  }

  const wins = trades.filter(t => t.profit > 0);
  const losses = trades.filter(t => t.profit < 0);
  const totalProfit = trades.reduce((s, t) => s + t.profit, 0);
  const avgProfit = trades.length > 0 ? totalProfit / trades.length : 0;
  const maxWin = trades.length > 0 ? Math.max(...trades.map(t => t.profit)) : 0;
  const maxLoss = trades.length > 0 ? Math.min(...trades.map(t => t.profit)) : 0;

  const mean = avgProfit;
  const variance = trades.length > 0
    ? trades.reduce((s, t) => s + (t.profit - mean) ** 2, 0) / trades.length
    : 0;
  const stdDev = Math.sqrt(variance);
  const sharpeLike = stdDev > 0 ? mean / stdDev : 0;

  const byAsset: Record<string, number> = {};
  for (const t of trades) byAsset[t.asset] = (byAsset[t.asset] || 0) + t.profit;
  const sorted = Object.entries(byAsset).sort((a, b) => b[1] - a[1]);

  return {
    strategyName: name,
    totalTrades: trades.length,
    totalProfitUsd: totalProfit,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    avgProfitPerTrade: avgProfit,
    maxWin,
    maxLoss,
    capitalEfficiency: totalProfit / CAPITAL * 100,
    sharpeLike,
    bestAsset: sorted[0]?.[0] || '-',
    worstAsset: sorted[sorted.length - 1]?.[0] || '-',
  };
}

async function main() {
  if (!existsSync(OPP_DB_PATH)) {
    console.log('No opp database found. Run opp-db.mts --record first.');
    return;
  }
  const db = new DatabaseSync(OPP_DB_PATH);

  // Get all PRICE opps
  const priceOpps = db.prepare('SELECT * FROM opportunities WHERE type = ? ORDER BY ts').all('PRICE') as any[];
  const fundingOpps = db.prepare('SELECT * FROM opportunities WHERE type = ? ORDER BY ts').all('FUNDING') as any[];

  console.log('═══════════════════════════════════════════════════');
  console.log('  Strategy Backtester');
  console.log(`  Capital: ${fmtUsd(CAPITAL)} | Position: ${fmtUsd(POSITION_SIZE)}`);
  console.log(`  Fee: ${FEE_PCT}%/leg | Capture efficiency: ${(CAPTURE_EFFICIENCY * 100).toFixed(0)}%`);
  console.log(`  Historical opps: ${priceOpps.length} price + ${fundingOpps.length} funding`);
  console.log('═══════════════════════════════════════════════════\n');

  const results: BacktestResult[] = [];

  // Strategy 1: Conservative (only > 5% spread)
  results.push(backtestStrategy(
    '1. CONSERVATIVE (>5% spread)',
    priceOpps,
    (o) => o.spread >= 5
  ));

  // Strategy 2: Moderate (>2% spread)
  results.push(backtestStrategy(
    '2. MODERATE (>2% spread)',
    priceOpps,
    (o) => o.spread >= 2
  ));

  // Strategy 3: Aggressive (>0.5% spread)
  results.push(backtestStrategy(
    '3. AGGRESSIVE (>0.5% spread)',
    priceOpps,
    (o) => o.spread >= 0.5
  ));

  // Strategy 4: Top picks (top 5 by spread per scan)
  const topPicksMap: Record<number, any[]> = {};
  for (const o of priceOpps) {
    const minute = Math.floor(o.ts / 60_000);
    if (!topPicksMap[minute]) topPicksMap[minute] = [];
    topPicksMap[minute].push(o);
  }
  const topPicks: any[] = [];
  for (const min of Object.keys(topPicksMap)) {
    const sorted = topPicksMap[parseInt(min)].sort((a, b) => b.spread - a.spread).slice(0, 5);
    topPicks.push(...sorted);
  }
  results.push(backtestStrategy(
    '4. TOP_PICKS (top 5/min)',
    topPicks,
    () => true
  ));

  // Strategy 5: Funding harvest (24h hold, only extreme)
  results.push(backtestFundingStrategy(
    '5. FUNDING HARVEST (>100%/yr)',
    fundingOpps,
    (o) => Math.abs(o.funding) >= 100,
    POSITION_SIZE,
    24
  ));

  // Strategy 6: Funding harvest - extreme only
  results.push(backtestFundingStrategy(
    '6. FUNDING EXTREME (>500%/yr)',
    fundingOpps,
    (o) => Math.abs(o.funding) >= 500,
    POSITION_SIZE,
    24
  ));

  // Print results
  console.log('Strategy                              | Trades | Total P&L  | Win%  | Avg/Trade | Max Win | Max Loss | Cap Eff | Sharpe | Best Asset');
  console.log('──────────────────────────────────────|────────|────────────|───────|───────────|─────────|──────────|─────────|────────|────────────');
  for (const r of results) {
    console.log(
      `${r.strategyName.padEnd(36)} | ${String(r.totalTrades).padStart(6)} | ` +
      `${(r.totalProfitUsd >= 0 ? '+' : '') + fmtUsd(r.totalProfitUsd).padStart(10)} | ` +
      `${(r.winRate * 100).toFixed(0).padStart(5)}% | ` +
      `${(r.avgProfitPerTrade >= 0 ? '+' : '') + fmtUsd(r.avgProfitPerTrade).padStart(9)} | ` +
      `${fmtUsd(r.maxWin).padStart(7)} | ` +
      `${fmtUsd(r.maxLoss).padStart(8)} | ` +
      `${r.capitalEfficiency.toFixed(1).padStart(7)}% | ` +
      `${r.sharpeLike.toFixed(2).padStart(6)} | ` +
      `${r.bestAsset}`
    );
  }

  // Find best strategy
  const best = results.reduce((b, r) => r.totalProfitUsd > b.totalProfitUsd ? r : b);
  console.log(`\n── BEST STRATEGY: ${best.strategyName} ──`);
  console.log(`  Total profit: ${fmtUsd(best.totalProfitUsd)}`);
  console.log(`  Win rate: ${(best.winRate * 100).toFixed(1)}%`);
  console.log(`  Sharpe-like: ${best.sharpeLike.toFixed(2)}`);
  console.log(`  Best asset: ${best.bestAsset}`);
  console.log(`  Worst asset: ${best.worstAsset}`);

  // Recommendations
  console.log('\n── RECOMMENDATIONS ──');
  console.log(`  • Deploy capital using: ${best.strategyName}`);
  console.log(`  • Expected profit per trade: ${fmtUsd(best.avgProfitPerTrade)}`);
  console.log(`  • Best asset to focus on: ${best.bestAsset}`);
  console.log(`  • Avoid (low profit): ${best.worstAsset}`);
  if (best.sharpeLike < 0.5) {
    console.log('  • ⚠️ Low Sharpe-like ratio — high variance, consider risk management');
  } else if (best.sharpeLike > 1.5) {
    console.log('  • ✅ Excellent Sharpe-like ratio — consistent returns');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
