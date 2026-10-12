/**
 * Position Sizing Calculator — Kelly Criterion for Arbitrage
 *
 * For each opportunity, calculate the optimal position size based on:
 *   - Edge (expected return)
 *   - Variance (historical spread variance)
 *   - Win rate (from paper trader history)
 *   - Max position cap (risk management)
 *
 * Kelly fraction: f* = (p*b - q) / b
 *   p = win probability
 *   q = 1 - p
 *   b = win/loss ratio (avg win / avg loss)
 *
 * We use HALF-KELLY (f/2) for safety — recommended for real trading.
 *
 * Inputs:
 *   - Asset
 *   - Strategy type (PRICE / FUNDING / IMBALANCE)
 *   - Expected return %
 *   - Capital available
 *
 * Output:
 *   - Recommended position size (USD)
 *   - Expected profit (USD)
 *   - Risk metrics
 *   - Capital allocation breakdown
 */

import { readFileSync, existsSync } from 'node:fs';
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

const PAPER_STATE = '/home/z/my-project/download/paper-trading-state.json';
const OPP_DB_PATH = resolve(REPO_ROOT, 'data', 'opportunities.db');

interface StrategyStats {
  winRate: number;        // 0-1
  avgWinPct: number;      // % of capital per winning trade
  avgLossPct: number;     // % of capital per losing trade (positive number)
  totalTrades: number;
  avgSpreadPct: number;   // average spread captured
}

function loadPaperStats(): Record<string, StrategyStats> {
  if (!existsSync(PAPER_STATE)) {
    return {
      'VOOI Price Spread Arb': { winRate: 0.95, avgWinPct: 1.5, avgLossPct: 0.3, totalTrades: 0, avgSpreadPct: 1.0 },
      'VOOI Funding Rate Arb': { winRate: 0.85, avgWinPct: 0.5, avgLossPct: 0.5, totalTrades: 0, avgSpreadPct: 0.0 },
    };
  }
  try {
    const state = JSON.parse(readFileSync(PAPER_STATE, 'utf8'));
    const positions = state.closedPositions || [];
    const byStrategy: Record<string, any[]> = {};
    for (const p of positions) {
      const s = p.strategy || 'unknown';
      if (!byStrategy[s]) byStrategy[s] = [];
      byStrategy[s].push(p);
    }
    const result: Record<string, StrategyStats> = {};
    for (const [strategy, trades] of Object.entries(byStrategy)) {
      const wins = trades.filter(t => (t.netProfitUsd || 0) > 0);
      const losses = trades.filter(t => (t.netProfitUsd || 0) < 0);
      const winRate = trades.length > 0 ? wins.length / trades.length : 0.5;
      const avgWinPct = wins.length > 0
        ? wins.reduce((s, t) => s + (t.netProfitUsd / t.notionalUsd * 100), 0) / wins.length
        : 0;
      const avgLossPct = losses.length > 0
        ? Math.abs(losses.reduce((s, t) => s + (t.netProfitUsd / t.notionalUsd * 100), 0) / losses.length)
        : 0;
      result[strategy] = {
        winRate,
        avgWinPct,
        avgLossPct: avgLossPct || 0.3,
        totalTrades: trades.length,
        avgSpreadPct: 0,
      };
    }
    return result;
  } catch {
    return {};
  }
}

function kellyFraction(winRate: number, avgWinPct: number, avgLossPct: number): number {
  // f* = (p*b - q) / b
  // where b = avgWin / avgLoss
  if (avgLossPct === 0) return 0.5;  // no losses = take half capital
  const b = avgWinPct / avgLossPct;
  const p = winRate;
  const q = 1 - p;
  const f = (p * b - q) / b;
  return Math.max(0, f);
}

