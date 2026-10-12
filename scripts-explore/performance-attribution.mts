// Strategy Performance Attribution Tool
// Track which strategies are making money
// Useful for:
//   - Identifying best/worst performers
//   - Adjusting capital allocation
//   - Reporting to principal
//   - Vault performance reporting

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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

const ATTRIBUTION_LOG = '/home/z/my-project/download/strategy-attribution.json';

interface StrategyRecord {
  strategy: string;
  trades: { ts: number; profit: number; notional: number }[];
  totalProfit: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalNotional: number;
}

function loadAttribution(): Record<string, StrategyRecord> {
  if (existsSync(ATTRIBUTION_LOG)) {
    return JSON.parse(readFileSync(ATTRIBUTION_LOG, 'utf8'));
  }
  return {};
}

function saveAttribution(data: Record<string, StrategyRecord>) {
  writeFileSync(ATTRIBUTION_LOG, JSON.stringify(data, null, 2));
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Strategy Performance Attribution');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Load existing attribution data
  let attribution = loadAttribution();
  console.log(`  Existing strategies tracked: ${Object.keys(attribution).length}\n`);

  // 2. Initialize strategies if not exists
  const strategies = [
    'VOOI Price Spread',
    'VOOI Funding',
    'BTC Funding',
    'kHYPE LST Carry',
    'HLP Vault',
    'CexLikeDex',
    'kHYPE AMM Discount',
    'Euler Lending',
  ];
  for (const s of strategies) {
    if (!attribution[s]) {
      attribution[s] = {
        strategy: s,
        trades: [],
        totalProfit: 0,
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        totalNotional: 0,
      };
    }
  }

  // 3. Load paper trading log to extract trades
  const paperLogPath = '/home/z/my-project/download/paper-trading-log.jsonl';
  if (existsSync(paperLogPath)) {
    const lines = readFileSync(paperLogPath, 'utf8').split('\n').filter(l => l.trim());
    const trades = lines.map(l => JSON.parse(l));
    console.log(`  Loading ${trades.length} paper trades...\n`);

    // Reset attribution
    for (const s of strategies) {
      attribution[s] = {
        strategy: s,
        trades: [],
        totalProfit: 0,
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        totalNotional: 0,
      };
    }

    // Process trades
    for (const t of trades) {
      const strategy = t.strategy;
      if (!attribution[strategy]) {
        attribution[strategy] = {
          strategy,
          trades: [],
          totalProfit: 0,
          totalTrades: 0,
          winningTrades: 0,
          losingTrades: 0,
          totalNotional: 0,
        };
      }
      const profit = t.netProfitUsd || 0;
      const notional = t.notionalUsd || 0;
      attribution[strategy].trades.push({ ts: t.ts, profit, notional });
      attribution[strategy].totalProfit += profit;
      attribution[strategy].totalTrades++;
      attribution[strategy].totalNotional += notional;
      if (profit > 0) attribution[strategy].winningTrades++;
      else if (profit < 0) attribution[strategy].losingTrades++;
    }
  }

  // 4. Display attribution report
  console.log('═══════════════════════════════════════════════════');
  console.log('  Strategy Attribution Report');
  console.log('═══════════════════════════════════════════════════\n');

  console.log('Strategy                     | Trades | Wins  | Losses | Win Rate | Total Profit | Avg Trade | Total Notional');
  console.log('─────────────────────────────|────────|───────|────────|──────────|──────────────|───────────|───────────────');
  const sortedStrategies = Object.values(attribution).sort((a, b) => b.totalProfit - a.totalProfit);
  let grandTotalProfit = 0;
  let grandTotalTrades = 0;
  let grandTotalNotional = 0;
  for (const s of sortedStrategies) {
    if (s.totalTrades === 0) continue;
    const winRate = (s.winningTrades / s.totalTrades * 100).toFixed(1);
    const avgTrade = s.totalProfit / s.totalTrades;
    console.log(`${s.strategy.padEnd(29)}| ${s.totalTrades.toString().padStart(6)} | ${s.winningTrades.toString().padStart(5)} | ${s.losingTrades.toString().padStart(6)} | ${winRate.padStart(7)}% | $${s.totalProfit.toFixed(0).padStart(12)} | $${avgTrade.toFixed(2).padStart(9)} | $${s.totalNotional.toFixed(0).padStart(13)}`);
    grandTotalProfit += s.totalProfit;
    grandTotalTrades += s.totalTrades;
    grandTotalNotional += s.totalNotional;
  }
  console.log('─────────────────────────────|────────|───────|────────|──────────|──────────────|───────────|───────────────');
  console.log(`${'TOTAL'.padEnd(29)}| ${grandTotalTrades.toString().padStart(6)} | ${''.padStart(5)} | ${''.padStart(6)} | ${''.padStart(7)} | $${grandTotalProfit.toFixed(0).padStart(12)} | ${''.padStart(9)} | $${grandTotalNotional.toFixed(0).padStart(13)}`);

  // 5. Strategy rankings
  console.log('\n── Strategy Rankings (by total profit) ──\n');
  for (let i = 0; i < sortedStrategies.length; i++) {
    const s = sortedStrategies[i];
    if (s.totalTrades === 0) continue;
    const pct = (s.totalProfit / grandTotalProfit * 100).toFixed(1);
    console.log(`  ${i + 1}. ${s.strategy.padEnd(29)} $${s.totalProfit.toFixed(0)} (${pct}% of total)`);
  }

  // 6. Performance insights
  console.log('\n── Performance Insights ──\n');
  const bestStrategy = sortedStrategies[0];
  const worstStrategy = sortedStrategies[sortedStrategies.length - 1];
  console.log(`  Best performer: ${bestStrategy.strategy} ($${bestStrategy.totalProfit.toFixed(0)})`);
  console.log(`  Worst performer: ${worstStrategy.strategy} ($${worstStrategy.totalProfit.toFixed(0)})`);
  console.log(`  Total profit: $${grandTotalProfit.toFixed(0)}`);
  console.log(`  Total trades: ${grandTotalTrades}`);
  console.log(`  Average profit per trade: $${(grandTotalProfit / grandTotalTrades).toFixed(2)}`);
  console.log('');

  // 7. Recommendations
  console.log('── Recommendations ──\n');
  console.log('  Based on attribution data:');
  console.log(`  1. INCREASE allocation to ${bestStrategy.strategy}`);
  console.log(`     Current profit: $${bestStrategy.totalProfit.toFixed(0)}`);
  console.log(`     If doubled: $${(bestStrategy.totalProfit * 2).toFixed(0)}`);
  console.log('');
  console.log(`  2. EVALUATE ${worstStrategy.strategy}`);
  console.log(`     Current profit: $${worstStrategy.totalProfit.toFixed(0)}`);
  console.log(`     Consider: reducing allocation or fixing strategy`);
  console.log('');
  console.log('  3. DIVERSIFY across top 3 strategies');
  console.log(`     Top 3 total: $${sortedStrategies.slice(0, 3).reduce((s, x) => s + x.totalProfit, 0).toFixed(0)}`);
  console.log(`     As % of total: ${(sortedStrategies.slice(0, 3).reduce((s, x) => s + x.totalProfit, 0) / grandTotalProfit * 100).toFixed(1)}%`);
  console.log('');

  // Save attribution
  saveAttribution(attribution);
  console.log(`Attribution saved to ${ATTRIBUTION_LOG}`);

  console.log('\n=== Verdict ===');
  console.log('Attribution tracking is ESSENTIAL for vault management.');
  console.log('  ✅ Identifies best/worst performers');
  console.log('  ✅ Enables capital reallocation');
  console.log('  ✅ Required for vault reporting');
  console.log('  ✅ Helps identify strategy failures early');
  console.log('');
  console.log('ACTION: Run daily to track performance');
  console.log('  Add to daily report');
  console.log('  Alert when strategy underperforms > 20%');
}

main().catch(console.error);
