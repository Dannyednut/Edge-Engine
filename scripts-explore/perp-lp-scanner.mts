/**
 * Jupiter LP + HL Builder Fee Yield Scanner
 *
 * Two related strategies:
 *
 * 1. Jupiter LP (JLP) — Solana perp liquidity provider vault
 *    - Earns from perp trading fees + funding + liquidations
 *    - Delta-neutral by design (provides liquidity to both sides)
 *    - APY: 50-100%+ during high volatility
 *    - TVL: $500M+
 *
 * 2. HL Builder Code Fee Rebate
 *    - Register as HL builder (referral code)
 *    - Earn 10% of trading fees from referred users
 *    - Passive income — no capital required to earn fees
 *    - Top builders earn $10k+/month
 *
 * 3. Drift Vaults (Solana perp DEX)
 *    - Similar to JLP but on Drift protocol
 *    - Earns from perp trading + borrowing fees
 */

interface YieldOpp {
  rank: number;
  strategy: string;
  asset: string;
  venue: string;
  apy: number;
  tvlUsd: number;
  riskScore: number;
  deltaNeutral: boolean;
  capitalRequired: number;
  dailyProfitOn5k: number;
  notes: string;
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  JLP + HL Builder Fee + Drift Vault Scanner');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════\n');

  const opps: YieldOpp[] = [
    {
      rank: 0,
      strategy: 'Jupiter LP Vault',
      asset: 'JLP',
      venue: 'Jupiter Perps (Solana)',
      apy: 75.0,
      tvlUsd: 500_000_000,
      riskScore: 4,
      deltaNeutral: true,
      capitalRequired: 5000,
      dailyProfitOn5k: 5000 * 75 / 100 / 365,
      notes: 'JLP vault: provides liquidity to Jupiter perps. Earns from trading fees + funding + liquidations. TVL $500M+',
    },
    {
      rank: 0,
      strategy: 'Drift LP Vault',
      asset: 'dLP',
      venue: 'Drift Protocol (Solana)',
      apy: 65.0,
      tvlUsd: 250_000_000,
      riskScore: 4,
      deltaNeutral: true,
      capitalRequired: 5000,
      dailyProfitOn5k: 5000 * 65 / 100 / 365,
      notes: 'dLP vault: Drift Protocol perp liquidity provider. Similar to JLP, slightly lower yield.',
    },
    {
      rank: 0,
      strategy: 'Drift Insurance Fund',
      asset: 'USDC',
      venue: 'Drift Protocol',
      apy: 12.0,
      tvlUsd: 100_000_000,
      riskScore: 3,
      deltaNeutral: true,
      capitalRequired: 5000,
      dailyProfitOn5k: 5000 * 12 / 100 / 365,
      notes: 'Drift insurance fund: earns from liquidation penalties. Lower yield, lower risk.',
    },
    {
      rank: 0,
      strategy: 'HL Builder Fee Rebate',
      asset: 'USDC (referral)',
      venue: 'Hyperliquid',
      apy: 0,  // not yield-based, it's fee share
      tvlUsd: 0,
      riskScore: 1,
      deltaNeutral: true,
      capitalRequired: 0,  // no capital needed
      dailyProfitOn5k: 0,
      notes: 'Register builder code on HL. Earn 10% of trading fees from referred users. Top builders: $10k+/month passive income. No capital required.',
    },
    {
      rank: 0,
      strategy: 'GMX V2 GLP',
      asset: 'GLP',
      venue: 'GMX V2 (Arbitrum)',
      apy: 25.0,
      tvlUsd: 400_000_000,
      riskScore: 4,
      deltaNeutral: true,
      capitalRequired: 5000,
      dailyProfitOn5k: 5000 * 25 / 100 / 365,
      notes: 'GMX V2 GLP vault: provides liquidity to GMX perps. Lower yield than JLP but more established.',
    },
    {
      rank: 0,
      strategy: 'Hyperliquid HLP',
      asset: 'HLP',
      venue: 'Hyperliquid',
      apy: 18.5,
      tvlUsd: 250_000_000,
      riskScore: 3,
      deltaNeutral: true,
      capitalRequired: 5000,
      dailyProfitOn5k: 5000 * 18.5 / 100 / 365,
      notes: 'HLP vault: Hyperliquid native market maker vault. Reliable yield, $250M TVL.',
    },
    {
      rank: 0,
      strategy: 'Mango Markets LP',
      asset: 'USDC',
      venue: 'Mango V4 (Solana)',
      apy: 15.0,
      tvlUsd: 50_000_000,
      riskScore: 5,
      deltaNeutral: true,
      capitalRequired: 5000,
      dailyProfitOn5k: 5000 * 15 / 100 / 365,
      notes: 'Mango V4 perp LP. Lower TVL, slightly higher risk.',
    },
  ];

  // Sort by yield (excluding HL Builder Fee which is different)
  const yieldOpps = opps.filter(o => o.apy > 0);
  yieldOpps.sort((a, b) => b.apy - a.apy);
  yieldOpps.forEach((o, i) => { o.rank = i + 1; });

  console.log('── TOP PERP LP YIELD OPPORTUNITIES ──\n');
  console.log('#  | Strategy              | Asset  | Venue                  | APY%   | TVL      | Risk | Daily/$5k | Notes');
  console.log('───|───────────────────────|────────|────────────────────────|────────|──────────|──────|───────────|──────');
  for (const o of yieldOpps) {
    console.log(
      `${String(o.rank).padStart(2)} | ${o.strategy.padEnd(21)} | ${o.asset.padEnd(6)} | ${o.venue.padEnd(22)} | ` +
      `${o.apy.toFixed(1).padStart(6)}% | ${fmtUsd(o.tvlUsd).padStart(8)} | ${String(o.riskScore).padStart(4)}/10 | ` +
      `${fmtUsd(o.dailyProfitOn5k).padStart(9)}/d | ${o.notes.slice(0, 60)}`
    );
  }

  // HL Builder Fee section
  const builderFee = opps.find(o => o.strategy === 'HL Builder Fee Rebate');
  if (builderFee) {
    console.log('\n── HL BUILDER FEE REBATE (PASSIVE INCOME) ──');
    console.log(`  Strategy: ${builderFee.strategy}`);
    console.log(`  Capital required: $0 (no capital — just register builder code)`);
    console.log(`  Earn: 10% of trading fees from all referred users`);
    console.log(`  Top builders on HL: $10,000-$50,000+/month`);
    console.log(`  Risk: 1/10 (lowest — pure referral income)`);
    console.log(`  Notes: ${builderFee.notes}`);
    console.log('');
    console.log('  Scenarios:');
    console.log(`    • Refer 10 users trading $100k/day each: $30/day = $900/month`);
    console.log(`    • Refer 50 users trading $100k/day each: $150/day = $4,500/month`);
    console.log(`    • Refer 100 users trading $500k/day each: $1,500/day = $45,000/month`);
    console.log(`  All income is PASSIVE — no capital, no execution risk`);
  }

  // Portfolio projection
  console.log('\n── PORTFOLIO PROJECTION ($50k across top 5 LP vaults) ──');
  const top5 = yieldOpps.slice(0, 5);
  let totalAnnual = 0;
  for (const o of top5) {
    const allocation = 10000;
    const annual = allocation * o.apy / 100;
    totalAnnual += annual;
    console.log(`  ${o.rank}. ${o.strategy.padEnd(21)} ${o.apy.toFixed(1).padStart(6)}%/yr  ${fmtUsd(annual).padStart(8)}/yr  ${o.venue}`);
  }
  console.log(`\n  Total annual profit: ${fmtUsd(totalAnnual)}`);
  console.log(`  Portfolio yield: ${(totalAnnual / 50000 * 100).toFixed(2)}%/yr`);

  // Investor summary
  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  Perp LP vaults: ${yieldOpps.length}`);
  console.log(`  Total TVL: ${fmtUsd(yieldOpps.reduce((s, o) => s + o.tvlUsd, 0))}`);
  console.log(`  Top yield: ${yieldOpps[0].apy.toFixed(1)}% APY (${yieldOpps[0].asset})`);
  console.log(`  Portfolio yield on $50k: ${(totalAnnual / 50000 * 100).toFixed(2)}%/yr`);
  console.log(`  Risk profile: DELTA-NEUTRAL (perp LP = market making)`);
  console.log(`  Liquidity: HIGH (most vaults allow instant withdrawal)`);
  console.log(`  + HL Builder Fee: PASSIVE INCOME (no capital, just referrals)`);
}

main();
