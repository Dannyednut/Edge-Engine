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
    // EM-STRAT-016-WO-01-R1: kHYPE strategies are SUPPRESSED (unstake-fee
    // evidence unavailable; the previous 0.10% 'verified' claim is
    // withdrawn). This entry is retained as an explicit NOT-DEPLOYABLE
    // marker only: it must not be ranked as a deployment priority, must
    // not recommend running the scanner/executor, and carries no
    // expected-APR or profit claim. Renumbered entries below keep their
    // original relative order.
    {
      rank: 0,
      name: 'kHYPE AMM Discount Arb — SUPPRESSED',
      capital: 0,
      expectedApr: null,
      riskLevel: 'N/A — suppressed',
      timeToProfit: 'N/A',
      riskAdjustedScore: 0,
      notes: 'SUPPRESSED (EM-STRAT-016-WO-01): unstake-fee evidence unavailable; not deployable. Figures removed — no expected-APR or profit claim is made while economics are unverified.',
      action: 'NONE — do not deploy; a separate evidence-backed work order is required before reconsideration',
      prerequisites: ['Unstake-fee evidence (separate authorized research task)'],
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
    // EM-STRAT-016-WO-01-R1: same suppression as above — retained as a
    // NOT-DEPLOYABLE marker, no execution recommendation, no figures.
    {
      rank: 0,
      name: 'kHYPE LST Carry (3x lev) — SUPPRESSED',
      capital: 0,
      expectedApr: null,
      riskLevel: 'N/A — suppressed',
      timeToProfit: 'N/A',
      riskAdjustedScore: 0,
      notes: 'SUPPRESSED (EM-STRAT-016-WO-01): unstake-fee evidence unavailable; not deployable.',
      action: 'NONE — do not deploy; a separate evidence-backed work order is required before reconsideration',
      prerequisites: ['Unstake-fee evidence (separate authorized research task)'],
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
    const aprCell = s.expectedApr === null ? '     N/A' : s.expectedApr.toString().padStart(7) + '%';
    console.log(`  ${s.rank}  | ${s.riskAdjustedScore.toString().padStart(5)} | ${s.name.padEnd(28)}| $${s.capital.toLocaleString().padStart(8)} | ${aprCell} | ${s.riskLevel.substring(0, 8).padEnd(8)}| ${s.timeToProfit}`);
  }

  // Total capital needed (suppressed entries contribute $0 and are excluded)
  const totalCapital = strategies.reduce((s, x) => s + x.capital, 0);
  console.log(`\n  Total capital needed (suppressed entries excluded): $${totalCapital.toLocaleString()}`);

  // Deployment phases
  console.log('\n── Deployment Phases ──\n');
  console.log('Phase 1 (Immediate — $100):');
  console.log('  → Register builder code');
  console.log('  → Revenue starts: $36/day = $13k/yr');
  console.log('');
  console.log('Phase 2 (Day 1 — $30k):');
  console.log('  → VOOI Price Spread ($25k)');
  console.log('  → HLP Vault ($5k)');
  console.log('  → (kHYPE AMM Discount SUPPRESSED — not deployed, EM-STRAT-016-WO-01)');
  console.log('  → Revenue: recalculated after suppression; prior $380/day figure included suppressed kHYPE');
  console.log('');
  console.log('Phase 3 (Day 7 — $65k):');
  console.log('  → Add BTC Funding ($25k)');
  console.log('  → Add CexLikeDex ($5k)');
  console.log('  → Revenue: $390/day = $143k/yr');
  console.log('');
  console.log('Phase 4 (Day 14 — $30k additional):');
  console.log('  → Add VOOI Funding ($25k)');
  console.log('  → Add Euler ($5k)');
  console.log('  → (kHYPE Carry SUPPRESSED — not deployed, EM-STRAT-016-WO-01)');
  console.log('  → Revenue: recalculated after suppression; prior $400/day figure included suppressed kHYPE');
  console.log('');
  console.log('Phase 5 (Day 30 — $100.2k):');
  console.log('  → Activate pump.fun (0.5 SOL = $80)');
  console.log('  → Revenue: +$50-200/day from pump.fun');
  console.log('');

  console.log('═══════════════════════════════════════════════════');
  console.log('  Summary');
  console.log('═══════════════════════════════════════════════════\n');
  console.log(`  Deployable total capital (suppressed entries excluded): $${totalCapital.toLocaleString()}`);
  // EM-STRAT-016-WO-01-R1: the prior ~$430-630/day / ~$157-230k/yr summary
  // figures included suppressed kHYPE entries and are withdrawn; no
  // replacement estimate is offered while that strategy's economics are
  // unverified.
  console.log('  Expected daily/annual profit: prior aggregate figures WITHDRAWN (they included suppressed kHYPE entries); no replacement estimate while economics are unverified');
  console.log('');
  console.log('  KEY: Deploy in ORDER. Don\'t skip steps.');
  console.log('  Each phase builds on the previous.');
  console.log('  Risk manager enforces all limits automatically.');
}

main().catch(console.error);
