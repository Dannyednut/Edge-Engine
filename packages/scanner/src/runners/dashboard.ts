/**
 * Opportunities Dashboard — single command to see all current arbs ranked.
 *
 * Usage: tsx packages/scanner/src/runners/dashboard.ts
 *
 * Shows:
 *   - kHYPE LST carry arb (live discount + profit estimate)
 *   - Euler HL lending arbs (cross-vault rate spreads)
 *   - LST yield comparison (best yield vs kHYPE baseline)
 *   - PT yield arb (cross-LST PT implied yields)
 *   - Kinetiq staking status (min stake, withdrawal delay, total staked)
 *
 * Ranked by estimated annual $ profit on $5k capital.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { HlLstArbScanner } from '../strategies/hl-lst-arb-scanner.js';
import { LstYieldComparisonScanner } from '../strategies/lst-yield-comparison.js';
import { PtYieldArbScanner } from '../strategies/pt-yield-arb-scanner.js';
import { EulerLendingArbScanner } from '../strategies/euler-lending-arb-scanner.js';
import { KinetiqClient } from '@edge/executor';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..', '..');

// Load .env
try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch { /* .env not present */ }

interface Opportunity {
  strategy: string;
  asset: string;
  spreadPct: number;
  annualizedReturnPct: number;
  estimatedProfitUsd: number;  // per YEAR on $5k capital
  capitalRequired: number;
  details: string[];
  ts: number;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Edge-Engine Opportunities Dashboard');
  console.log(`  ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Capital assumption: $5,000 per strategy');
  console.log('');

  const opportunities: Opportunity[] = [];

  // 1. kHYPE LST carry arb
  console.log('Scanning kHYPE LST carry arb...');
  try {
    const hlLstArb = new HlLstArbScanner({
      minDiscountPct: 0.1,
      maxSizeUsd: 5_000,
      preferredFeeTier: 100,
    });
    const alerts = await hlLstArb.scan();
    for (const a of alerts) {
      // Carry arb: profit per 8-day cycle × 365/8 = annualized
      const profitPerCycle = a.estimatedProfitUsd;
      const annualProfit = profitPerCycle * (365 / 8);  // 8-day cycles
      const annualizedReturnPct = (annualProfit / 5_000) * 100;
      opportunities.push({
        strategy: 'kHYPE LST carry arb',
        asset: 'kHYPE/WHYPE',
        spreadPct: a.discountPct,
        annualizedReturnPct,
        estimatedProfitUsd: annualProfit,
        capitalRequired: 5_000,
        details: [
          `Discount: ${a.discountPct.toFixed(2)}% on HyperSwap V3 (fee=${a.feeTier})`,
          `Net profit per 8-day cycle: $${profitPerCycle.toFixed(2)}`,
          `Annualized: $${annualProfit.toFixed(0)} (${annualizedReturnPct.toFixed(1)}% APR)`,
          `Pool liquidity: ${a.poolLiquidity.toString()}`,
          `Execution: buy kHYPE → queue 7-day Kinetiq withdrawal → claim HYPE`,
        ],
        ts: a.ts,
      });
    }
  } catch (e: any) {
    console.log(`  ⚠ kHYPE scan failed: ${e.message}`);
  }

  // 2. Euler HL lending arb
  console.log('Scanning Euler HL lending arbs...');
  try {
    const eulerArb = new EulerLendingArbScanner({
      minSpreadPct: 0.5,
      minLiquidityUsd: 10_000,
      maxSizeUsd: 5_000,
    });
    const alerts = await eulerArb.scan();
    for (const a of alerts) {
      opportunities.push({
        strategy: 'Euler HL lending arb',
        asset: a.assetSymbol,
        spreadPct: a.spreadPct,
        annualizedReturnPct: a.spreadPct * 0.8, // ~80% collateral factor
        estimatedProfitUsd: a.estimatedProfitUsd,
        capitalRequired: 5_000,
        details: [
          `Deposit: ${a.depositVault.name} @ ${a.depositVault.apyPct.toFixed(2)}% APR`,
          `Borrow:  ${a.borrowVault.name} @ ${a.borrowVault.apyPct.toFixed(2)}% APR`,
          `Spread:  ${a.spreadPct.toFixed(2)}%  Collateral factor: ${a.collateralFactorPct}%`,
          `Combined liquidity: $${(a.totalLiquidityUsd / 1000).toFixed(0)}k`,
          `Est. profit: $${a.estimatedProfitUsd.toFixed(0)}/yr on $5k collateral`,
        ],
        ts: a.ts,
      });
    }
  } catch (e: any) {
    console.log(`  ⚠ Euler scan failed: ${e.message}`);
  }

  // 3. LST yield comparison (best yield vs kHYPE)
  console.log('Scanning LST yield comparison...');
  try {
    const lstYield = new LstYieldComparisonScanner({
      minYieldSpreadPct: 0.5,
      minTvlUsd: 500_000,
    });
    const alerts = await lstYield.scan();
    for (const a of alerts.slice(0, 5)) {
      const annualProfit = (a.vsKhypeSpread / 100) * 5_000;
      opportunities.push({
        strategy: 'LST yield switch',
        asset: a.lst,
        spreadPct: a.vsKhypeSpread,
        annualizedReturnPct: a.vsKhypeSpread,
        estimatedProfitUsd: annualProfit,
        capitalRequired: 5_000,
        details: [
          `LST: ${a.lst}  Expiry: ${a.expiry}`,
          `Best APY: ${a.bestApy.toFixed(2)}%  vs kHYPE: ${a.vsKhypeSpread.toFixed(2)}% spread`,
          `TVL: $${(a.tvlUsd / 1e6).toFixed(2)}M`,
          `Action: ${a.vsKhypeSpread > 0 ? 'switch kHYPE → ' + a.lst : 'hold kHYPE'}`,
        ],
        ts: a.ts,
      });
    }
  } catch (e: any) {
    console.log(`  ⚠ LST yield scan failed: ${e.message}`);
  }

  // 4. PT yield arb (cross-LST)
  console.log('Scanning PT yield arb...');
  try {
    const ptYield = new PtYieldArbScanner({
      minYieldSpreadPct: 1.0,
      minTvlUsd: 500_000,
      maxImpliedApyPct: 50,
      khypeFloatingYieldApr: 2.37,
    });
    const alerts = await ptYield.scan();
    for (const a of alerts) {
      opportunities.push({
        strategy: 'PT yield arb',
        asset: a.lst,
        spreadPct: a.vsKhypeSpreadPct,
        annualizedReturnPct: a.annualizedReturnPct,
        estimatedProfitUsd: a.estimatedProfitUsd * (365 / a.daysToMaturity), // annualize
        capitalRequired: 5_000,
        details: [
          `PT: ${a.lst}  Maturity: ${a.expiry} (${a.daysToMaturity.toFixed(0)}d)`,
          `Implied: ${a.impliedApyPct.toFixed(2)}%  Underlying: ${a.underlyingApyPct.toFixed(2)}%`,
          `vs kHYPE: ${a.vsKhypeSpreadPct.toFixed(2)}%  Annualized: ${a.annualizedReturnPct.toFixed(2)}%`,
          `TVL: $${(a.tvlUsd / 1e6).toFixed(2)}M`,
        ],
        ts: a.ts,
      });
    }
  } catch (e: any) {
    console.log(`  ⚠ PT yield scan failed: ${e.message}`);
  }

  // Sort by estimated annual profit (highest first)
  opportunities.sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd);

  // Print results
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TOP OPPORTUNITIES (ranked by annual $ profit on $5k)');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  if (opportunities.length === 0) {
    console.log('  No actionable opportunities found.');
    console.log('  Try again later — markets fluctuate.');
    return;
  }

  for (let i = 0; i < Math.min(10, opportunities.length); i++) {
    const o = opportunities[i];
    console.log(`  #${i + 1}  ${o.strategy} — ${o.asset}`);
    console.log(`      Spread: ${o.spreadPct.toFixed(2)}%  |  APR: ${o.annualizedReturnPct.toFixed(2)}%  |  Est. profit: $${o.estimatedProfitUsd.toFixed(0)}/yr on $${o.capitalRequired.toLocaleString()}`);
    for (const d of o.details) {
      console.log(`      ${d}`);
    }
    console.log('');
  }

