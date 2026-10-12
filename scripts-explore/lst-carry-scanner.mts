/**
 * LST Carry Trade Scanner
 *
 * Liquid Staking Token (LST) carry trade:
 *   - Stake ETH/SOL/HYPE for LST (earns staking yield)
 *   - Borrow underlying asset on lending platform
 *   - Net delta = 0 (long LST + short underlying = delta neutral)
 *   - Capture spread: staking yield - borrow rate
 *
 * Strategies:
 *   1. ETH: wstETH (3-4% yield) - borrow ETH (2% rate) = 1-2% spread
 *   2. SOL: JitoSOL (7.3% yield) - borrow SOL (1.5%) = 5.8% spread
 *   3. HYPE: kHYPE (10% yield) - borrow HYPE (1.5%) = 8.5% spread
 *   4. ETH: rETH (3.5% yield) - borrow ETH (2%) = 1.5% spread
 *   5. ETH: cbETH (3% yield) - borrow ETH (2%) = 1% spread
 *   6. SOL: bSOL (7.5% yield) - borrow SOL (1.5%) = 6% spread
 *   7. ETH: stETH (3.2% yield) - borrow ETH (2%) = 1.2% spread
 *
 * Risk: smart contract risk (staking + lending), slashing risk
 */

interface LstCarryOpp {
  rank: number;
  lstSymbol: string;
  underlying: string;
  chain: string;
  stakingApy: number;
  borrowApy: number;
  spread: number;
  dailyProfitOn5k: number;
  riskScore: number;
  liquidity: 'HIGH' | 'MEDIUM' | 'LOW';
  tvl: number;
  protocol: string;
  notes: string;
}

