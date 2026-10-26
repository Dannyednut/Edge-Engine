/**
 * Hyperliquid Builder Fee Rebate Tracker
 *
 * Hyperliquid has a "builder" program:
 *   - Register a builder code (free, no capital required)
 *   - When users trade using your builder code, you earn 10% of their fees
 *   - Top builders earn $10k-$50k+/month in passive income
 *
 * This scanner:
 *   1. Calculates potential builder fee income based on referral volume
 *   2. Tracks HL daily volume (total fee pool)
 *   3. Estimates builder fee share at different referral levels
 *   4. Provides strategy for maximizing builder code adoption
 *
 * Strategy for maximizing builder fee income:
 *   - Build tools that traders want to use (free -> they use your builder code)
 *   - Create analytics dashboards
 *   - Offer copy trading
 *   - Create Telegram bots with trading signals
 *   - Publish research/analysis
 *   - Each tool embeds your builder code
 *
 * ZERO CAPITAL REQUIRED - pure referral income
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

const HL_API = 'https://api.hyperliquid.xyz/info';

async function hlPost(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

async function main() {
  console.log('===================================================');
  console.log('  Hyperliquid Builder Fee Rebate Tracker');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('  ZERO CAPITAL REQUIRED - pure referral income');
  console.log('  ZERO CAPITAL REQUIRED - pure referral income');
  console.log('===================================================');
  // Get HL total volume and fees
  const r = await hlPost({ type: 'metaAndAssetCtxs' });
  const universe = r?.[0]?.universe || [];
  const ctxs = r?.[1] || [];

  let totalVolume24h = 0;
  let totalOi = 0;
  let marketCount = 0;

  for (let i = 0; i < universe.length; i++) {
    const u = universe[i];
    const ctx = ctxs[i];
    if (!u || !ctx || u.name.startsWith('@')) continue;
    marketCount++;
    const volume24h = parseFloat(ctx.dayNtlVlm) || 0;
    const oi = parseFloat(ctx.openInterest) * parseFloat(ctx.markPx);
    totalVolume24h += volume24h;
    totalOi += oi;
  }

  // HL fee structure:
  // Taker fee: 0.045% (4.5 bps)
  // Maker fee: -0.001% (-0.1 bps, i.e., rebate)
  // Builder gets: 10% of taker fees from referred users
  const takerFeeRate = 0.045 / 100;  // 0.045%
  const dailyTakerFees = totalVolume24h * takerFeeRate * 0.5;  // assume 50% of volume is taker
  const builderShareRate = 0.10;  // 10% of taker fees
  const totalDailyBuilderPool = dailyTakerFees * builderShareRate;

  console.log('- HYPERLIQUID MARKET STATS -\n');
  console.log(`  Total markets: ${marketCount}`);
  console.log(`  Total 24h volume: ${fmtUsd(totalVolume24h)}`);
  console.log(`  Total open interest: ${fmtUsd(totalOi)}`);
  console.log(`  Estimated daily taker fees: ${fmtUsd(dailyTakerFees)}`);
  console.log(`  Total daily builder fee pool: ${fmtUsd(totalDailyBuilderPool)}`);
  console.log(`  Total monthly builder fee pool: ${fmtUsd(totalDailyBuilderPool * 30)}`);
  console.log(`  Total annual builder fee pool: ${fmtUsd(totalDailyBuilderPool * 365)}`);

  // Builder fee scenarios
  console.log('\n- BUILDER FEE INCOME SCENARIOS -\n');
  console.log('  Scenario         | Referred Volume/day | Your Share | Daily Income | Monthly    | Annual     ');
  console.log('  --------─|----------─|------|-------|------|------');

  const scenarios = [
    { name: 'Starter',     referredVolume: 100_000 },      // $100k/day
    { name: 'Growing',     referredVolume: 500_000 },      // $500k/day
    { name: 'Established', referredVolume: 1_000_000 },    // $1M/day
    { name: 'Top 50',      referredVolume: 5_000_000 },    // $5M/day
    { name: 'Top 10',      referredVolume: 20_000_000 },   // $20M/day
    { name: 'Top 3',       referredVolume: 50_000_000 },   // $50M/day
  ];

  for (const s of scenarios) {
    const dailyTakerFeesFromReferrals = s.referredVolume * takerFeeRate * 0.5;  // 50% taker
    const yourShare = dailyTakerFeesFromReferrals * builderShareRate;
    console.log(
      `  ${s.name.padEnd(16)} | ${fmtUsd(s.referredVolume).padStart(19)} | ${'10%'.padEnd(10)} | ` +
      `${fmtUsd(yourShare).padStart(12)}/d | ${fmtUsd(yourShare * 30).padStart(10)}/mo | ${fmtUsd(yourShare * 365).padStart(10)}/yr`
    );
  }

  // Strategy for maximizing builder code adoption
  console.log('\n- STRATEGY FOR MAXIMIZING BUILDER CODE ADOPTION -');
  console.log('');
  console.log('  1. Build FREE tools that traders want to use:');
  console.log('     - Real-time opportunity scanner (ALREADY BUILT OK)');
  console.log('     - Telegram alert bot (ALREADY BUILT OK)');
  console.log('     - Paper trader (ALREADY BUILT OK)');
  console.log('     - Position sizing calculator (ALREADY BUILT OK)');
  console.log('     - Risk dashboard (ALREADY BUILT OK)');
  console.log('');
  console.log('  2. Each tool embeds your builder code:');
  console.log('     - When users trade via your tool -> you earn 10% of fees');
  console.log('     - Users do not pay extra (fees are same with or without builder code)');
  console.log('');
  console.log('  3. Marketing channels:');
  console.log('     - Twitter/X: share daily opportunity alerts');
  console.log('     - Telegram group: real-time signals');
  console.log('     - Discord: community + support');
  console.log('     - YouTube: tutorial videos');
  console.log('     - Medium/Substack: analysis articles');
  console.log('');
  console.log('  4. Target users:');
  console.log('     - Retail traders (high volume, many trades)');
  console.log('     - Trading bots (automated, high frequency)');
  console.log('     - Copy traders (follow signals, execute trades)');
  console.log('     - Whale watchers (trade based on whale activity)');
  console.log('');
  console.log('  5. Revenue compounding:');
  console.log('     - Reinvest builder fee income into yield strategies');
  console.log('     - Use yield to build more tools -> more users -> more fees');
  console.log('     - Network effect: more users = more data = better tools');

  // What we already have
  console.log('\n- TOOLS WE ALREADY HAVE (ready for builder code) -');
  const tools = [
    { name: 'Real-time spread monitor', users: 'Traders looking for instant arb' },
    { name: 'HL funding alert bot', users: 'Funding harvest traders' },
    { name: 'Paper trader', users: 'New traders learning HL' },
    { name: 'Risk dashboard', users: 'Active traders managing risk' },
    { name: 'Position sizing calculator', users: 'Serious traders' },
    { name: 'Daily report generator', users: 'Investors monitoring performance' },
    { name: 'Order book imbalance scanner', users: 'Scalpers' },
    { name: 'Whale tracker', users: 'Whale followers' },
    { name: 'Liquidation hunter', users: 'Liquidation backrunners' },
    { name: 'Quick opps master summary', users: 'All active traders' },
  ];
  for (const t of tools) {
    console.log(`  OK ${t.name.padEnd(35)} -> ${t.users}`);
  }

  // Investor summary
  console.log('\n- INVESTOR SUMMARY -');
  console.log(`  HL daily volume: ${fmtUsd(totalVolume24h)}`);
  console.log(`  Total daily builder fee pool: ${fmtUsd(totalDailyBuilderPool)}`);
  console.log(`  Capital required: $0 (pure referral income)`);
  console.log(`  Risk: 1/10 (lowest - no capital, no execution)`);
  console.log(`  `);
  console.log(`  Realistic 6-month target (Established):`);
  console.log(`    - Referred volume: $1M/day`);
  console.log(`    - Daily income: ${fmtUsd(scenarios[2].referredVolume * takerFeeRate * 0.5 * builderShareRate)}`);
  console.log(`    - Monthly income: ${fmtUsd(scenarios[2].referredVolume * takerFeeRate * 0.5 * builderShareRate * 30)}`);
  console.log(`    - Annual income: ${fmtUsd(scenarios[2].referredVolume * takerFeeRate * 0.5 * builderShareRate * 365)}`);
  console.log(`  `);
  console.log(`  Realistic 12-month target (Top 50):`);
  console.log(`    - Referred volume: $5M/day`);
  console.log(`    - Daily income: ${fmtUsd(scenarios[3].referredVolume * takerFeeRate * 0.5 * builderShareRate)}`);
  console.log(`    - Monthly income: ${fmtUsd(scenarios[3].referredVolume * takerFeeRate * 0.5 * builderShareRate * 30)}`);
  console.log(`    - Annual income: ${fmtUsd(scenarios[3].referredVolume * takerFeeRate * 0.5 * builderShareRate * 365)}`);
}

main().catch(err => { console.error(err); process.exit(1); });
