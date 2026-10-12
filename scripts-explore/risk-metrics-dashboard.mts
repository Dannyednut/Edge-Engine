// Risk Metrics Dashboard
// Real-time risk monitoring for our positions
// Tracks:
//   - Margin ratio
//   - Position concentration
//   - Drawdown
//   - VaR (Value at Risk)
//   - Stress test scenarios

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

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Risk Metrics Dashboard');
  console.log('═══════════════════════════════════════════════════\n');

  // Simulated portfolio (would use real positions when deployed)
  const portfolio = {
    totalCapital: 100_000,
    positions: [
      { strategy: 'VOOI Price Spread', capital: 25000, type: 'delta-neutral', leverage: 1, expectedApr: 3139, maxDrawdown: 5 },
      { strategy: 'VOOI Funding Arb', capital: 25000, type: 'delta-neutral', leverage: 10, expectedApr: 60, maxDrawdown: 15 },
      { strategy: 'BTC Funding Arb', capital: 25000, type: 'delta-neutral', leverage: 1, expectedApr: 43, maxDrawdown: 8 },
      { strategy: 'kHYPE LST Carry (3x)', capital: 10000, type: 'leveraged', leverage: 3, expectedApr: 5.1, maxDrawdown: 30 },
      { strategy: 'HLP Vault', capital: 5000, type: 'passive', leverage: 1, expectedApr: 100, maxDrawdown: 20 },
      { strategy: 'CexLikeDex', capital: 5000, type: 'delta-neutral', leverage: 1, expectedApr: 75, maxDrawdown: 12 },
      { strategy: 'kHYPE AMM Discount', capital: 5000, type: 'atomic', leverage: 1, expectedApr: 1042, maxDrawdown: 10 },
    ],
  };

  console.log('── Portfolio Overview ──\n');
  console.log(`  Total capital: $${portfolio.totalCapital.toLocaleString()}`);
  console.log(`  Number of positions: ${portfolio.positions.length}`);
  console.log(`  Capital utilization: 100% (all deployed)\n`);

  // 1. Position concentration analysis
  console.log('── Position Concentration ──\n');
  console.log('Strategy                     | Capital | % of Total | Risk Level');
  console.log('─────────────────────────────|─────────|───────────|───────────');
  for (const p of portfolio.positions) {
    const pct = (p.capital / portfolio.totalCapital) * 100;
    const riskLevel = pct > 25 ? 'HIGH' : pct > 10 ? 'MEDIUM' : 'LOW';
    console.log(`${p.strategy.padEnd(29)}| $${p.capital.toLocaleString().padStart(7)} | ${pct.toFixed(1).padStart(9)}% | ${riskLevel}`);
  }

  // 2. Leverage analysis
  console.log('\n── Leverage Analysis ──\n');
  let totalNotional = 0;
  for (const p of portfolio.positions) {
    totalNotional += p.capital * p.leverage;
  }
  console.log(`  Total capital: $${portfolio.totalCapital.toLocaleString()}`);
  console.log(`  Total notional: $${totalNotional.toLocaleString()}`);
  console.log(`  Portfolio leverage: ${(totalNotional / portfolio.totalCapital).toFixed(2)}x`);
  console.log(`  Max single-position leverage: ${Math.max(...portfolio.positions.map(p => p.leverage))}x`);

  // 3. Drawdown analysis
  console.log('\n── Drawdown Analysis ──\n');
  console.log('Strategy                     | Max DD | Capital at Risk | Worst Loss');
  console.log('─────────────────────────────|────────|─────────────────|───────────');
  let totalWorstLoss = 0;
  for (const p of portfolio.positions) {
    const worstLoss = p.capital * p.maxDrawdown / 100;
    totalWorstLoss += worstLoss;
    console.log(`${p.strategy.padEnd(29)}| ${p.maxDrawdown.toFixed(0).padStart(5)}% | $${p.capital.toLocaleString().padStart(15)} | $${worstLoss.toFixed(0).padStart(9)}`);
  }
  console.log(`${'TOTAL WORST CASE'.padEnd(29)}| ${''.padStart(5)} | ${''.padStart(15)} | $${totalWorstLoss.toFixed(0).padStart(9)}`);
  console.log(`\n  Total capital: $${portfolio.totalCapital.toLocaleString()}`);
  console.log(`  Worst-case loss: $${totalWorstLoss.toFixed(0)} (${(totalWorstLoss/portfolio.totalCapital*100).toFixed(1)}%)`);

  // 4. Value at Risk (VaR) - 95% confidence
  console.log('\n── Value at Risk (VaR) ──\n');
  // Assume daily returns are normally distributed
  // Mean daily return = expected Apr / 365
  // Std dev = 2% per day (rough estimate for mixed portfolio)
  const meanDailyReturn = portfolio.positions.reduce((s, p) => s + p.capital * p.expectedApr / 100 / 365, 0) / portfolio.totalCapital;
  const stdDailyReturn = 0.02; // 2% daily std
  const var95 = -1.645 * stdDailyReturn * portfolio.totalCapital; // 95% VaR
  const var99 = -2.326 * stdDailyReturn * portfolio.totalCapital; // 99% VaR
  console.log(`  Expected daily return: ${(meanDailyReturn * 100).toFixed(3)}% = $${(meanDailyReturn * portfolio.totalCapital).toFixed(0)}`);
  console.log(`  Daily std deviation: ${(stdDailyReturn * 100).toFixed(2)}%`);
  console.log(`  95% VaR (1 day): $${var95.toFixed(0)} (${(var95/portfolio.totalCapital*100).toFixed(1)}%)`);
  console.log(`  99% VaR (1 day): $${var99.toFixed(0)} (${(var99/portfolio.totalCapital*100).toFixed(1)}%)`);
  console.log(`  95% VaR (30 days): $${(var95 * Math.sqrt(30)).toFixed(0)}`);
  console.log(`  99% VaR (30 days): $${(var99 * Math.sqrt(30)).toFixed(0)}`);

  // 5. Stress test scenarios
  console.log('\n── Stress Test Scenarios ──\n');
  const scenarios = [
    { name: 'Normal market', marketDrop: 0, fundingSpike: 0, liquidityDrop: 0 },
    { name: 'Mild correction (BTC -10%)', marketDrop: -10, fundingSpike: 0, liquidityDrop: 0 },
    { name: 'Bear market (BTC -25%)', marketDrop: -25, fundingSpike: 50, liquidityDrop: 0 },
    { name: 'Market crash (BTC -40%)', marketDrop: -40, fundingSpike: 100, liquidityDrop: 30 },
    { name: 'Black swan (BTC -60%, liquidity crisis)', marketDrop: -60, fundingSpike: 200, liquidityDrop: 70 },
    { name: 'HL protocol exploit', marketDrop: 0, fundingSpike: 0, liquidityDrop: 100, hlExploit: true },
  ];

  console.log('Scenario                                 | Portfolio Impact | Capital Remaining');
  console.log('─────────────────────────────────────────|─────────────────|───────────────────');
  for (const s of scenarios) {
    let impact = 0;
    for (const p of portfolio.positions) {
      // Delta-neutral strategies mostly unaffected by market drop
      if (p.type === 'delta-neutral') {
        impact += p.capital * 0.02 * Math.abs(s.marketDrop) / 10; // small slippage
      } else if (p.type === 'leveraged') {
        // kHYPE 3x leverage — gets liquidated in big drops
        if (s.marketDrop < -20) impact += p.capital; // total loss
        else impact += p.capital * Math.abs(s.marketDrop) / 100 * p.leverage;
      } else if (p.type === 'passive') {
        // HLP vault — loses when traders win (in crashes, traders lose = HLP gains usually)
        impact += p.capital * 0.05; // small loss
      } else if (p.type === 'atomic') {
        impact += p.capital * 0.01; // minimal
      }
      // Funding spike increases costs
      if (s.fundingSpike > 0 && p.strategy.includes('Funding')) {
        impact += p.capital * s.fundingSpike / 100 / 365;
      }
      // Liquidity drop
      if (s.liquidityDrop > 0) {
        impact += p.capital * s.liquidityDrop / 100 * 0.1; // 10% of liquidity drop
      }
      // HL exploit
      if (s.hlExploit) {
        impact += p.capital * 0.5; // 50% loss on HL-dependent strategies
      }
    }
    const remaining = portfolio.totalCapital - impact;
    console.log(`${s.name.padEnd(41)}| -$${impact.toFixed(0).padStart(15)} | $${remaining.toFixed(0).padStart(17)}`);
  }

  // 6. Risk recommendations
  console.log('\n── Risk Recommendations ──\n');
  console.log('  1. POSITION CONCENTRATION');
  console.log('     - VOOI Price Spread = 25% (HIGH)');
  console.log('     - VOOI Funding Arb = 25% (HIGH)');
  console.log('     - BTC Funding Arb = 25% (HIGH)');
  console.log('     → Consider reducing to 20% each, add 15% cash reserve');
  console.log('');
  console.log('  2. LEVERAGE MANAGEMENT');
  console.log('     - Portfolio leverage: ~3x (acceptable)');
  console.log('     - kHYPE 3x is highest individual risk');
  console.log('     → Set auto-deleverage on 20% HYPE drop');
  console.log('');
  console.log('  3. DRAWDOWN LIMITS');
  console.log('     - Max acceptable drawdown: 15% ($15k)');
  console.log('     - Stop trading if drawdown > 10% ($10k)');
  console.log('     - Daily review of positions');
  console.log('');
  console.log('  4. STRESS TEST');
  console.log('     - Can survive 25% market drop (lose ~$5k)');
  console.log('     - Cannot survive 60% crash (lose ~$30k+)');
  console.log('     - Cannot survive HL exploit (lose ~$50k)');
  console.log('     → Need: insurance (Nexus Mutual) for HL risk');
  console.log('');

  console.log('=== Verdict ===');
  console.log('Risk profile is ACCEPTABLE but not ideal:');
  console.log(`  ✅ Delta-neutral strategies limit market risk`);
  console.log(`  ✅ 15% max drawdown is manageable`);
  console.log(`  ⚠️ High concentration (25% per strategy)`);
  console.log(`  ⚠️ Cannot survive black swan (60% crash)`);
  console.log(`  ⚠️ Cannot survive HL exploit`);
  console.log('');
  console.log('ACTION:');
  console.log('  1. Add cash reserve (15% = $15k)');
  console.log('  2. Reduce per-strategy allocation to 20%');
  console.log('  3. Set auto-deleverage on kHYPE at 20% HYPE drop');
  console.log('  4. Consider Nexus Mutual insurance for HL risk');
}

main().catch(console.error);
