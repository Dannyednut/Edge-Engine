/**
 * EulerLendingArbScanner — find Euler HL vault yield spreads.
 *
 * CORRECTED SEMANTICS (EM-STRAT-003, hardened EM-STRAT-004, test-safety EM-STRAT-005):
 *   The difference between two interestRate() values is NOT "deposit APY
 *   minus borrow APY." Euler's interestRate() returns the BORROW rate.
 *   The supply (deposit) rate must be computed from the borrow rate,
 *   utilization, and reserve factor, or obtained from a verified source.
 *
 *   This scanner FAILS CLOSED when:
 *   - Supply rate cannot be independently computed or verified
 *   - Asset prices are unavailable (no stale hardcoded defaults)
 *   - Borrowability/capacity cannot be verified
 *
 *   Until valid supply and borrow rates, live prices, and usable liquidity
 *   are available, this scanner emits clearly labeled monitoring data
 *   rather than an arbitrage profit estimate.
 *
 * TEST SEAM (EM-STRAT-005 §3):
 *   The constructor accepts an optional `deps` argument with `eulerClient`
 *   (an injectable EulerClient-like object) for deterministic testing.
 *   Tests pass a mock client that returns canned vault records — no live
 *   RPC. Production callers omit `deps`; the scanner constructs a real
 *   EulerClient internally.
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';
import { EulerClient, type EulerVaultInfo } from '@edge/executor';

export interface EulerLendingArbParams {
  /** Min spread between supply and borrow rate (default 1%) */
  minSpreadPct: number;
  /** Min total liquidity (totalAssets of both vaults combined) in USD (default $50k) */
  minLiquidityUsd: number;
  /** Max position size (default $5000) */
  maxSizeUsd: number;
  /** Asset price inputs — must be provided by the caller from a verified source. */
  assetPrices?: Record<string, number>;
}

/**
 * Injectable dependencies. Tests pass `eulerClient` to override the live
 * EulerClient. Production callers omit `deps`.
 *
 * EM-STRAT-005 §3: tests MUST NOT trigger live HyperEVM RPC. The mock
 * client returns deterministic vault records.
 */
export interface EulerLendingArbDeps {
  /**
   * Override the internally-constructed EulerClient. Must expose
   * `getAllVaults(): Promise<EulerVaultInfo[]>` (the only method this
   * scanner calls).
   */
  eulerClient?: { getAllVaults(): Promise<EulerVaultInfo[]> };
}

export interface EulerLendingArbAlert {
  assetSymbol: string;
  depositVault: { address: string; name: string; borrowApyPct: number; supplyApyPct: number | null; tvl: number; };
  borrowVault:  { address: string; name: string; borrowApyPct: number; supplyApyPct: number | null; tvl: number; };
  /** Spread between highest supply APY and lowest borrow APY. null = supply APY unavailable. */
  spreadPct: number | null;
  /** Estimated profit in USD. null = cannot compute (missing supply rate or price). */
  estimatedProfitUsd: number | null;
  collateralFactorPct: number;
  totalLiquidityUsd: number | null;
  /** Whether both vaults are borrowable. */
  borrowable: boolean;
  /** MONITORING ONLY: Do not present as an executable arbitrage. */
  monitoringOnly: boolean;
  ts: number;
}

export class EulerLendingArbScanner implements Strategy {
  readonly id = 'euler_lending_arb';
  readonly landscape = 'F_perps_funding' as const;

  private euler: { getAllVaults(): Promise<EulerVaultInfo[]> };

  constructor(private params: EulerLendingArbParams, deps: EulerLendingArbDeps = {}) {
    // EM-STRAT-005 §3: injectable test seam. When deps.eulerClient is
    // provided, no live EulerClient is constructed and no RPC is issued.
    this.euler = deps.eulerClient ?? new EulerClient();
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

    // Use caller-provided prices only. No hardcoded defaults.
    const prices = this.params.assetPrices ?? {};

    for (const [asset, vaultsForAsset] of byAsset.entries()) {
      if (vaultsForAsset.length < 2) continue;

      const price = prices[asset] ?? null;
      // If price is unavailable, we can still emit monitoring data (no USD estimates)
      const hasPrice = price !== null && price > 0;

      // Sort by borrow APY (interestRate is the borrow rate, NOT supply rate)
      const sorted = [...vaultsForAsset].sort((a, b) => b.interestRatePct - a.interestRatePct);
      const highest = sorted[0];
      const lowest = sorted[sorted.length - 1];

      // Supply APY is NOT directly available from interestRate().
      // It must be computed from borrow rate, utilization, and reserve factor.
      // Since we cannot compute it here without additional on-chain reads,
      // we mark it as null and fail closed on profit estimates.
      const supplyApyHigh: number | null = null;
      const supplyApyLow: number | null = null;

      // The spread between borrow rates is NOT the arbitrage spread.
      // The true spread = supply APY of deposit vault - borrow APY of borrow vault.
      // Since supply APY is null, spread is null.
      const spreadPct: number | null = null;

      // Check borrowability
      const borrowable = (highest as any).borrowable !== false && (lowest as any).borrowable !== false;

      // Total liquidity (only if price available)
      const totalLiquidityUsd: number | null = hasPrice
        ? (highest.totalAssets + lowest.totalAssets) * price!
        : null;

      // Profit estimate: null (cannot compute without supply APY and verified price)
      const estimatedProfitUsd: number | null = null;

      // Emit as monitoring data, not actionable arbitrage
      const monitoringOnly = true;

      alerts.push({
        assetSymbol: asset,
        depositVault: {
          address: highest.address,
          name: highest.name,
          borrowApyPct: highest.interestRatePct,
          supplyApyPct: supplyApyHigh,
          tvl: highest.totalAssets,
        },
        borrowVault: {
          address: lowest.address,
          name: lowest.name,
          borrowApyPct: lowest.interestRatePct,
          supplyApyPct: supplyApyLow,
          tvl: lowest.totalAssets,
        },
        spreadPct,
        estimatedProfitUsd,
        collateralFactorPct: 80, // assumed — not verified
        totalLiquidityUsd,
        borrowable,
        monitoringOnly,
        ts: Date.now(),
      });
    }

    alerts.sort((a, b) => (b.depositVault.borrowApyPct - b.borrowVault.borrowApyPct) - (a.depositVault.borrowApyPct - a.borrowVault.borrowApyPct));
    return alerts;
  }

  /** Get all vaults for diagnostics/CLI */
  async getAllVaults(): Promise<EulerVaultInfo[]> {
    return this.euler.getAllVaults();
  }
}