  // Summary
  const totalProfit = opportunities.slice(0, 5).reduce((sum, o) => sum + o.estimatedProfitUsd, 0);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Top 5 opportunities total: $${totalProfit.toFixed(0)}/yr on $25k capital`);
  console.log(`  Combined APR: ${((totalProfit / 25_000) * 100).toFixed(1)}%`);
  console.log('═══════════════════════════════════════════════════════════════');

  // Kinetiq status footer
  console.log('');
  console.log('── Kinetiq Staking Status ──');
  try {
    const kinetiq = new KinetiqClient();
    const status = await kinetiq.getStatus();
    console.log(`  Min stake: ${status.minStakeAmountHype} HYPE  |  Max stake: ${status.maxStakeAmountHype} HYPE`);
    console.log(`  Withdrawal delay: ${status.withdrawalDelayDays.toFixed(1)} days  |  Unstake fee: ${status.unstakeFeeRatePct}%`);
    console.log(`  Total staked: ${status.totalStakedHype.toLocaleString()} HYPE  |  Queued withdrawals: ${status.totalQueuedWithdrawals.toLocaleString()} HYPE`);
    console.log(`  Whitelist: ${status.whitelistEnabled ? 'ENABLED' : 'OPEN (anyone can stake)'}`);
  } catch (e: any) {
    console.log(`  ⚠ Kinetiq status failed: ${e.message}`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
