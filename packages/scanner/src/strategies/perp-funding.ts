/**
 * PerpFundingStrategy — cross-venue funding-rate arbitrage.
 *
 * Pipeline:
 *   1. Pull live funding rates from Sharpe.ai /arbitrage/cross-exchange
 *      (32 venues, fee-adjusted netApr).
 *   2. Cross-validate top rows against VOOI /arbitrage-scanner
 *      (execution-aware priceSpreadAtSize).
 *   3. If both agree spread > threshold AND legs are on VOOI-supported venues:
 *      fire Telegram alert.
 *   4. (Future) Once apiToken configured: POST /arbitrage-orders via VOOI.
 */

import type { Strategy, DataPoint, TradeOrder, RiskParams } from '@edge/types';
import { SharpeClient } from '@edge/sharpe-client';
import { VooiClient, type VooiArbitragePair } from '@edge/vooi-client';

export interface PerpFundingParams {
  minSpreadApr: number;          // 0.08 = 8% APR
  longVenues: string[];          // ['pacifica', 'paradex']
  shortVenues: string[];         // ['hyperliquid', 'dydx']
  useVooiExecutor: boolean;
  vooiVenueSet: string[];        // venues we can actually trade via VOOI
}

export interface PerpFundingAlert {
  asset: string;
  longVenue: string;
  shortVenue: string;
  longFundingApr: number;
  shortFundingApr: number;
  spreadApr: number;
  netApr: number;                // after fees
  longOiUsd: number;
  shortOiUsd: number;
  priceSpreadPct: number;        // from VOOI (execution-aware)
  confidence: number;            // 0..1, from cross-validation
  source: 'sharpe+vooi' | 'sharpe' | 'vooi';
  vooiExecutable: boolean;       // true if both legs on VOOI venue set
}

export class PerpFundingStrategy implements Strategy {
  readonly id = 'perp_funding';
  readonly landscape = 'F_perps_funding' as const;

  constructor(
    private sharpe: SharpeClient,
    private vooi: VooiClient,
    private params: PerpFundingParams,
  ) {}

  subscribesTo(): string[] {
    // Pull-based strategy — no subscriptions; scanner calls evaluate() on timer.
    return [];
  }

