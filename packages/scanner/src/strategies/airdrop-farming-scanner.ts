/**
 * AirdropFarmingScanner — tracks airdrop/points farming campaigns.
 *
 * Identifies protocols running points/airdrop campaigns where capital
 * deployment generates expected airdrop value (5-25% of capital).
 *
 * Total return = base yield + airdrop value
 *
 * MIGRATED FROM scripts-explore:
 *   - airdrop-farming-scanner.mts
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';

export interface AirdropFarmingParams {
  /** Min total expected return to report (default 10%) */
  minTotalReturnPct: number;
}

export interface AirdropAlert {
  protocol: string;
  chain: string;
  campaign: string;
  expectedYieldPct: number;
  expectedAirdropPct: number;
  totalExpectedReturnPct: number;
  riskScore: number;
  capitalRequired: number;
  lockupDays: number;
  ts: number;
}

// Known active airdrop campaigns (updated periodically)
const CAMPAIGNS: Array<{
  protocol: string; chain: string; campaign: string;
  expectedYieldPct: number; expectedAirdropPct: number;
  riskScore: number; capitalRequired: number; lockupDays: number;
}> = [
  { protocol: 'Kodiak Finance', chain: 'Hyperliquid L1', campaign: 'Kodiak Points S1', expectedYieldPct: 15, expectedAirdropPct: 20, riskScore: 4, capitalRequired: 10000, lockupDays: 0 },
  { protocol: 'Hyperswap', chain: 'Hyperliquid L1', campaign: 'Hyperswap Points', expectedYieldPct: 25, expectedAirdropPct: 15, riskScore: 4, capitalRequired: 10000, lockupDays: 0 },
  { protocol: 'Kinetiq (kHYPE)', chain: 'Hyperliquid L1', campaign: 'Kinetiq Rewards', expectedYieldPct: 2, expectedAirdropPct: 10, riskScore: 2, capitalRequired: 10000, lockupDays: 0 },
  { protocol: 'Harmonix Finance', chain: 'Hyperliquid L1', campaign: 'Harmonix Points', expectedYieldPct: 3.7, expectedAirdropPct: 12, riskScore: 3, capitalRequired: 10000, lockupDays: 0 },
  { protocol: 'Felix CDP', chain: 'Hyperliquid L1', campaign: 'Felix Points', expectedYieldPct: 5, expectedAirdropPct: 15, riskScore: 3, capitalRequired: 10000, lockupDays: 0 },
  { protocol: 'Liminal Basis', chain: 'Hyperliquid L1', campaign: 'Liminal Points', expectedYieldPct: 8, expectedAirdropPct: 10, riskScore: 3, capitalRequired: 10000, lockupDays: 0 },
  { protocol: 'Drift Protocol', chain: 'Solana', campaign: 'Drift S2', expectedYieldPct: 5, expectedAirdropPct: 8, riskScore: 3, capitalRequired: 10000, lockupDays: 0 },
  { protocol: 'Kamino Finance', chain: 'Solana', campaign: 'Kamino S2', expectedYieldPct: 6.5, expectedAirdropPct: 5, riskScore: 3, capitalRequired: 10000, lockupDays: 0 },
  { protocol: 'Symbiotic', chain: 'Ethereum', campaign: 'Symbiotic Points', expectedYieldPct: 20, expectedAirdropPct: 15, riskScore: 4, capitalRequired: 10000, lockupDays: 0 },
  { protocol: 'EigenLayer', chain: 'Ethereum', campaign: 'Season 2', expectedYieldPct: 3, expectedAirdropPct: 5, riskScore: 3, capitalRequired: 10000, lockupDays: 0 },
  { protocol: 'Monad', chain: 'Monad', campaign: 'Monad Testnet', expectedYieldPct: 8, expectedAirdropPct: 25, riskScore: 5, capitalRequired: 5000, lockupDays: 0 },
  { protocol: 'Berachain', chain: 'Berachain', campaign: 'BGT Farming', expectedYieldPct: 15, expectedAirdropPct: 20, riskScore: 5, capitalRequired: 10000, lockupDays: 0 },
  { protocol: 'MegaETH', chain: 'MegaETH', campaign: 'MegaETH Points', expectedYieldPct: 5, expectedAirdropPct: 15, riskScore: 5, capitalRequired: 5000, lockupDays: 0 },
];

export class AirdropFarmingScanner implements Strategy {
  readonly id = 'airdrop_farming';
  readonly landscape = 'F_perps_funding' as const;

  constructor(private params: AirdropFarmingParams) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 0,
      maxSizeUsd: 50_000,
      maxConcurrent: 10,
      cooldownMs: 60 * 60_000,
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<AirdropAlert[]> {
    const alerts: AirdropAlert[] = [];

    for (const c of CAMPAIGNS) {
      const totalReturn = c.expectedYieldPct + c.expectedAirdropPct;
      if (totalReturn < this.params.minTotalReturnPct) continue;

      alerts.push({
        protocol: c.protocol,
        chain: c.chain,
        campaign: c.campaign,
        expectedYieldPct: c.expectedYieldPct,
        expectedAirdropPct: c.expectedAirdropPct,
        totalExpectedReturnPct: totalReturn,
        riskScore: c.riskScore,
        capitalRequired: c.capitalRequired,
        lockupDays: c.lockupDays,
        ts: Date.now(),
      });
    }

    alerts.sort((a, b) => b.totalExpectedReturnPct - a.totalExpectedReturnPct);
    return alerts;
  }
}