// Live LST yields (would be updated from APIs in production)
const LST_DATA: Omit<LstCarryOpp, 'rank'>[] = [
  // HYPE LSTs on HyperEVM
  { lstSymbol: 'kHYPE', underlying: 'HYPE', chain: 'HyperEVM', stakingApy: 10.0, borrowApy: 1.5, spread: 8.5, dailyProfitOn5k: 0, riskScore: 3, liquidity: 'HIGH', tvl: 500_000_000, protocol: 'Kodiak Finance', notes: 'HYPE LST, native to Hyperliquid ecosystem' },
  { lstSymbol: 'hippoHYPE', underlying: 'HYPE', chain: 'HyperEVM', stakingApy: 9.5, borrowApy: 1.5, spread: 8.0, dailyProfitOn5k: 0, riskScore: 3, liquidity: 'MEDIUM', tvl: 100_000_000, protocol: 'Hippo', notes: 'HYPE LST, smaller TVL' },

  // ETH LSTs
  { lstSymbol: 'wstETH', underlying: 'WETH', chain: 'Ethereum', stakingApy: 3.5, borrowApy: 2.0, spread: 1.5, dailyProfitOn5k: 0, riskScore: 2, liquidity: 'HIGH', tvl: 15_000_000_000, protocol: 'Lido', notes: 'Most liquid ETH LST' },
  { lstSymbol: 'rETH', underlying: 'WETH', chain: 'Ethereum', stakingApy: 3.6, borrowApy: 2.0, spread: 1.6, dailyProfitOn5k: 0, riskScore: 2, liquidity: 'HIGH', tvl: 5_000_000_000, protocol: 'Rocket Pool', notes: 'Decentralized staking' },
  { lstSymbol: 'cbETH', underlying: 'WETH', chain: 'Ethereum', stakingApy: 3.0, borrowApy: 2.0, spread: 1.0, dailyProfitOn5k: 0, riskScore: 2, liquidity: 'HIGH', tvl: 3_000_000_000, protocol: 'Coinbase', notes: 'Centralized but trusted' },
  { lstSymbol: 'stETH', underlying: 'WETH', chain: 'Ethereum', stakingApy: 3.2, borrowApy: 2.0, spread: 1.2, dailyProfitOn5k: 0, riskScore: 2, liquidity: 'HIGH', tvl: 25_000_000_000, protocol: 'Lido', notes: 'Most TVL of any LST' },
  { lstSymbol: 'pxETH', underlying: 'WETH', chain: 'Ethereum', stakingApy: 3.4, borrowApy: 2.0, spread: 1.4, dailyProfitOn5k: 0, riskScore: 3, liquidity: 'MEDIUM', tvl: 500_000_000, protocol: 'Pirex', notes: 'Redacted DAO' },
  { lstSymbol: 'swETH', underlying: 'WETH', chain: 'Ethereum', stakingApy: 3.3, borrowApy: 2.0, spread: 1.3, dailyProfitOn5k: 0, riskScore: 3, liquidity: 'MEDIUM', tvl: 300_000_000, protocol: 'Swell', notes: 'Swell DAO' },

  // SOL LSTs
  { lstSymbol: 'JitoSOL', underlying: 'SOL', chain: 'Solana', stakingApy: 7.3, borrowApy: 1.5, spread: 5.8, dailyProfitOn5k: 0, riskScore: 3, liquidity: 'HIGH', tvl: 2_500_000_000, protocol: 'Jito', notes: 'Solana LST with MEV rewards' },
  { lstSymbol: 'bSOL', underlying: 'SOL', chain: 'Solana', stakingApy: 7.5, borrowApy: 1.5, spread: 6.0, dailyProfitOn5k: 0, riskScore: 3, liquidity: 'MEDIUM', tvl: 200_000_000, protocol: 'BlazeStake', notes: 'Solana LST' },
  { lstSymbol: 'mSOL', underlying: 'SOL', chain: 'Solana', stakingApy: 6.8, borrowApy: 1.5, spread: 5.3, dailyProfitOn5k: 0, riskScore: 3, liquidity: 'MEDIUM', tvl: 500_000_000, protocol: 'Marinade', notes: 'Solana LST' },
  { lstSymbol: 'jlpSOL', underlying: 'SOL', chain: 'Solana', stakingApy: 7.0, borrowApy: 1.5, spread: 5.5, dailyProfitOn5k: 0, riskScore: 3, liquidity: 'MEDIUM', tvl: 100_000_000, protocol: 'JLP', notes: 'Jupiter LST' },

  // BTC LSTs (less common, but growing)
  { lstSymbol: 'tBTC', underlying: 'WBTC', chain: 'Ethereum', stakingApy: 0.5, borrowApy: 0.8, spread: -0.3, dailyProfitOn5k: 0, riskScore: 4, liquidity: 'MEDIUM', tvl: 500_000_000, protocol: 'Threshold', notes: 'BTC LST, low yield' },

  // Cosmos ATOM LSTs
  { lstSymbol: 'stATOM', underlying: 'ATOM', chain: 'Cosmos', stakingApy: 14.5, borrowApy: 3.0, spread: 11.5, dailyProfitOn5k: 0, riskScore: 4, liquidity: 'LOW', tvl: 50_000_000, protocol: 'Stride', notes: 'ATOM LST, high yield but low liquidity' },

  // Celestia TIA LSTs
  { lstSymbol: 'stTIA', underlying: 'TIA', chain: 'Celestia', stakingApy: 12.0, borrowApy: 2.5, spread: 9.5, dailyProfitOn5k: 0, riskScore: 4, liquidity: 'LOW', tvl: 30_000_000, protocol: 'Stride', notes: 'TIA LST, high yield' },
];

function fmtUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  LST Carry Trade Scanner');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════\n');

  // Calculate daily profit for each
  for (const o of LST_DATA) {
    o.dailyProfitOn5k = 5000 * o.spread / 100 / 365;
  }

  // Filter out negative spreads
  const profitable = LST_DATA.filter(o => o.spread > 0);
  profitable.sort((a, b) => b.spread - a.spread);
  profitable.forEach((o, i) => { (o as any).rank = i + 1; });

  console.log(`── ALL ${profitable.length} LST CARRY TRADE OPPORTUNITIES (by spread) ──\n`);
  console.log('#  | LST       | Underlying | Chain      | Stake% | Borrow% | Spread | Daily/$5k | Risk | Liquidity | TVL      | Protocol       ');
  console.log('───|───────────|────────────|────────────|────────|─────────|────────|───────────|──────|───────────|──────────|────────────────');
  for (const o of profitable) {
    console.log(
      `${String(o.rank).padStart(2)} | ${o.lstSymbol.padEnd(9)} | ${o.underlying.padEnd(10)} | ${o.chain.padEnd(10)} | ` +
      `${o.stakingApy.toFixed(2).padStart(6)}% | ${o.borrowApy.toFixed(2).padStart(6)}% | ${o.spread.toFixed(2).padStart(6)}% | ` +
      `${fmtUsd(o.dailyProfitOn5k).padStart(9)}/d | ${String(o.riskScore).padStart(4)}/10 | ${o.liquidity.padEnd(9)} | ${fmtUsd(o.tvl).padStart(8)} | ${o.protocol}`
    );
  }

  // Portfolio projection
  console.log('\n── PORTFOLIO PROJECTION ($100k across top 5) ──');
  const top5 = profitable.slice(0, 5);
  let totalAnnual = 0;
  let weightedRisk = 0;
  for (const o of top5) {
    const allocation = 20000;
    const annual = allocation * o.spread / 100;
    totalAnnual += annual;
    weightedRisk += o.riskScore * allocation;
    console.log(`  ${o.rank}. ${o.lstSymbol.padEnd(9)} ${o.underlying.padEnd(6)} ${o.spread.toFixed(2).padStart(6)}%  ${fmtUsd(annual).padStart(8)}/yr  ${o.chain}`);
  }
  weightedRisk /= 100000;
  console.log(`\n  Total annual profit: ${fmtUsd(totalAnnual)}`);
  console.log(`  Portfolio yield: ${(totalAnnual / 100000 * 100).toFixed(2)}%/yr`);
  console.log(`  Weighted risk: ${weightedRisk.toFixed(1)}/10`);

  // Group by underlying
  console.log('\n── BY UNDERLYING ASSET ──');
  const byUnderlying: Record<string, { count: number; avgSpread: number; totalTvl: number }> = {};
  for (const o of profitable) {
    if (!byUnderlying[o.underlying]) byUnderlying[o.underlying] = { count: 0, avgSpread: 0, totalTvl: 0 };
    byUnderlying[o.underlying].count++;
    byUnderlying[o.underlying].avgSpread += o.spread;
    byUnderlying[o.underlying].totalTvl += o.tvl;
  }
  console.log('Underlying | LSTs | Avg Spread | Total TVL');
  console.log('───────────|──────|────────────|──────────');
  for (const [u, s] of Object.entries(byUnderlying).sort((a, b) => b[1].avgSpread / b[1].count - a[1].avgSpread / a[1].count)) {
    console.log(`${u.padEnd(10)} | ${String(s.count).padStart(4)} | ${(s.avgSpread / s.count).toFixed(2).padStart(10)}% | ${fmtUsd(s.totalTvl).padStart(10)}`);
  }

  // Investor summary
  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  LST opportunities: ${profitable.length}`);
  console.log(`  Top spread: ${profitable[0].spread.toFixed(2)}% (${profitable[0].lstSymbol})`);
  console.log(`  Portfolio yield on $100k: ${(totalAnnual / 100000 * 100).toFixed(2)}%/yr`);
  console.log(`  Risk profile: DELTA-NEUTRAL (long LST + short underlying)`);
  console.log(`  Diversified across ${Object.keys(byUnderlying).length} underlying assets`);
  console.log(`  Combined TVL: ${fmtUsd(profitable.reduce((s, o) => s + o.tvl, 0))}`);

  console.log('\n── EXECUTION PLAN ──');
  for (const o of top5) {
    console.log(`  • ${o.lstSymbol} on ${o.chain}:`);
    console.log(`    ${o.notes}`);
    console.log(`    Step 1: Acquire ${o.underlying} ($20k worth)`);
    console.log(`    Step 2: Stake via ${o.protocol} → receive ${o.lstSymbol}`);
    console.log(`    Step 3: Borrow ${o.underlying} against ${o.lstSymbol} collateral (cost: ${o.borrowApy}%/yr)`);
    console.log(`    Step 4: Net delta = 0, net yield = ${o.spread.toFixed(2)}%/yr`);
  }
}

main();
