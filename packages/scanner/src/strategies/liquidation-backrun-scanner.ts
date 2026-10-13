/**
 * LiquidationBackrunScanner — detects HL liquidation cascades and squeeze opportunities.
 *
 * Monitors 234+ HL perp markets for:
 *   - Extreme funding rates (>100%/yr = cascade risk)
 *   - Funding squeeze prediction (>500%/yr = imminent cascade)
 *   - Liquidator profit potential (5% of OI at risk)
 *
 * Strategy:
 *   - When funding is extreme → positions under pressure → liquidations imminent
 *   - Backrun liquidation events to capture price dislocation
 *   - Expected: $50-500 per liquidation, 10-50/day during volatile markets
 *
 * MIGRATED FROM scripts-explore:
 *   - hl-liquidation-hunter.mts
 *   - liquidation-detector.mts (concepts merged)
 *   - liquidation-monitor.mts (concepts merged)
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';

const HL_API = 'https://api.hyperliquid.xyz/info';

export interface LiquidationParams {
  /** Min funding rate (annualized %) to flag as cascade risk (default 100%) */
  cascadeFundingThreshold: number;
  /** Min funding rate to flag as squeeze imminent (default 500%) */
  squeezeFundingThreshold: number;
  /** Min OI to consider (default $500k) */
  minOiUsd: number;
}

export interface LiquidationAlert {
  coin: string;
  fundingAnnual: number;
  oi: number;
  direction: 'LONG_SQUEEZE' | 'SHORT_SQUEEZE';
  severity: 'SQUEEZE_IMMINENT' | 'CASCADE_RISK' | 'MONITOR';
  liquidatorProfitPotential: number;  // 5% of OI
  ts: number;
}

export class LiquidationBackrunScanner implements Strategy {
  readonly id = 'liquidation_backrun';
  readonly landscape = 'G_mev' as const;  // liquidation backrunning = MEV

  constructor(private params: LiquidationParams) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 50,
      maxSizeUsd: 10_000,
      maxConcurrent: 3,
      cooldownMs: 5 * 60_000,
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<LiquidationAlert[]> {
    const alerts: LiquidationAlert[] = [];

    try {
      const res = await fetch(HL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      });
      const r = await res.json() as any;

      const universe = r?.[0]?.universe || [];
      const ctxs = r?.[1] || [];

      for (let i = 0; i < universe.length; i++) {
        const u = universe[i];
        const ctx = ctxs[i];
        if (!u || !ctx || u.name.startsWith('@')) continue;

        const fundingHourly = parseFloat(ctx.funding) || 0;
        const fundingAnnual = fundingHourly * 24 * 365 * 100;
        const absFunding = Math.abs(fundingAnnual);

        if (absFunding < this.params.cascadeFundingThreshold) continue;

        const oi = parseFloat(ctx.openInterest) * parseFloat(ctx.markPx);
        if (oi < this.params.minOiUsd) continue;

        const direction = fundingAnnual > 0 ? 'SHORT_SQUEEZE' : 'LONG_SQUEEZE';

        let severity: 'SQUEEZE_IMMINENT' | 'CASCADE_RISK' | 'MONITOR' = 'MONITOR';
        if (absFunding >= this.params.squeezeFundingThreshold) {
          severity = 'SQUEEZE_IMMINENT';
        } else if (absFunding >= this.params.cascadeFundingThreshold) {
          severity = 'CASCADE_RISK';
        }

        alerts.push({
          coin: u.name,
          fundingAnnual,
          oi,
          direction,
          severity,
          liquidatorProfitPotential: oi * 0.05,  // 5% of OI
          ts: Date.now(),
        });
      }

      alerts.sort((a, b) => Math.abs(b.fundingAnnual) - Math.abs(a.fundingAnnual));

    } catch (e: any) {
      console.warn(`[liquidation_backrun] scan failed: ${e.message}`);
    }

    return alerts;
  }
}