interface SizingResult {
  strategy: string;
  asset: string;
  expectedReturnPct: number;
  winRate: number;
  kellyFraction: number;
  halfKellyFraction: number;
  recommendedSizeUsd: number;
  expectedProfitUsd: number;
  maxLossUsd: number;
  riskScore: number;  // 1-10 (10 = highest risk)
  notes: string[];
}

function sizeOpportunity(
  strategy: string,
  asset: string,
  expectedReturnPct: number,
  capitalAvailable: number,
  strategyStats: Record<string, StrategyStats>
): SizingResult {
  const stats = strategyStats[strategy] || {
    winRate: 0.90,
    avgWinPct: expectedReturnPct,
    avgLossPct: 0.3,
    totalTrades: 0,
    avgSpreadPct: expectedReturnPct,
  };

  const kelly = kellyFraction(stats.winRate, stats.avgWinPct, stats.avgLossPct);
  const halfKelly = kelly / 2;

  // Risk caps
  const maxPositionPctCap = 0.20;  // Never more than 20% of capital in one trade
  const maxPositionUsdCap = 10_000; // $10k hard cap per trade

  const sizeFraction = Math.min(halfKelly, maxPositionPctCap);
  const sizeUsd = Math.min(sizeFraction * capitalAvailable, maxPositionUsdCap);

  const expectedProfitUsd = sizeUsd * expectedReturnPct / 100 * stats.winRate
                           - sizeUsd * stats.avgLossPct / 100 * (1 - stats.winRate);
  const maxLossUsd = sizeUsd * stats.avgLossPct / 100;

  // Risk score: 1-10 based on win rate, sample size, and expected return
  const sampleSizeScore = Math.min(stats.totalTrades / 50, 1) * 3; // 0-3
  const winRateScore = stats.winRate * 4; // 0-4
  const returnScore = Math.min(expectedReturnPct / 10, 1) * 3; // 0-3
  const riskScore = Math.max(1, Math.min(10, 10 - (sampleSizeScore + winRateScore + returnScore)));

  const notes: string[] = [];
  if (stats.totalTrades < 10) notes.push('⚠️ Low sample size — paper trade more before going live');
  if (kelly > 0.5) notes.push('🔥 High Kelly fraction — opportunity is excellent');
  if (halfKelly > maxPositionPctCap) notes.push(`🛑 Kelly wants ${(halfKelly*100).toFixed(0)}% but capped at ${(maxPositionPctCap*100).toFixed(0)}%`);
  if (expectedReturnPct > 5) notes.push('💰 High return — verify the spread is real (not stale quote)');
  if (stats.winRate < 0.8) notes.push('⚠️ Win rate below 80% — increase caution');
  if (sizeUsd < 1000) notes.push('📦 Small position — spread might not cover fees');

  return {
    strategy,
    asset,
    expectedReturnPct,
    winRate: stats.winRate,
    kellyFraction: kelly,
    halfKellyFraction: halfKelly,
    recommendedSizeUsd: sizeUsd,
    expectedProfitUsd,
    maxLossUsd,
    riskScore,
    notes,
  };
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

async function main() {
  const capitalAvailable = parseFloat(process.env.WORKING_CAPITAL_USD || '5000');
  const stats = loadPaperStats();

  console.log('═══════════════════════════════════════════════════');
  console.log('  Position Sizing Calculator — Kelly Criterion');
  console.log(`  Capital available: ${fmtUsd(capitalAvailable)}`);
  console.log('═══════════════════════════════════════════════════\n');

  // Show strategy stats from paper trader
  console.log('── Strategy Stats (from paper trader history) ──');
  for (const [name, s] of Object.entries(stats)) {
    console.log(`  ${name}:`);
    console.log(`    Win rate: ${(s.winRate * 100).toFixed(1)}% (${s.totalTrades} trades)`);
    console.log(`    Avg win: ${s.avgWinPct.toFixed(2)}% | Avg loss: ${s.avgLossPct.toFixed(2)}%`);
    console.log(`    Kelly: ${(kellyFraction(s.winRate, s.avgWinPct, s.avgLossPct) * 100).toFixed(1)}% (half: ${(kellyFraction(s.winRate, s.avgWinPct, s.avgLossPct) * 50).toFixed(1)}%)`);
  }
  console.log('');

  // Sample opportunities to size
  const sampleOpps = [
    { strategy: 'VOOI Price Spread Arb', asset: 'BP',                 expectedReturnPct: 9.23 },
    { strategy: 'VOOI Price Spread Arb', asset: 'alias:anthropic',    expectedReturnPct: 4.28 },
    { strategy: 'VOOI Price Spread Arb', asset: 'alias:oura',         expectedReturnPct: 3.70 },
    { strategy: 'VOOI Price Spread Arb', asset: 'ONE',                expectedReturnPct: 2.91 },
    { strategy: 'VOOI Funding Rate Arb', asset: 'RSR (HL -1553%/yr)', expectedReturnPct: 4.25 },  // $212/$5k/day = 4.25%/day
    { strategy: 'VOOI Funding Rate Arb', asset: 'AZTEC (HL +183%/yr)', expectedReturnPct: 0.50 },  // $25/$5k/day = 0.5%/day
    { strategy: 'VOOI Funding Rate Arb', asset: 'MINA (HL -167%/yr)', expectedReturnPct: 0.46 },
  ];

  console.log('── Position Sizing Recommendations ──');
  console.log('');
  console.log('Strategy                | Asset                        | ExpRet% | WinRate | Kelly% | Size     | ExpProfit | MaxLoss | Risk');
  console.log('────────────────────────|──────────────────────────────|─────────|─────────|────────|──────────|───────────|─────────|─────');

  for (const opp of sampleOpps) {
    const r = sizeOpportunity(opp.strategy, opp.asset, opp.expectedReturnPct, capitalAvailable, stats);
    console.log(
      `${opp.strategy.padEnd(24)}| ${opp.asset.padEnd(28)} | ` +
      `${opp.expectedReturnPct.toFixed(2).padStart(7)}% | ` +
      `${(r.winRate * 100).toFixed(0).padStart(7)}% | ` +
      `${(r.halfKellyFraction * 100).toFixed(1).padStart(6)}% | ` +
      `${fmtUsd(r.recommendedSizeUsd).padStart(8)} | ` +
      `${fmtUsd(r.expectedProfitUsd).padStart(9)} | ` +
      `${fmtUsd(r.maxLossUsd).padStart(7)} | ` +
      `${r.riskScore.toFixed(1)}/10`
    );
    if (r.notes.length > 0) {
      for (const n of r.notes) console.log(`                          ↳ ${n}`);
    }
  }

  console.log('');
  console.log('── Capital Allocation Recommendation ──');
  // Allocate capital across top opps with half-Kelly fractions
  const allocations: Array<{ opp: any; size: number; pct: number }> = [];
  let remaining = capitalAvailable;
  for (const opp of sampleOpps.slice(0, 5)) {
    if (remaining <= 0) break;
    const r = sizeOpportunity(opp.strategy, opp.asset, opp.expectedReturnPct, capitalAvailable, stats);
    const size = Math.min(r.recommendedSizeUsd, remaining);
    allocations.push({ opp, size, pct: (size / capitalAvailable) * 100 });
    remaining -= size;
  }

  console.log(`  Total capital: ${fmtUsd(capitalAvailable)}`);
  for (const a of allocations) {
    console.log(`  ${a.opp.asset.padEnd(30)} ${fmtUsd(a.size).padStart(8)} (${a.pct.toFixed(1)}%)`);
  }
  console.log(`  ${'Cash reserve'.padEnd(30)} ${fmtUsd(remaining).padStart(8)} (${(remaining / capitalAvailable * 100).toFixed(1)}%)`);
}

main().catch(err => { console.error(err); process.exit(1); });
