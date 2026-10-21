/**
 * LeverageLoopScanner — recursive yield farming via leverage loops.
 *
 * Strategy:
 *   - Supply USDC to lending platform (earn supply yield)
 *   - Borrow USDC against supplied USDC (pay borrow rate)
 *   - Re-supply borrowed USDC (earn more supply yield)
 *   - Repeat 2-5x for amplified yield
 *
 * Net yield = (supply rate - borrow rate) × leverage
 *
 * MIGRATED FROM scripts-explore:
 *   - leverage-loop-scanner.mts
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';

export interface LeverageLoopParams {
  /** Min spread (supply - borrow) to consider (default 0.5%) */
  minSpreadPct: number;
  /** Max leverage to consider (default 5x) */
  maxLeverage: number;
}

export interface LeverageLoopAlert {
  asset: string;
  platform: string;
  chain: string;
  supplyRate: number;
  borrowRate: number;
  spread: number;
  leverage: number;
  amplifiedYield: number;
  riskScore: number;
  /** RESEARCH-ONLY: This alert is based on static rate tables, not live market data.
   *  Must NOT be sent as an actionable opportunity alert. */
  researchOnly: boolean;
  ts: number;
}

// Known lending rate spreads (would be fetched live from DefiLlama in production)
const KNOWN_OPPS: Array<{
  asset: string; platform: string; chain: string;
  supplyRate: number; borrowRate: number; leverage: number; riskScore: number;
}> = [
  { asset: 'USDC', platform: 'Kamino Multiply', chain: 'Solana', supplyRate: 6.5, borrowRate: 5.0, leverage: 3, riskScore: 4 },
  { asset: 'JitoSOL', platform: 'Kamino Multiply', chain: 'Solana', supplyRate: 7.0, borrowRate: 5.5, leverage: 3, riskScore: 5 },
  { asset: 'sFRAX', platform: 'Frax Lend', chain: 'Ethereum', supplyRate: 5.0, borrowRate: 3.5, leverage: 4, riskScore: 4 },
  { asset: 'USDC', platform: 'Aave V3', chain: 'Ethereum', supplyRate: 5.9, borrowRate: 5.0, leverage: 5, riskScore: 3 },
  { asset: 'USDC', platform: 'Morpho Blue', chain: 'Ethereum', supplyRate: 5.8, borrowRate: 4.5, leverage: 4, riskScore: 3 },
  { asset: 'USDC', platform: 'Hyperlend', chain: 'Hyperliquid L1', supplyRate: 5.7, borrowRate: 3.5, leverage: 4, riskScore: 4 },
  { asset: 'USDC', platform: 'Felix CDP', chain: 'Hyperliquid L1', supplyRate: 5.1, borrowRate: 2.0, leverage: 3, riskScore: 4 },
  { asset: 'kHYPE', platform: 'Kinetiq + Hyperlend', chain: 'Hyperliquid L1', supplyRate: 1.9, borrowRate: 0.5, leverage: 4, riskScore: 5 },
];

export class LeverageLoopScanner implements Strategy {
  readonly id = 'leverage_loop';
  readonly landscape = 'F_perps_funding' as const;

  constructor(private params: LeverageLoopParams) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 50,
      maxSizeUsd: 50_000,
      maxConcurrent: 5,
      cooldownMs: 30 * 60_000,
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<LeverageLoopAlert[]> {
    const alerts: LeverageLoopAlert[] = [];

    for (const o of KNOWN_OPPS) {
      const spread = o.supplyRate - o.borrowRate;
      if (spread < this.params.minSpreadPct) continue;
      if (o.leverage > this.params.maxLeverage) continue;

      // For LSTs, add base staking yield
      const baseStakingYield = o.asset === 'JitoSOL' ? 5.0 : o.asset === 'kHYPE' ? 1.9 : 0;
      const amplifiedYield = spread * o.leverage + baseStakingYield;

      alerts.push({
        asset: o.asset,
        platform: o.platform,
        chain: o.chain,
        supplyRate: o.supplyRate,
        borrowRate: o.borrowRate,
        spread,
        leverage: o.leverage,
        amplifiedYield,
        riskScore: o.riskScore,
        researchOnly: true, // Static table — NOT live market data
        ts: Date.now(),
      });
    }

    alerts.sort((a, b) => b.amplifiedYield - a.amplifiedYield);
    return alerts;
  }
}
