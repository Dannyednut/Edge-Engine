/**
 * LstYieldComparisonScanner — compare yields across all HL LST variants.
 *
 * DISCOVERY (Oct 13 2026):
 *   32 Pendle LST markets on Hyperliquid (chain 999) with different yields:
 *     kHYPE: 2.24% (multiple maturities, $648M + $49.7M + $33.6M TVL)
 *     vkHYPE: 6.32% ($223M TVL) — HIGHEST yield
 *     stHYPE: 1.98-2.56% (multiple maturities)
 *     beHYPE: 2.21% ($4.1M TVL)
 *     liquidHYPE: 2.28-2.71% ($30.8M TVL)
 *     haHYPE: 2.91-4.79% (variable)
 *     xHYPE: 3.52-4.98%
 *     dnHYPE: 10.46% (high yield, low TVL)
 *
 * ARB STRATEGY:
 *   If two LSTs track the same underlying (HYPE) but have different yields,
 *   hold the higher-yield LST to capture the spread.
 *   Example: vkHYPE (6.32%) vs kHYPE (2.24%) = 4.08% spread
 *   On $5,000: $204/year extra yield, risk-free (same underlying HYPE)
 *
 *   Also: PT implied yields vs floating yields:
 *     stHYPE PT: 17.96% implied vs 2.56% floating = 15.4% spread
 *     haHYPE PT: 43.52% implied vs 4.79% floating = 38.7% spread
 *   These are potentially stale/illiquid but worth monitoring.
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';
import { PendleClient } from '../lib/pendle-client.js';

export interface LstYieldComparisonParams {
  /** Min yield spread between LSTs to alert (default 1%) */
  minYieldSpreadPct: number;
  /** Min TVL for a market to be considered (default $1M) */
  minTvlUsd: number;
}

export interface LstYieldAlert {
  lst: string;
  expiry: string;
  tvlUsd: number;
  underlyingApy: number;      // floating yield
  impliedApy: number;         // PT fixed yield (0 if illiquid)
  bestApy: number;            // max(underlying, implied)
  vsKhypeSpread: number;      // yield - kHYPE yield (positive = better than kHYPE)
  ts: number;
}

export class LstYieldComparisonScanner implements Strategy {
  readonly id = 'lst_yield_comparison';
  readonly landscape = 'F_perps_funding' as const;

  private pendle: PendleClient;
  private khypeYield = 0; // baseline yield for comparison

  constructor(private params: LstYieldComparisonParams) {
    this.pendle = new PendleClient();
  }

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 10,
      maxSizeUsd: 5000,
      maxConcurrent: 3,
      cooldownMs: 5 * 60_000,
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<LstYieldAlert[]> {
    const alerts: LstYieldAlert[] = [];

    // Get all HL LST markets from Pendle
    const markets = await this.pendle.getHlLstMarkets();

    // Find kHYPE yield as baseline
    const khypeMarkets = markets.filter(m => m.name === 'kHYPE');
    if (khypeMarkets.length > 0) {
      this.khypeYield = Math.max(...khypeMarkets.map(m => m.details.underlyingApy));
    }

    // Compare each LST's yield
    for (const m of markets) {
      const tvl = m.details.totalTvl;
      if (tvl < this.params.minTvlUsd) continue;

      const underlying = m.details.underlyingApy * 100;
      const implied = m.details.impliedApy > 0 && m.details.impliedApy < 1
        ? m.details.impliedApy * 100
        : 0; // filter out -100% (stale) and >100% (suspicious)
      const bestApy = Math.max(underlying, implied);
      const vsKhypeSpread = bestApy - (this.khypeYield * 100);

      if (Math.abs(vsKhypeSpread) < this.params.minYieldSpreadPct) continue;

      alerts.push({
        lst: m.name,
        expiry: m.expiry?.slice(0, 10) || 'unknown',
        tvlUsd: tvl,
        underlyingApy: underlying,
        impliedApy: implied,
        bestApy,
        vsKhypeSpread,
        ts: Date.now(),
      });
    }

    // Sort by yield spread (highest extra yield vs kHYPE first)
    alerts.sort((a, b) => b.vsKhypeSpread - a.vsKhypeSpread);
    return alerts;
  }
}
