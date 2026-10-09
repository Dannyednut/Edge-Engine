// Explore HyperEVM Validator Running
// HyperEVM is Hyperliquid's EVM chain (chain ID 999)
// Validators secure the network and earn:
//   - Block rewards (newly minted HYPE)
//   - Transaction fees (gas)
//   - MEV tips (if applicable)
//
// Requirements:
//   - Stake HYPE tokens (self-delegation + delegated)
//   - Run validator node (server + bandwidth)
//   - Maintain uptime > 95%
//
// Hyperliquid consensus:
//   - BFT-style consensus (similar to Tendermint)
//   - 100+ validators
//   - Top 21 validators by stake produce blocks

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperEVM Validator Economics');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Network parameters
  console.log('── HyperEVM Network Parameters ──');
  console.log('  Chain ID: 999');
  console.log('  Consensus: HyperBFT (Tendermint-style)');
  console.log('  Block time: ~2s');
  console.log('  Total validators: ~100 (top 21 active)');
  console.log('  Total HYPE stake: ~$10B (HYPE market cap)');
  console.log('  Validator reward: inflation + tx fees');
  console.log('');

  // 2. Validator economics
  console.log('── Validator Economics ──');
  const params = {
    totalStake: 400_000_000, // 400M HYPE
    hypePrice: 85,
    annualInflation: 0.02, // 2% APR
    annualTxFees: 0.005, // 0.5% APR from fees
    validatorCount: 100,
    minSelfStake: 10_000, // 10k HYPE minimum
    uptimeRequirement: 0.95,
    slashingPenalty: 0.05, // 5% slash for downtime
  };
  const totalStakeUsd = params.totalStake * params.hypePrice;
  const annualRewardHype = params.totalStake * (params.annualInflation + params.annualTxFees);
  const annualRewardUsd = annualRewardHype * params.hypePrice;
  const avgValidatorStake = params.totalStake / params.validatorCount;
  const avgValidatorReward = annualRewardHype / params.validatorCount;

  console.log(`  Total HYPE stake: ${params.totalStake.toLocaleString()} HYPE ($${(totalStakeUsd/1e9).toFixed(1)}B)`);
  console.log(`  Annual inflation: ${(params.annualInflation*100).toFixed(1)}%`);
  console.log(`  Annual tx fees: ${(params.annualTxFees*100).toFixed(2)}%`);
  console.log(`  Annual rewards: ${annualRewardHype.toLocaleString()} HYPE ($${(annualRewardUsd/1e6).toFixed(0)}M)`);
  console.log(`  Validators: ${params.validatorCount}`);
  console.log(`  Avg stake per validator: ${avgValidatorStake.toLocaleString()} HYPE ($${(avgValidatorStake * params.hypePrice/1e6).toFixed(1)}M)`);
  console.log(`  Avg reward per validator: ${avgValidatorReward.toLocaleString()} HYPE ($${(avgValidatorReward * params.hypePrice/1e3).toFixed(0)}k/yr)`);
  console.log(`  Validator APR: ${((params.annualInflation + params.annualTxFees) * 100).toFixed(2)}%`);
  console.log('');

  // 3. Cost to run validator
  console.log('── Operating Costs ──');
  console.log('  Server (cloud): $200-500/mo');
  console.log('    - AWS c5.2xlarge: $250/mo');
  console.log('    - GCP n2-standard-8: $350/mo');
  console.log('    - Self-hosted (colocation): $100-300/mo');
  console.log('  Bandwidth: $50-200/mo');
  console.log('  Monitoring/DevOps: $100/mo');
  console.log('  Total monthly cost: $350-750');
  console.log('  Annual cost: $4,200-9,000');
  console.log('');

  // 4. Self-stake requirement
  console.log('── Self-Stake Requirement ──');
  console.log(`  Minimum self-stake: ${params.minSelfStake.toLocaleString()} HYPE`);
  console.log(`  At HYPE=$${params.hypePrice}: $${(params.minSelfStake * params.hypePrice).toLocaleString()}`);
  console.log('  Recommended: 50,000 HYPE = $4.25M (for top-21 position)');
  console.log('');

  // 5. Realistic returns
  console.log('── Realistic Returns ──');
  const scenarios = [
    { name: 'Minimal validator (10k HYPE self-stake)', selfStake: 10000, delegated: 0 },
    { name: 'Small validator (50k HYPE self-stake)', selfStake: 50000, delegated: 50000 },
    { name: 'Mid validator (100k HYPE self-stake)', selfStake: 100000, delegated: 500000 },
    { name: 'Top validator (500k HYPE self-stake)', selfStake: 500000, delegated: 5000000 },
  ];
  for (const s of scenarios) {
    const totalStake = s.selfStake + s.delegated;
    const validatorStakeShare = totalStake / params.totalStake;
    const grossReward = totalStake * (params.annualInflation + params.annualTxFees);
    // Commission: 5-10% on delegated stake
    const commissionRate = 0.10;
    const commissionIncome = s.delegated * (params.annualInflation + params.annualTxFees) * commissionRate;
    const ownStakeReward = s.selfStake * (params.annualInflation + params.annualTxFees);
    const totalIncome = commissionIncome + ownStakeReward;
    const netIncome = totalIncome * params.hypePrice - 6000; // minus $6k opex
    console.log(`  ${s.name}:`);
    console.log(`    Self-stake: ${s.selfStake.toLocaleString()} HYPE ($${(s.selfStake * params.hypePrice/1e6).toFixed(2)}M)`);
    console.log(`    Delegated: ${s.delegated.toLocaleString()} HYPE ($${(s.delegated * params.hypePrice/1e6).toFixed(2)}M)`);
    console.log(`    Gross reward: ${grossReward.toFixed(0).toLocaleString()} HYPE = $${(grossReward * params.hypePrice).toLocaleString()}/yr`);
    console.log(`    Commission income (10%): ${commissionIncome.toFixed(0).toLocaleString()} HYPE = $${(commissionIncome * params.hypePrice).toLocaleString()}/yr`);
    console.log(`    Net income (after $6k opex): $${netIncome.toLocaleString()}/yr`);
    console.log(`    ROI on self-stake: ${(netIncome / (s.selfStake * params.hypePrice) * 100).toFixed(2)}%`);
  }

  console.log('\n── Risks ──');
  console.log('  1. Slashing: 5% of stake for double-signing or downtime');
  console.log('  2. HYPE price volatility (revenue in HYPE, costs in USD)');
  console.log('  3. Competition: top-21 spots heavily contested');
  console.log('  4. Network upgrades may require downtime');
  console.log('  5. Smart contract risk in validator client');
  console.log('');

  console.log('=== Verdict ===');
  console.log('Running a HyperEVM validator is CAPITAL-INTENSIVE, LOW-ROI for newcomers.');
  console.log('  Min self-stake: $850k (10k HYPE)');
  console.log('  Realistic ROI: 2-5% on self-stake (vs 2.3% on HYPE staking)');
  console.log('  Best for: existing large HYPE holders who want to secure network');
  console.log('');
  console.log('Recommendation: SKIP');
  console.log('  - We don\'t have $850k+ capital');
  console.log('  - Even with capital, ROI is similar to plain HYPE staking');
  console.log('  - Better: stake HYPE via kHYPE LST (1.7% APR, no operational risk)');
  console.log('');
  console.log('ACTION: NONE — revisit if enterprise grows to $5M+ in HYPE holdings');
}

main().catch(console.error);
