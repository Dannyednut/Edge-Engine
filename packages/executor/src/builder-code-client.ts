/**
 * BuilderCodeClient — Hyperliquid builder code integration.
 *
 * Builder codes allow us to earn a fee (up to 10 bps / 0.1%) on every fill
 * we route to Hyperliquid. This is ADDITIONAL revenue on top of arb profits.
 *
 * Requirements:
 *   - Builder address must have ≥ 100 USDC in perps account value
 *   - Must use "standard" account abstraction mode
 *   - User must approve max builder fee via ApproveBuilderFee action
 *
 * Revenue estimate:
 *   - $5k per trade × 0.1% = $5/trade
 *   - 15 trades/day = $75/day = $27k/yr
 *   - This is PURE PROFIT on top of arb returns
 *
 * Usage:
 *   When placing HL orders (kHYPE carry, direct HL perp), include the builder
 *   field in the order request. The fee is automatically deducted from the
 *   user's fill and credited to the builder's account.
 */

export interface BuilderCodeConfig {
  /** Builder address (our agent wallet) */
  builderAddress: string;
  /** Builder fee rate in basis points (max 10 = 0.1%) */
  feeRateBps: number;
}

export class BuilderCodeClient {
  private config: BuilderCodeConfig;

  constructor(config: BuilderCodeConfig) {
    if (config.feeRateBps > 10) {
      throw new Error('Builder fee rate cannot exceed 10 bps (0.1%)');
    }
    this.config = config;
  }

  /**
   * Get the builder field to include in HL order requests.
   * The HL API expects: { builder: { b: builderAddress, f: feeRate } }
   * where f is the fee rate in units of 1e-5 (so 10 bps = 0.001 = 10).
   */
  getBuilderField(): { b: string; f: number } {
    return {
      b: this.config.builderAddress,
      f: this.config.feeRateBps,
    };
  }

  /**
   * Calculate the builder fee for a given trade size.
   * fee = tradeSize × (feeRateBps / 10000)
   */
  calculateFee(tradeSizeUsd: number): number {
    return tradeSizeUsd * (this.config.feeRateBps / 10000);
  }

  /**
   * Estimate annual builder fee revenue.
   * @param tradesPerDay Number of trades per day
   * @param avgTradeSizeUsd Average trade size in USD
   */
  estimateAnnualRevenue(tradesPerDay: number, avgTradeSizeUsd: number): number {
    const dailyFee = this.calculateFee(avgTradeSizeUsd) * tradesPerDay;
    return dailyFee * 365;
  }

  /** Get the builder address */
  get address(): string {
    return this.config.builderAddress;
  }

  /** Get the fee rate in bps */
  get feeRate(): number {
    return this.config.feeRateBps;
  }
}

// CLI
async function main() {
  const builderAddress = process.env.AGENT_HYPE_ADDRESS || '0x0000000000000000000000000000000000000000';
  const client = new BuilderCodeClient({
    builderAddress,
    feeRateBps: 10, // 0.1% (max allowed)
  });

  console.log('═══════════════════════════════════════════════════');
  console.log('  Builder Code Client');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Builder address: ${client.address}`);
  console.log(`  Fee rate: ${client.feeRate} bps (${client.feeRate / 100}%)`);
  console.log('');

  console.log('Revenue Estimates:');
  const scenarios = [
    { name: 'Conservative (5 trades/day, $5k)', trades: 5, size: 5000 },
    { name: 'Realistic (15 trades/day, $5k)', trades: 15, size: 5000 },
    { name: 'Active (30 trades/day, $5k)', trades: 30, size: 5000 },
    { name: 'High volume (50 trades/day, $10k)', trades: 50, size: 10000 },
  ];
  for (const s of scenarios) {
    const annual = client.estimateAnnualRevenue(s.trades, s.size);
    const perTrade = client.calculateFee(s.size);
    console.log(`  ${s.name.padEnd(40)} $${perTrade.toFixed(2)}/trade → $${(annual / 1000).toFixed(1)}k/yr`);
  }

  console.log('');
  console.log('Builder field for HL orders:');
  console.log(`  ${JSON.stringify(client.getBuilderField())}`);
  console.log('');
  console.log('Requirements:');
  console.log('  1. Builder address must have ≥ 100 USDC in perps account');
  console.log('  2. Must use "standard" account abstraction mode');
  console.log('  3. User must approve max builder fee via ApproveBuilderFee');
  console.log('  4. Fee applies to both sides of perp trades');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('Fatal:', e); process.exit(1); });
}
