// Risk Metrics Dashboard — shows risk profile of each strategy
// Helps principal understand downside scenarios before deploying capital

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..');

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

  const strategies = [
    {
      name: 'VOOI Price Spread Arb',
      capital: 25000,
      apr: 3139,
      riskLevel: 'LOW',
      maxDrawdown: 5, // % of capital
      liquidationRisk: 'NONE (instant capture, no holding)',
      protocolRisk: 'VOOI + 12 venues (HL, Aster, Lighter, etc.)',
      smartContractRisk: 'MEDIUM (VOOI smart contracts)',
      regulatoryRisk: 'LOW (perp arb is standard)',
      worstCase: 'Lose 5% if all venues simultaneously fail',
      mitigation: 'Diversify across 5+ venue pairs',
    },
    {
      name: 'VOOI Funding Rate Arb',
      capital: 25000,
      apr: 60, // mid estimate
      riskLevel: 'MEDIUM',
      maxDrawdown: 15,
      liquidationRisk: 'LOW (10x leverage, 50% margin buffer)',
      protocolRisk: 'VOOI + 12 venues',
      smartContractRisk: 'MEDIUM',
      regulatoryRisk: 'LOW',
      worstCase: 'Funding flips negative, lose 15% before exit',
      mitigation: 'Stop-loss at -5%, max 12-96h hold, exit on funding flip',
    },
    {
      name: 'BTC Funding Arb (long/short)',
      capital: 25000,
      apr: 43,
      riskLevel: 'LOW',
      maxDrawdown: 8,
      liquidationRisk: 'NONE (delta-neutral)',
      protocolRisk: 'HL only',
      smartContractRisk: 'LOW (HL is battle-tested)',
      regulatoryRisk: 'LOW',
      worstCase: 'Funding stays negative for 30+ days, lose 8%',
      mitigation: 'Exit if funding negative for 7+ days',
    },
    {
      name: 'kHYPE LST Carry (3x lev)',
      capital: 10000,
      apr: 5.1,
      riskLevel: 'MEDIUM',
      maxDrawdown: 30,
      liquidationRisk: 'HIGH if HYPE drops 33% (3x lev)',
      protocolRisk: 'Kinetiq + HyperLend',
      smartContractRisk: 'MEDIUM (LST + lending contracts)',
      regulatoryRisk: 'LOW',
      worstCase: 'HYPE drops 33% in a day, position liquidated',
      mitigation: 'Keep LTV < 60%, auto-deleverage on 20% drop',
    },
    {
      name: 'kHYPE AMM Discount Arb',
      capital: 5000,
      apr: 1042,
      riskLevel: 'MEDIUM',
      maxDrawdown: 10,
      liquidationRisk: 'NONE (flashloan, atomic)',
      protocolRisk: 'HyperSwap V3 + Kinetiq',
      smartContractRisk: 'MEDIUM (AMM + LST contracts)',
      regulatoryRisk: 'LOW',
      worstCase: 'Flashloan fails, lose gas fees only (~$5)',
      mitigation: 'Atomic execution, no inventory risk',
    },
    {
      name: 'Euler Lending Rate Spread',
      capital: 5000,
      apr: 15,
      riskLevel: 'LOW',
      maxDrawdown: 5,
      liquidationRisk: 'NONE (delta-neutral)',
      protocolRisk: 'Euler V2',
      smartContractRisk: 'LOW (Euler audited)',
      regulatoryRisk: 'LOW',
      worstCase: 'Borrow rate exceeds deposit rate, lose 5%',
      mitigation: 'Exit when spread < 1%',
    },
    {
      name: 'CexLikeDex Price Arb',
      capital: 5000,
      apr: 75,
      riskLevel: 'MEDIUM',
      maxDrawdown: 12,
      liquidationRisk: 'NONE',
      protocolRisk: 'CEX + HL',
      smartContractRisk: 'LOW (CEX is centralized)',
      regulatoryRisk: 'MEDIUM (CEX withdrawal delays)',
      worstCase: 'CEX delayed withdrawal, price moves, lose 12%',
      mitigation: 'Use CEX with fast withdrawals, limit position size',
    },
    {
      name: 'HLP Vault (idle USDC)',
      capital: 5000,
      apr: 100,
      riskLevel: 'MEDIUM',
      maxDrawdown: 20,
      liquidationRisk: 'NONE',
      protocolRisk: 'HL',
      smartContractRisk: 'LOW (HL core contract)',
      regulatoryRisk: 'LOW',
      worstCase: 'Traders win big, HLP loses 20% in a day',
      mitigation: 'Limit to 5% of total capital, monitor daily',
    },
  ];

  // 1. Risk summary table
  console.log('── Strategy Risk Profile ──\n');
  console.log('Strategy                          | Capital | APR    | Risk   | Max DD | Liquidation');
  console.log('──────────────────────────────────|─────────|────────|────────|────────|────────────');
  for (const s of strategies) {
    console.log(`${s.name.padEnd(34)}| $${s.capital.toLocaleString().padStart(7)} | ${s.apr.toFixed(0).padStart(5)}% | ${s.riskLevel.padEnd(6)} | ${s.maxDrawdown.toFixed(0).padStart(5)}% | ${s.liquidationRisk.substring(0, 12)}`);
  }

  // 2. Aggregate risk metrics
  console.log('\n── Aggregate Risk Metrics ──');
  const totalCapital = strategies.reduce((sum, s) => sum + s.capital, 0);
  const weightedApr = strategies.reduce((sum, s) => sum + s.apr * s.capital, 0) / totalCapital;
  const weightedDD = strategies.reduce((sum, s) => sum + s.maxDrawdown * s.capital, 0) / totalCapital;
  const totalAnnualProfit = strategies.reduce((sum, s) => sum + s.apr / 100 * s.capital, 0);
  const worstCaseLoss = strategies.reduce((sum, s) => sum + s.maxDrawdown / 100 * s.capital, 0);

  console.log(`  Total capital: $${totalCapital.toLocaleString()}`);
  console.log(`  Weighted APR: ${weightedApr.toFixed(1)}%`);
  console.log(`  Weighted max drawdown: ${weightedDD.toFixed(1)}%`);
  console.log(`  Total annual profit: $${totalAnnualProfit.toFixed(0)}`);
  console.log(`  Worst-case total loss (all strategies drawdown simultaneously): $${worstCaseLoss.toFixed(0)}`);
  console.log(`  Risk/reward ratio: 1:${(totalAnnualProfit / worstCaseLoss).toFixed(1)}`);

  // 3. Stress test scenarios
  console.log('\n── Stress Test Scenarios ──');
  const scenarios = [
    {
      name: 'Normal market',
      prob: 0.85,
      multiplier: 1.0,
      desc: 'Strategies perform as expected',
    },
    {
      name: 'High volatility (BTC ±20%)',
      prob: 0.10,
      multiplier: 0.7, // 30% lower profits
      desc: 'Spreads wider but funding volatile',
    },
    {
      name: 'Market crash (BTC -30% in day)',
      prob: 0.04,
      multiplier: -0.2, // 20% loss
      desc: 'kHYPE liquidation, HLP losses',
    },
    {
      name: 'Black swan (protocol exploit)',
      prob: 0.01,
      multiplier: -0.5, // 50% loss
      desc: 'Smart contract bug drains capital',
    },
  ];

  let expectedValue = 0;
  for (const s of scenarios) {
    const profit = totalAnnualProfit * s.multiplier;
    const weighted = profit * s.prob;
    expectedValue += weighted;
    console.log(`  ${s.name.padEnd(35)} prob=${(s.prob*100).toFixed(0).padStart(2)}%  profit=$${profit.toFixed(0).padStart(10)}  weighted=$${weighted.toFixed(0).padStart(10)}`);
    console.log(`    ${s.desc}`);
  }
  console.log(`\n  Expected value (probability-weighted): $${expectedValue.toFixed(0)}/yr`);
  console.log(`  Risk-adjusted APR: ${(expectedValue / totalCapital * 100).toFixed(1)}%`);

  // 4. Risk mitigation recommendations
  console.log('\n── Risk Mitigation Recommendations ──');
  console.log('  1. CAPITAL SEGREGATION');
  console.log('     - Separate wallets per strategy (limits blast radius)');
  console.log('     - Use hardware wallet for long-term holdings');
  console.log('     - Multi-sig for >$50k positions');
  console.log('');
  console.log('  2. POSITION LIMITS');
  console.log('     - Max $25k per strategy (25% of total)');
  console.log('     - Max $5k per individual trade');
  console.log('     - Max 3 concurrent positions per strategy');
  console.log('');
  console.log('  3. STOP-LOSSES');
  console.log('     - VOOI funding arb: exit if funding flips');
  console.log('     - kHYPE 3x: auto-deleverage on 20% HYPE drop');
  console.log('     - HLP: monitor daily, exit if 5% daily loss');
  console.log('');
  console.log('  4. MONITORING');
  console.log('     - Real-time alerts via Telegram (already built)');
  console.log('     - Daily P&L report (already built)');
  console.log('     - Weekly risk review');
  console.log('');
  console.log('  5. INSURANCE');
  console.log('     - Consider Nexus Mutual for smart contract coverage');
  console.log('     - Hold 10% of capital in reserve for opportunistic buys');

  console.log('\n=== Verdict ===');
  console.log(`Total capital: $${totalCapital.toLocaleString()}`);
  console.log(`Expected annual profit: $${totalAnnualProfit.toFixed(0)}`);
  console.log(`Worst-case loss: $${worstCaseLoss.toFixed(0)} (if all drawdowns hit same day)`);
  console.log(`Risk-adjusted expected value: $${expectedValue.toFixed(0)}/yr`);
  console.log(`Risk/reward: 1:${(totalAnnualProfit / worstCaseLoss).toFixed(1)}`);
  console.log('');
  console.log('RECOMMENDATION: Deploy capital gradually (25% per week)');
  console.log('  Week 1: VOOI price spread ($25k) — lowest risk, highest reward');
  console.log('  Week 2: BTC funding + kHYPE arb ($30k)');
  console.log('  Week 3: VOOI funding + Euler ($30k)');
  console.log('  Week 4: CexLikeDex + HLP ($10k)');
  console.log('  Track P&L daily, pause if cumulative loss > 10%');
}

main().catch(console.error);