  evaluate(_data: DataPoint): TradeOrder[] | null {
    // This strategy is pull-based; see scan() below.
    return null;
  }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 5,
      maxSizeUsd: 4000,
      maxConcurrent: 2,
      cooldownMs: 60_000,
      gasPriceCapMultiplier: 3,
    };
  }

  /** Pull-based scan — called by the runner on a timer. */
  async scan(): Promise<PerpFundingAlert[]> {
    // 1. Pull Sharpe cross-exchange arbs
    const sharpeResp = await this.sharpe.crossExchangeFunding({
      minApr: this.params.minSpreadApr,
      minOiUsd: 50_000,
      assetClass: 'crypto',
    });

    // 2. Pull VOOI scanner (no auth needed)
    let vooiPairs: VooiArbitragePair[] = [];
    try {
      const vooiResp = await this.vooi.scanArbitrage({
        minFundingSpread: 0,
        minOpenInterest: 50_000,
        notionalUsd: 5000,
        orderBy: 'fundingSpread1h',
        orderDirection: 'desc',
        limit: 100,
      });
      vooiPairs = vooiResp.items.flatMap(item =>
        item.pairs.map(p => ({ ...p, asset: item.asset }))
      );
    } catch (err) {
      console.warn('VOOI scan failed (continuing with Sharpe only):', err);
    }

    // 3. Build VOOI lookup by (asset, longExchange, shortExchange)
    const vooiMap = new Map<string, VooiArbitragePair>();
    for (const p of vooiPairs) {
      const key = `${p.asset}|${p.long.exchange}|${p.short.exchange}`;
      vooiMap.set(key, p);
      // Also store reverse direction
      const revKey = `${p.asset}|${p.short.exchange}|${p.long.exchange}`;
      vooiMap.set(revKey, { ...p, long: p.short, short: p.long });
    }

    // 4. For each Sharpe row, try to find a matching VOOI pair
    const alerts: PerpFundingAlert[] = [];
    for (const row of sharpeResp.data) {
      const asset = (row.coin || row.asset || row.symbol || '').toUpperCase();
      if (!asset) continue;

      const longVenue = (row.longExchange || '') ;
      const shortVenue = (row.shortExchange || '');
      if (!longVenue || !shortVenue) continue;

      const spreadApr = row.netApr ?? row.grossApr ?? 0;
      if (spreadApr < this.params.minSpreadApr) continue;

      // Determine if this arb is executable via VOOI (both legs on VOOI venue set)
      const vooiLongOk  = this.params.vooiVenueSet.includes(longVenue.toLowerCase());
      const vooiShortOk = this.params.vooiVenueSet.includes(shortVenue.toLowerCase());
      const vooiExecutable = vooiLongOk && vooiShortOk;

      // Cross-validate with VOOI
      const vooiKey = `${asset}|${longVenue}|${shortVenue}`;
      const vooiPair = vooiMap.get(vooiKey);

      let confidence = 0.5;
      let priceSpreadPct = 0;
      let source: PerpFundingAlert['source'] = 'sharpe';

      if (vooiPair) {
        confidence = 0.9;
        priceSpreadPct = (vooiPair.priceSpreadAtSize ?? vooiPair.priceSpread ?? 0) * 100;
        source = 'sharpe+vooi';
        // If VOOI price spread is too wide, we lose on entry/exit
        if (Math.abs(priceSpreadPct) > 1.0) {
          continue;  // skip — price spread eats the funding spread
        }
      } else if (vooiExecutable) {
        // VOOI can execute but no live pair quote — still worth alerting
        confidence = 0.7;
        source = 'sharpe';
      } else {
        // Not VOOI-executable — alert anyway so principal sees it, but mark lower confidence
        confidence = 0.4;
        source = 'sharpe';
      }

      alerts.push({
        asset,
        longVenue,
        shortVenue,
        longFundingApr: 0,    // not directly from Sharpe row
        shortFundingApr: 0,
        spreadApr,
        netApr: spreadApr,    // Sharpe netApr already fee-adjusted
        longOiUsd: row.longOiUsd ?? 0,
        shortOiUsd: row.shortOiUsd ?? 0,
        priceSpreadPct,
        confidence,
        source,
        vooiExecutable,
      });
    }

    // Also surface VOOI-only opportunities (not in Sharpe top results)
    if (vooiPairs.length > 0) {
      const sharpeAssets = new Set(sharpeResp.data.map(r => (r.coin || r.asset || r.symbol || '').toUpperCase()));
      for (const p of vooiPairs) {
        if (!sharpeAssets.has(p.asset.toUpperCase())) {
          // VOOI fundingSpread1h is decimal; annualise: 24 × 365 = 8760
          const fundingSpread1h = p.fundingSpread1h;
          const spreadApr = fundingSpread1h * 24 * 365 * 100;
          if (spreadApr < this.params.minSpreadApr) continue;
          // No venue filter — VOOI already guarantees both legs are on supported venues
          const longFundingRate = Number(p.long.fundingRate);
          const shortFundingRate = Number(p.short.fundingRate);
          alerts.push({
            asset: p.asset,
            longVenue: p.long.exchange,
            shortVenue: p.short.exchange,
            longFundingApr: longFundingRate * 24 * 365 * 100,
            shortFundingApr: shortFundingRate * 24 * 365 * 100,
            spreadApr,
            netApr: spreadApr,
            longOiUsd: Number(p.long.openInterest) * Number(p.long.price),
            shortOiUsd: Number(p.short.openInterest) * Number(p.short.price),
            priceSpreadPct: (p.priceSpreadAtSize ?? p.priceSpread ?? 0) * 100,
            confidence: 0.7,
            source: 'vooi',
            vooiExecutable: true,   // VOOI pair → both legs are on VOOI venues by definition
          });
        }
      }
    }

    // Sort by net APR descending
    alerts.sort((a, b) => b.netApr - a.netApr);
    return alerts;
  }
}
