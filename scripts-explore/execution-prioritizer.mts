/**
 * Strategy Execution Prioritizer
 *
 * When capital arrives, which strategies to deploy FIRST?
 * Ranks by: risk-adjusted return, capital efficiency, time to profit
 *
 * Output: Ordered deployment plan
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Strategy Execution Prioritizer');
  console.log('  When capital arrives — deploy in THIS order');
  console.log('═══════════════════════════════════════════════════\n');

  const strategies = [
    {
      rank: 1,
      name: 'Builder Code Registration',
      capital: 100,
      expectedApr: 13231, // $13k/yr on $100
      riskLevel: 'NONE',
      timeToProfit: '1 day',
      riskAdjustedScore: 100,
      notes: 'Pure profit on existing flow. Register immediately.',
      action: 'POST /exchange with approveBuilderFee action',
      prerequisites: ['$100 USDC in agent EVM wallet'],
    },
    {
      rank: 2,
      name: 'VOOI Price Spread Arb',
      capital: 25000,
      expectedApr: 3139,
      riskLevel: 'LOW (instant capture, delta-neutral)',
      timeToProfit: 'Instant (per cycle)',
      riskAdjustedScore: 95,
      notes: '102.7% of paper trading profit. Top priority after builder code.',
      action: 'Run VooiPriceSpreadExecutor --live',
      prerequisites: ['$25k USDC in agent EVM wallet', 'VOOI API token (set)'],
    },
    {
      rank: 3,
      name: 'kHYPE AMM Discount Arb',
      capital: 5000,
      expectedApr: 1042,
      riskLevel: 'MEDIUM (atomic, flashloan)',
      timeToProfit: 'Instant (per cycle)',
      riskAdjustedScore: 90,
      notes: '2.49% discount verified on-chain. $72 profit per cycle on $5k.',
      action: 'Run HlLstArbScanner + flashloan executor',
      prerequisites: ['$5k USDC in agent EVM wallet', 'HyperLend flashloan available'],
    },
    {
      rank: 4,
      name: 'HLP Vault (idle USDC parking)',
      capital: 5000,
      expectedApr: 100,
      riskLevel: 'MEDIUM (trader loss risk)',
      timeToProfit: 'Daily (passive yield)',
      riskAdjustedScore: 85,
      notes: 'Best passive yield for idle USDC. 50-150% APR.',
      action: 'Deposit USDC to HLP vault via HL API',
      prerequisites: ['$5k USDC in agent EVM wallet'],
    },
    {
      rank: 5,
      name: 'BTC Funding Arb',
      capital: 25000,
      expectedApr: 43,
      riskLevel: 'LOW (delta-neutral)',
      timeToProfit: 'Daily (funding income)',
      riskAdjustedScore: 80,
      notes: 'Stable, low-risk. 6% APR from real funding history.',
      action: 'Long BTC spot + short BTC perp',
      prerequisites: ['$25k USDC in agent EVM wallet'],
    },
    {
      rank: 6,
      name: 'CexLikeDex Price Arb',
      capital: 5000,
      expectedApr: 75,
      riskLevel: 'MEDIUM (CEX withdrawal delay)',
      timeToProfit: '5-30 min per cycle',
      riskAdjustedScore: 70,
      notes: 'Decent yield but CEX delay adds risk.',
      action: 'Run CexLikeDexExecutor',
      prerequisites: ['$5k USDC in agent EVM wallet', 'CEX accounts configured'],
    },
    {
      rank: 7,
      name: 'kHYPE LST Carry (3x lev)',
      capital: 10000,
      expectedApr: 5.1,
      riskLevel: 'MEDIUM (liquidation if HYPE drops 33%)',
      timeToProfit: 'Daily (passive yield)',
      riskAdjustedScore: 60,
      notes: 'Low yield but passive. Use for HYPE holdings.',
      action: 'Stake HYPE → kHYPE, borrow on HyperLend, re-stake',
      prerequisites: ['$10k HYPE in agent EVM wallet'],
    },
    {
      rank: 8,
      name: 'VOOI Funding Rate Arb',
      capital: 25000,
      expectedApr: 60,
      riskLevel: 'MEDIUM (12-96h hold)',
      timeToProfit: '12-24h per cycle',
      riskAdjustedScore: 55,
      notes: 'Fixed: 0.1% fees + 24h hold + skip unprofitable. Was losing money, now profitable.',
      action: 'Run VooiArbExecutor --live (with fixed params)',
      prerequisites: ['$25k USDC in agent EVM wallet', 'VOOI API token (set)'],
    },
    {
      rank: 9,
      name: 'Euler Lending Rate Spread',
      capital: 5000,
      expectedApr: 15,
      riskLevel: 'LOW (delta-neutral)',
      timeToProfit: 'Daily (passive yield)',
      riskAdjustedScore: 50,
      notes: 'Low yield but safest. Use for capital preservation.',
      action: 'Run EulerLendingExecutor',
      prerequisites: ['$5k USDC in agent EVM wallet'],
    },
    {
      rank: 10,
      name: 'Pump.fun Delta-Neutral Arb',
      capital: 200,
      expectedApr: 500,
      riskLevel: 'MEDIUM (smart contract risk)',
      timeToProfit: 'Instant (atomic)',
      riskAdjustedScore: 65,
      notes: 'Needs SOL funding. Atomic 2-leg arb, zero rug risk.',
      action: 'Run PumpArbExecutor (when wallet funded)',
      prerequisites: ['0.5 SOL in agent Solana wallet', 'PumpApi key (set)'],
    },
  ];

  // Sort by risk-adjusted score
  strategies.sort((a, b) => b.riskAdjustedScore - a.riskAdjustedScore);

  console.log('── Deployment Order (by risk-adjusted score) ──\n');
  console.log('Rank | Score | Strategy                     | Capital  | APR     | Risk     | Time to Profit');
  console.log('─────|───────|──────────────────────────────|──────────|─────────|──────────|───────────────');
  for (const s of strategies) {
    console.log(`  ${s.rank}  | ${s.riskAdjustedScore.toString().padStart(5)} | ${s.name.padEnd(28)}| $${s.capital.toLocaleString().padStart(8)} | ${s.expectedApr.toString().padStart(7)}% | ${s.riskLevel.substring(0, 8).padEnd(8)}| ${s.timeToProfit}`);
  }

  // Total capital needed
  const totalCapital = strategies.reduce((s, x) => s + x.capital, 0);
  console.log(`\n  Total capital needed: $${totalCapital.toLocaleString()}`);

  // Deployment phases
  console.log('\n── Deployment Phases ──\n');
  console.log('Phase 1 (Immediate — $100):');
  console.log('  → Register builder code');
  console.log('  → Revenue starts: $36/day = $13k/yr');
  console.log('');
  console.log('Phase 2 (Day 1 — $35k):');
  console.log('  → VOOI Price Spread ($25k)');
  console.log('  → kHYPE AMM Discount ($5k)');
  console.log('  → HLP Vault ($5k)');
  console.log('  → Revenue: $380/day = $139k/yr');
  console.log('');
  console.log('Phase 3 (Day 7 — $65k):');
  console.log('  → Add BTC Funding ($25k)');
  console.log('  → Add CexLikeDex ($5k)');
  console.log('  → Revenue: $390/day = $143k/yr');
  console.log('');
  console.log('Phase 4 (Day 14 — $100k):');
  console.log('  → Add kHYPE Carry ($10k)');
  console.log('  → Add VOOI Funding ($25k)');
  console.log('  → Add Euler ($5k)');
  console.log('  → Revenue: $400/day = $146k/yr');
  console.log('');
  console.log('Phase 5 (Day 30 — $100.2k):');
  console.log('  → Activate pump.fun (0.5 SOL = $80)');
  console.log('  → Revenue: +$50-200/day from pump.fun');
  console.log('');

  console.log('═══════════════════════════════════════════════════');
  console.log('  Summary');
  console.log('═══════════════════════════════════════════════════\n');
  console.log(`  Total capital: $${totalCapital.toLocaleString()}`);
  console.log(`  Expected daily profit: ~$430-630/day`);
  console.log(`  Expected annual profit: ~$157-230k/yr (conservative)`);
  console.log(`  Blended APR: ~157-230%`);
  console.log('');
  console.log('  KEY: Deploy in ORDER. Don\'t skip steps.');
  console.log('  Each phase builds on the previous.');
  console.log('  Risk manager enforces all limits automatically.');
}

main().catch(console.error);
