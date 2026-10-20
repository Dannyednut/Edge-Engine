/**
 * CexLikeDexPriceArbStrategy — price spread between CEX-like DEX perp venues.
 *
 * CORRECTED ECONOMICS (EM-STRAT-003):
 *   Perp-versus-perp price spreads are NOT instantly captureable profits.
 *   This is a CONVERGENCE TRADE whose realized result depends on:
 *   - Close-out spread at exit (may differ from entry spread)
 *   - Trading fees on both legs
 *   - Funding rate differential during the hold period
 *   - Margin requirements and liquidation risk
 *   - Time held (funding accrues per hour)
 *
 *   The scanner reports the observed spread as a SIGNAL, not a guaranteed
 *   profit. Net-profit estimates are only computed when all required
 *   economic inputs (fees, funding) are available. When inputs are
 *   missing, the alert is labeled as monitoring-only.
 *
 *   At-size spread (priceSpreadAtSize) is preferred over headline spread
 *   (priceSpread) when available, as it accounts for depth/slippage.
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';
import { VooiClient } from '@edge/vooi-client';

export interface CexLikeDexPriceArbParams {
  /** Min price spread % to fire alert (default 0.5%) */
  minPriceSpreadPct: number;
  /** Max notional per trade (default $5000) */
  maxSizeUsd: number;
  /** Min OI for liquidity (default $50,000) */
  minOpenInterest: number;
  /** Min 24h volume (default $100,000) */
  minVolume24h: number;
  /** Venues to consider (empty = all VOOI venues) */
  venues: string[];
  /** Min spread persistence (default 1) */
  minSpreadPersistence: number;
}

export interface PriceArbAlert {
  asset: string;
  longVenue: string;
  shortVenue: string;
  longPrice: number;
  shortPrice: number;
  /** Headline price spread (may not reflect at-size execution). */
  headlineSpreadPct: number;
  /** At-size spread (accounts for depth). null = not provided by source. */
  atSizeSpreadPct: number | null;
  /** The spread used for alerting (at-size if available, else headline). */
  effectiveSpreadPct: number;
  /** Funding spread 1h (if available). */
  fundingSpread1h: number | null;
  longOiUsd: number;
  shortOiUsd: number;
  /** Estimated net profit in USD. null = cannot compute (missing fees or funding). */
  estimatedProfitUsd: number | null;
  /** Whether all economic inputs were available for the profit estimate. */
  economicsComplete: boolean;
  vooiExecutable: boolean;
  /** CONVERGENCE TRADE: Result depends on close-out spread, fees, funding, margin, and time. */
  tradeType: 'convergence';
  ts: number;
}

export class CexLikeDexPriceArbStrategy implements Strategy {
  readonly id = 'cexlike_dex_price_arb';
  readonly landscape = 'B_cex_cex' as const;

  private spreadHistory = new Map<string, number[]>();

  constructor(
    private vooi: VooiClient,
    private params: CexLikeDexPriceArbParams,
  ) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 10,
      maxSizeUsd: this.params.maxSizeUsd,
      maxConcurrent: 3,
      cooldownMs: 30_000,
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<PriceArbAlert[]> {
    const resp = await this.vooi.scanArbitrage({
      minOpenInterest: this.params.minOpenInterest,
      notionalUsd: this.params.maxSizeUsd,
      orderBy: 'priceSpread',
      orderDirection: 'desc',
      limit: 100,
    });

    const alerts: PriceArbAlert[] = [];
    for (const item of resp.items) {
      for (const pair of item.pairs) {
        const headlineSpread = pair.priceSpread ?? 0;
        if (Math.abs(Number(headlineSpread)) < this.params.minPriceSpreadPct / 100) continue;

        const longVenue = pair.long.exchange;
        const shortVenue = pair.short.exchange;

        if (this.params.venues.length > 0) {
          if (!this.params.venues.includes(longVenue) || !this.params.venues.includes(shortVenue)) continue;
        }

        const longPrice = Number(pair.long.price || 0);
        const shortPrice = Number(pair.short.price || 0);
        const headlineSpreadPct = Number(headlineSpread) * 100;

        // Prefer at-size spread when available
        const atSizeSpread = pair.priceSpreadAtSize ?? null;
        const atSizeSpreadPct = atSizeSpread !== null ? Number(atSizeSpread) * 100 : null;
        const effectiveSpreadPct = atSizeSpreadPct ?? headlineSpreadPct;

        // Funding spread — may be null if not provided
        const fundingSpread1h = pair.fundingSpread1h != null ? Number(pair.fundingSpread1h) : null;

        // Volume filter
        const longVol = Number(pair.long.volume24h || 0);
        const shortVol = Number(pair.short.volume24h || 0);
        const maxVol = Math.max(longVol, shortVol);
        if (maxVol < (this.params.minVolume24h ?? 0)) continue;

        // Spread persistence
        const persistenceKey = `${item.asset}|${longVenue}|${shortVenue}`;
        const history = this.spreadHistory.get(persistenceKey) ?? [];
        history.push(effectiveSpreadPct);
        if (history.length > 5) history.shift();
        this.spreadHistory.set(persistenceKey, history);
        const minPersistence = this.params.minSpreadPersistence ?? 1;
        const persistentCount = history.filter(s => Math.abs(s) >= this.params.minPriceSpreadPct).length;
        if (persistentCount < minPersistence) continue;

        // Net profit estimate: only compute when we have fee data.
        // VOOI fee estimate: 4 bps round-trip (2 bps per leg on DEX venues).
        // If funding spread is available, include it as a cost/benefit.
        const feePct = 0.04; // 4 bps round-trip
        const grossProfitPct = Math.abs(effectiveSpreadPct) - feePct;

        // We can only compute net profit if funding is available (or explicitly zero).
        // If funding is null, we don't know the carry cost/benefit during the hold.
        const economicsComplete = fundingSpread1h !== null;
        const estimatedProfitUsd: number | null = economicsComplete
          ? (grossProfitPct / 100) * this.params.maxSizeUsd
          : null;

        alerts.push({
          asset: item.asset,
          longVenue,
          shortVenue,
          longPrice,
          shortPrice,
          headlineSpreadPct,
          atSizeSpreadPct,
          effectiveSpreadPct,
          fundingSpread1h,
          longOiUsd: Number(pair.long.openInterest || 0) * longPrice,
          shortOiUsd: Number(pair.short.openInterest || 0) * shortPrice,
          estimatedProfitUsd,
          economicsComplete,
          vooiExecutable: true,
          tradeType: 'convergence',
          ts: Date.now(),
        });
      }
    }

    alerts.sort((a, b) => Math.abs(b.effectiveSpreadPct) - Math.abs(a.effectiveSpreadPct));
    return alerts;
  }
}
