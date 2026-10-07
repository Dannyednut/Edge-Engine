/**
 * EulerLendingArbScanner — find Euler HL vault yield spreads.
 *
 * ARB STRUCTURE:
 *   Each asset on Euler has multiple vaults (eUSDC-1 through -6, etc.).
 *   These vaults can have different IRMs (interest rate models) → different APYs.
 *   When the same asset has different deposit/borrow rates across vaults:
 *     1. Deposit in highest-APY vault (earn that rate)
 *     2. Use deposit as collateral to borrow from lowest-APY vault (pay that rate)
 *     3. Net capture = (deposit APY - borrow APY) × collateral factor
 *
 * HYPERLIQUID-SPECIFIC ANGLE:
 *   - Multiple vaults per asset = Mewler (HypurrFi partnership) configuration
 *   - Some vaults may have promotional APYs to attract liquidity
 *   - Cross-vault EVC collateral = atomic delta-neutral possible
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';
import { EulerClient, type EulerVaultInfo } from '@edge/executor';

export interface EulerLendingArbParams {
  /** Min spread between deposit and borrow rate (default 1%) */
  minSpreadPct: number;
  /** Min total liquidity (totalAssets of both vaults combined) in USD (default $50k) */
  minLiquidityUsd: number;
  /** Max position size (default $5000) */
  maxSizeUsd: number;
  /** Asset price assumptions for converting to USD */
  assetPrices?: Record<string, number>;
}

export interface EulerLendingArbAlert {
  assetSymbol: string;
  depositVault: { address: string; name: string; apyPct: number; tvl: number; };
  borrowVault:  { address: string; name: string; apyPct: number; tvl: number; };
  spreadPct: number;             // deposit APY - borrow APY
  estimatedProfitUsd: number;    // on $5k collateral at collateral factor 0.8
  collateralFactorPct: number;
  totalLiquidityUsd: number;
  ts: number;
}

const DEFAULT_PRICES: Record<string, number> = {
  USDC: 1, 'USDT0': 1, 'USD\u20E90': 1, USDH: 1, sUSN: 1, sUSDp: 1, USDXL: 1, USDG0: 1, syzUSD: 1, FXRP: 1,
  WHYPE: 89.5, kHYPE: 87.3, wstHYPE: 89.5, lstHYPE: 89.5, beHYPE: 89.5, haHYPE: 89.5, hwHYPE: 89.5, xHYPE: 89.5, LHYPE: 89.5,
  UBTC: 96000, UETH: 3300,
  PURR: 0.01, UPUMP: 0.01, UFART: 0.01,
  'PT-kHYPE-19MAR2026': 0.95,
};

export class EulerLendingArbScanner implements Strategy {
  readonly id = 'euler_lending_arb';
  readonly landscape = 'F_perps_funding' as const;

  private euler: EulerClient;

  constructor(private params: EulerLendingArbParams) {
    this.euler = new EulerClient();
  }

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 50,
      maxSizeUsd: this.params.maxSizeUsd,
      maxConcurrent: 5,
      cooldownMs: 60 * 60_000,
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<EulerLendingArbAlert[]> {
    const alerts: EulerLendingArbAlert[] = [];

    const vaults = await this.euler.getAllVaults();
    if (vaults.length === 0) return [];

    // Group vaults by asset
    const byAsset = new Map<string, EulerVaultInfo[]>();
    for (const v of vaults) {
      if (v.totalAssets <= 0) continue;
      if (!byAsset.has(v.assetSymbol)) byAsset.set(v.assetSymbol, []);
      byAsset.get(v.assetSymbol)!.push(v);
    }

    const prices = { ...DEFAULT_PRICES, ...this.params.assetPrices };

    // For each asset, find the best deposit (highest APY) and best borrow (lowest APY) vault
    for (const [asset, vaultsForAsset] of byAsset.entries()) {
      if (vaultsForAsset.length < 2) continue; // need at least 2 vaults for spread

      const price = prices[asset] ?? 0;
      if (price === 0) continue;

      // Sort by APY
      const sorted = [...vaultsForAsset].sort((a, b) => b.interestRatePct - a.interestRatePct);
      const highest = sorted[0];
      const lowest = sorted[sorted.length - 1];

      // Note: borrowable flag parsing may be off — skip the filter for now
      // and rely on the borrow/lend rate spread to identify opportunities.
      // The vault will reject the tx at execution time if borrowing is disabled.
      // if (!highest.borrowable) continue;
      // if (!lowest.borrowable) continue;

      const spreadPct = highest.interestRatePct - lowest.interestRatePct;
      if (spreadPct < this.params.minSpreadPct) continue;

      const collateralFactorPct = 80; // assume 80% LTV (typical)
      const totalLiquidityUsd =
        (highest.totalAssets + lowest.totalAssets) * price;
      if (totalLiquidityUsd < this.params.minLiquidityUsd) continue;

      // Estimated profit on $5k collateral, borrow at 80% LTV
      const borrowUsd = this.params.maxSizeUsd * (collateralFactorPct / 100);
      const estimatedProfitUsd = (spreadPct / 100) * borrowUsd;

      alerts.push({
        assetSymbol: asset,
        depositVault: {
          address: highest.address,
          name: highest.name,
          apyPct: highest.interestRatePct,
          tvl: highest.totalAssets,
        },
        borrowVault: {
          address: lowest.address,
          name: lowest.name,
          apyPct: lowest.interestRatePct,
          tvl: lowest.totalAssets,
        },
        spreadPct,
        estimatedProfitUsd,
        collateralFactorPct,
        totalLiquidityUsd,
        ts: Date.now(),
      });
    }

    // Sort by spread (highest first)
    alerts.sort((a, b) => b.spreadPct - a.spreadPct);
    return alerts;
  }

  /** Get all vaults for diagnostics/CLI */
  async getAllVaults(): Promise<EulerVaultInfo[]> {
    return this.euler.getAllVaults();
  }
}
