/**
 * CexLikeDexPriceArbStrategy — price spread between CEX-like DEX perp venues.
 *
 * CORRECTED ECONOMICS (EM-STRAT-003, hardened EM-STRAT-004, finalized EM-STRAT-005):
 *   Perp-versus-perp price spreads are NOT instantly captureable profits.
 *   This is a CONVERGENCE TRADE whose realized result depends on:
 *   - Close-out spread at exit (may differ from entry spread)
 *   - Venue-specific trading fees (per leg, with verified schedule)
 *   - Funding rate differential during the hold period (units + sign)
 *   - Margin requirements and liquidation risk
 *   - Explicit holding-period assumption (funding accrues per hour)
 *   - Position/margin costs
 *
 *   EM-STRAT-005 §1: A verified net-profit estimate requires ALL of the
 *   above inputs to be available. The previous code equated
 *   `fundingSpread1h !== null` with "complete economics" and computed
 *   `estimatedProfitUsd = (|effectiveSpreadPct| - 0.04%) × maxSizeUsd`
 *   using an UNVERIFIED 4 bps round-trip fee assumption that did not
 *   actually incorporate the funding rate into the profit estimate.
 *
 *   Until a complete convergence model is implemented — including
 *   entry/exit assumptions, venue-specific fee schedules, funding rates
 *   with validated units and sign, an explicit holding-period assumption,
 *   and position/margin costs — this scanner keeps every alert
 *   MONITORING-ONLY:
 *     - estimatedProfitUsd = null
 *     - actionable = false
 *     - monitoringOnly = true
 *
 *   The observed spread is reported as a SIGNAL. Presenters MUST NOT
 *   present it as an actionable opportunity or display a numerical
 *   net-profit figure.
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
  /** Funding spread 1h (if available). Diagnostic only — NOT incorporated into a profit estimate. */
  fundingSpread1h: number | null;
  longOiUsd: number;
  shortOiUsd: number;
  /**
   * Estimated net profit in USD. ALWAYS null in the current implementation
   * (EM-STRAT-005 §1) — a verified convergence-economics model is not yet
   * implemented. Presenters MUST display this as 'UNAVAILABLE', not 0.
   */
  estimatedProfitUsd: number | null;
  /**
   * Whether all economic inputs were available for a verified profit
   * estimate. ALWAYS false in the current implementation (EM-STRAT-005 §1).
   * `fundingSpread1h !== null` does NOT by itself make economics complete.
   */
  economicsComplete: boolean;
  vooiExecutable: boolean;
  /**
   * CONVERGENCE TRADE: Result depends on close-out spread, fees, funding,
   * margin, and time. No verified profit estimate is produced.
   */
  tradeType: 'convergence';
  /**
   * Whether the alert is actionable. ALWAYS false in the current
   * implementation (EM-STRAT-005 §1) — the convergence-economics model
   * is incomplete. Presenters MUST downgrade severity to 'info' (or skip).
   */
  actionable: boolean;
  /**
   * MONITORING ONLY: this alert is observed for informational purposes.
   * Must NOT be presented as an actionable opportunity.
   * (EM-STRAT-005 §1)
   */
  monitoringOnly: boolean;
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

        // Funding spread — may be null if not provided. Diagnostic only.
        // EM-STRAT-005 §1: presence of this field does NOT make economics
        // complete. A verified convergence model requires entry/exit
        // assumptions, venue-specific fee schedules, funding rates with
        // validated units and sign, an explicit holding-period assumption,
        // and position/margin costs.
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

        // ── EM-STRAT-005 §1: Monitoring-only convergence signal ─────────
        // A verified net-profit estimate requires a complete convergence
        // model (see module docstring). Until that model is implemented,
        // every alert is monitoring-only with null economics:
        //   - estimatedProfitUsd = null
        //   - economicsComplete = false
        //   - actionable = false
        //   - monitoringOnly = true
        //
        // The previous code computed `estimatedProfitUsd` using an
        // unverified 4 bps round-trip fee assumption and did not actually
        // incorporate the funding rate into the profit estimate. We do
        // NOT invent missing inputs to make tests pass.
        const estimatedProfitUsd: number | null = null;
        const economicsComplete = false;
        const actionable = false;
        const monitoringOnly = true;

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
          actionable,
          monitoringOnly,
          ts: Date.now(),
        });
      }
    }

    alerts.sort((a, b) => Math.abs(b.effectiveSpreadPct) - Math.abs(a.effectiveSpreadPct));
    return alerts;
  }
}
