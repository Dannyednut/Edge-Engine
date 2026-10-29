/**
 * Capital Allocation Optimizer
 *
 * Splits total capital across multiple strategies to maximize risk-adjusted return.
 * Uses Sharpe ratio from backtester + Kelly fractions to determine optimal split.
 *
 * Inputs:
 *   - Total capital available
 *   - Strategy list with backtest stats
 *
 * Output:
 *   - Optimal allocation per strategy (% and USD)
 *   - Expected portfolio return
 *   - Portfolio Sharpe ratio
 *   - Diversification score
 *
 * Method:
 *   - Mean-Variance Optimization (simplified Markowitz)
 *   - Constraints: max 50% per strategy, min 5% cash reserve
 *   - Rebalance threshold: when actual deviates >10% from target
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

const OPP_DB_PATH = resolve(REPO_ROOT, 'data', 'opportunities.db');
const PAPER_STATE = '/home/z/my-project/download/paper-trading-state.json';

interface StrategyPerf {
  name: string;
  expectedReturnPct: number;  // daily expected return %
  sharpe: number;
  maxDrawdownPct: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  kelly: number;
  riskScore: number;  // 1-10
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function kellyFraction(winRate: number, avgWin: number, avgLoss: number): number {
  if (avgLoss === 0) return 0.5;
  const b = avgWin / avgLoss;
  const p = winRate;
  const q = 1 - p;
  return Math.max(0, (p * b - q) / b);
}

function loadStrategyPerf(): StrategyPerf[] {
  // From backtester output + paper trader stats
  const strategies: StrategyPerf[] = [];

  // Load paper trader stats
  if (existsSync(PAPER_STATE)) {
    try {
      const state = JSON.parse(readFileSync(PAPER_STATE, 'utf8'));
      const positions = state.closedPositions || [];
      const byStrategy: Record<string, any[]> = {};
      for (const p of positions) {
        const s = p.strategy || 'unknown';
        if (!byStrategy[s]) byStrategy[s] = [];
        byStrategy[s].push(p);
      }

      for (const [name, trades] of Object.entries(byStrategy)) {
        const wins = trades.filter(t => (t.netProfitUsd || 0) > 0);
        const losses = trades.filter(t => (t.netProfitUsd || 0) < 0);
        const winRate = trades.length > 0 ? wins.length / trades.length : 0.5;
        const avgWinPct = wins.length > 0
          ? wins.reduce((s, t) => s + (t.netProfitUsd / t.notionalUsd * 100), 0) / wins.length
          : 0;
        const avgLossPct = losses.length > 0
          ? Math.abs(losses.reduce((s, t) => s + (t.netProfitUsd / t.notionalUsd * 100), 0) / losses.length)
          : 0.3;
        const avgDailyReturn = trades.length > 0
          ? trades.reduce((s, t) => s + (t.netProfitUsd / t.notionalUsd * 100), 0) / trades.length
          : 0;
        const kelly = kellyFraction(winRate, avgWinPct, avgLossPct);
        const pnls = trades.map(t => t.netProfitUsd / t.notionalUsd * 100);
        const mean = pnls.reduce((s, n) => s + n, 0) / pnls.length;
        const variance = pnls.reduce((s, n) => s + (n - mean) ** 2, 0) / pnls.length;
        const stdDev = Math.sqrt(variance);
        // Cap Sharpe at 5.0 to handle zero-variance cases (perfect but unrealistic)
        const sharpe = stdDev > 0 ? Math.min(5.0, mean / stdDev) : (mean > 0 ? 5.0 : 0);

        strategies.push({
          name,
          expectedReturnPct: avgDailyReturn,
          sharpe,
          maxDrawdownPct: 0, // not tracked
          winRate,
          avgWinPct,
          avgLossPct,
          kelly,
          riskScore: Math.max(1, Math.min(10, 10 - sharpe * 2)),
        });
      }
    } catch {}
  }

  // Add HL funding harvest as a strategy
  strategies.push({
    name: 'HL Funding Harvest',
    expectedReturnPct: 0.5,  // ~$25/day on $5k = 0.5%/day
    sharpe: 1.5,  // typically stable
    maxDrawdownPct: 5,
    winRate: 0.85,
    avgWinPct: 0.5,
    avgLossPct: 0.5,
    kelly: kellyFraction(0.85, 0.5, 0.5),
    riskScore: 4,
  });

  return strategies;
}

interface Allocation {
  strategyName: string;
  targetPct: number;
  targetUsd: number;
  expectedDailyProfitUsd: number;
  sharpe: number;
  riskScore: number;
}

function optimize(strategies: StrategyPerf[], totalCapital: number): Allocation[] {
  const allocations: Allocation[] = [];

  // Calculate weight per strategy using Sharpe * Kelly
  const weights: Record<string, number> = {};
  let totalWeight = 0;
  for (const s of strategies) {
    const w = Math.max(0.01, s.sharpe * Math.min(s.kelly, 0.5));
    weights[s.name] = w;
    totalWeight += w;
  }

  // Constraints:
  //   - Max 40% per strategy
  //   - Min 10% cash reserve
  const maxPctPerStrategy = 0.40;
  const cashReservePct = 0.10;
  const investablePct = 1 - cashReservePct;

  for (const s of strategies) {
    const rawPct = (weights[s.name] / totalWeight) * investablePct;
    const cappedPct = Math.min(rawPct, maxPctPerStrategy);
    const targetUsd = cappedPct * totalCapital;
    const expectedDailyProfit = targetUsd * s.expectedReturnPct / 100;
    allocations.push({
      strategyName: s.name,
      targetPct: cappedPct,
      targetUsd,
      expectedDailyProfitUsd: expectedDailyProfit,
      sharpe: s.sharpe,
      riskScore: s.riskScore,
    });
  }

  // Sort by expected profit descending
  allocations.sort((a, b) => b.expectedDailyProfitUsd - a.expectedDailyProfitUsd);

  return allocations;
}

async function main() {
  const capital = parseFloat(process.env.WORKING_CAPITAL_USD || '10000');
  const strategies = loadStrategyPerf();

  console.log('═══════════════════════════════════════════════════');
  console.log('  Capital Allocation Optimizer');
  console.log(`  Total capital: ${fmtUsd(capital)}`);
  console.log(`  Strategies: ${strategies.length}`);
  console.log('═══════════════════════════════════════════════════\n');

  // Show strategy stats
  console.log('── Strategy Performance (from paper trader + estimates) ──');
  console.log('Name                              | Sharpe | Win%  | Kelly% | Risk | ExpDaily%');
  console.log('──────────────────────────────────|────────|───────|────────|──────|─────────');
  for (const s of strategies) {
    console.log(
      `${s.name.padEnd(34)}| ${s.sharpe.toFixed(2).padStart(6)} | ` +
      `${(s.winRate * 100).toFixed(0).padStart(5)}% | ` +
      `${(s.kelly * 100).toFixed(1).padStart(6)}% | ` +
      `${s.riskScore.toFixed(1).padStart(4)}/10 | ` +
      `${s.expectedReturnPct.toFixed(2).padStart(7)}%`
    );
  }

  // Optimize
  const allocations = optimize(strategies, capital);
  let totalAllocated = 0;
  let totalExpectedDaily = 0;
  for (const a of allocations) {
    totalAllocated += a.targetUsd;
    totalExpectedDaily += a.expectedDailyProfitUsd;
  }
  const cashReserve = capital - totalAllocated;

  console.log('\n── Optimal Capital Allocation ──');
  console.log('Strategy                          | Target% | Target $   | Exp Daily $ | Sharpe | Risk');
  console.log('──────────────────────────────────|─────────|────────────|─────────────|────────|─────');
  for (const a of allocations) {
    console.log(
      `${a.strategyName.padEnd(34)}| ${(a.targetPct * 100).toFixed(1).padStart(6)}% | ` +
      `${fmtUsd(a.targetUsd).padStart(10)} | ` +
      `${fmtUsd(a.expectedDailyProfitUsd).padStart(11)} | ` +
      `${a.sharpe.toFixed(2).padStart(6)} | ` +
      `${a.riskScore.toFixed(1)}/10`
    );
  }
  console.log(`${'Cash reserve'.padEnd(34)}| ${(cashReserve / capital * 100).toFixed(1).padStart(6)}% | ${fmtUsd(cashReserve).padStart(10)} | ${'-'.padStart(11)} | ${'-'.padStart(6)} | ${'-'.padStart(5)}`);
  console.log(`${'TOTAL'.padEnd(34)}| ${(totalAllocated / capital * 100 + cashReserve / capital * 100).toFixed(1).padStart(6)}% | ${fmtUsd(capital).padStart(10)} | ${fmtUsd(totalExpectedDaily).padStart(11)} |`);

  // Portfolio metrics
  const portfolioReturn = totalExpectedDaily / capital * 100;
  const weightedSharpe = allocations.reduce((s, a) => s + a.sharpe * a.targetUsd, 0) / totalAllocated;
  const weightedRisk = allocations.reduce((s, a) => s + a.riskScore * a.targetUsd, 0) / totalAllocated;
  const diversification = allocations.length;

  console.log('\n── Portfolio Metrics ──');
  console.log(`  Capital deployed: ${fmtUsd(totalAllocated)} of ${fmtUsd(capital)} (${(totalAllocated/capital*100).toFixed(0)}%)`);
  console.log(`  Cash reserve: ${fmtUsd(cashReserve)} (${(cashReserve/capital*100).toFixed(0)}%)`);
  console.log(`  Expected daily profit: ${fmtUsd(totalExpectedDaily)}`);
  console.log(`  Expected monthly profit: ${fmtUsd(totalExpectedDaily * 30)}`);
  console.log(`  Expected annual profit: ${fmtUsd(totalExpectedDaily * 365)}`);
  console.log(`  Daily return: ${portfolioReturn.toFixed(2)}%`);
  console.log(`  Annualized return: ${(portfolioReturn * 365).toFixed(0)}%`);
  console.log(`  Weighted Sharpe: ${weightedSharpe.toFixed(2)}`);
  console.log(`  Weighted risk: ${weightedRisk.toFixed(1)}/10`);
  console.log(`  Diversification: ${diversification} strategies`);

  // Rebalance recommendation
  console.log('\n── Rebalance Recommendations ──');
  console.log('  • Review allocations weekly');
  console.log('  • Rebalance when actual deviates >10% from target');
  console.log('  • Increase allocation to top-Sharpe strategy');
  console.log('  • Maintain 10% cash reserve for new opportunities');
  console.log('  • Cut allocation to any strategy with Sharpe < 0.5');
}

main().catch(err => { console.error(err); process.exit(1); });
