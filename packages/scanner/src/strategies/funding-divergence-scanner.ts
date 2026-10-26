/**
 * FundingDivergenceScanner — detects cross-venue funding rate divergences.
 *
 * When the same asset has different funding rates across venues:
 *   - Short on high-funding venue (collect positive funding)
 *   - Long on low-funding venue (pay less or collect negative funding)
 *   - Net delta = 0, capture the spread
 *
 * Also detects extreme funding on individual venues for single-leg harvest.
 *
 * MIGRATED FROM scripts-explore:
 *   - funding-divergence-realtime.mts
 *
 * ─── EM-STRAT-014-E11 item 1 — timestamp integrity ─────────────────────
 * The alert carries TWO timestamps:
 *   - scanTs: when the scan ran (Date.now() at scan start). This is the
 *     ONLY fabricated timestamp and is explicitly labeled as scan time.
 *   - venueTs: the venue observation time, if the API provides one. null
 *     when the API does not provide a verified observation timestamp.
 *     NEVER fabricated with Date.now(). The previous implementation used a
 *     single `ts: Date.now()` that conflated scan time with venue
 *     observation time — downstream freshness checks could mistake a stale
 *     venue reading for a fresh one.
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';

const HL_API = 'https://api.hyperliquid.xyz/info';
const VOI_API = 'https://perps-api.vooi.io';

export interface FundingDivergenceParams {
  /** Min divergence (spread) to alert (default 20%/yr) */
  minDivergencePct: number;
  /** Min OI for extreme funding alerts (default $1M) */
  minExtremeOiUsd: number;
  /** Min funding rate for extreme alert (default 50%/yr) */
  extremeFundingThreshold: number;
}

export interface FundingDivergenceAlert {
  asset: string;
  longVenue: string;
  shortVenue: string;
  longFunding: number;
  shortFunding: number;
  divergence: number;
  dailyProfitOn5k: number;
  type: 'DIVERGENCE' | 'EXTREME_FUNDING';
  direction: 'SHORT_HARVEST' | 'LONG_HARVEST' | 'DIVERGENCE';
  oi: number;
  /**
   * EM-STRAT-014-E11 item 1: when the scan ran (epoch ms). This is the
   * scan-process clock, NOT the venue observation time.
   */
  scanTs: number;
  /**
   * EM-STRAT-014-E11 item 1: venue observation time (epoch ms), if the API
   * provides one. null when the API does not provide a verified observation
   * timestamp — NEVER fabricated with Date.now(). Downstream freshness
   * checks must treat null as "unverified" rather than "fresh".
   */
  venueTs: number | null;
  /**
   * @deprecated Use scanTs / venueTs. Kept for presenter compatibility;
   * equals scanTs.
   */
  ts: number;
}

/** Injectable dependencies for deterministic offline testing. */
export interface FundingDivergenceDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class FundingDivergenceScanner implements Strategy {
  readonly id = 'funding_divergence';
  readonly landscape = 'F_perps_funding' as const;

  constructor(private params: FundingDivergenceParams, private deps: FundingDivergenceDeps = {}) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 10,
      maxSizeUsd: 10_000,
      maxConcurrent: 5,
      cooldownMs: 10 * 60_000,
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<FundingDivergenceAlert[]> {
    const alerts: FundingDivergenceAlert[] = [];
    const fetchFn = this.deps.fetchImpl ?? fetch;
    const now = (this.deps.now ?? Date.now)();
    const scanTs = now;

    try {
      // Fetch HL funding rates
      const hlRes = await fetchFn(HL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      });
      const hlData = await hlRes.json() as any;

      // Fetch VOOI data
      const vooiRes = await fetchFn(`${VOI_API}/arbitrage-scanner?limit=100&orderBy=priceSpread&orderDirection=desc`);
      const vooiData = vooiRes.ok ? await vooiRes.json() as any : { items: [] };

      // Build funding map: asset → [{ venue, fundingAnnual, oi }]
      const fundingMap: Record<string, Array<{ venue: string; fundingAnnual: number; oi: number }>> = {};

      // HL data
      const universe = hlData?.[0]?.universe || [];
      const ctxs = hlData?.[1] || [];
      for (let i = 0; i < universe.length; i++) {
        const u = universe[i];
        const ctx = ctxs[i];
        if (!u || !ctx || u.name.startsWith('@')) continue;
        const fundingHourly = parseFloat(ctx.funding) || 0;
        const fundingAnnual = fundingHourly * 24 * 365 * 100;
        if (Math.abs(fundingAnnual) < 5) continue;
        const oi = parseFloat(ctx.openInterest) * parseFloat(ctx.markPx);
        if (!fundingMap[u.name]) fundingMap[u.name] = [];
        fundingMap[u.name].push({ venue: 'Hyperliquid', fundingAnnual, oi });
      }

      // VOOI data (per-exchange funding)
      for (const item of (vooiData?.items || [])) {
        for (const p of (item.pairs || [])) {
          if (p.long?.exchange) {
            const longFunding = (p.long.fundingRate || 0) * 24 * 365 * 100;
            if (Math.abs(longFunding) > 5) {
              if (!fundingMap[item.asset]) fundingMap[item.asset] = [];
              fundingMap[item.asset].push({ venue: p.long.exchange, fundingAnnual: longFunding, oi: 0 });
            }
          }
          if (p.short?.exchange) {
            const shortFunding = (p.short.fundingRate || 0) * 24 * 365 * 100;
            if (Math.abs(shortFunding) > 5) {
              if (!fundingMap[item.asset]) fundingMap[item.asset] = [];
              fundingMap[item.asset].push({ venue: p.short.exchange, fundingAnnual: shortFunding, oi: 0 });
            }
          }
        }
      }

      // Find divergences
      for (const [asset, venues] of Object.entries(fundingMap)) {
        if (venues.length < 2) continue;
        const sorted = [...venues].sort((a, b) => b.fundingAnnual - a.fundingAnnual);
        const highest = sorted[0];
        const lowest = sorted[sorted.length - 1];

        const divergence = highest.fundingAnnual - lowest.fundingAnnual;
        if (divergence >= this.params.minDivergencePct) {
          alerts.push({
            asset,
            longVenue: lowest.venue,
            shortVenue: highest.venue,
            longFunding: lowest.fundingAnnual,
            shortFunding: highest.fundingAnnual,
            divergence,
            dailyProfitOn5k: 5000 * divergence / 100 / 365,
            type: 'DIVERGENCE',
            direction: 'DIVERGENCE',
            oi: highest.oi,
            scanTs,
            venueTs: null, // EM-STRAT-014-E11 item 1: APIs provide no verified venue observation timestamp
            ts: scanTs,
          });
        }
      }

      // Find extreme funding (single venue)
      for (const [asset, venues] of Object.entries(fundingMap)) {
        for (const v of venues) {
          if (Math.abs(v.fundingAnnual) >= this.params.extremeFundingThreshold && v.oi >= this.params.minExtremeOiUsd) {
            alerts.push({
              asset,
              longVenue: v.fundingAnnual < 0 ? v.venue : '',
              shortVenue: v.fundingAnnual > 0 ? v.venue : '',
              longFunding: v.fundingAnnual < 0 ? v.fundingAnnual : 0,
              shortFunding: v.fundingAnnual > 0 ? v.fundingAnnual : 0,
              divergence: Math.abs(v.fundingAnnual),
              dailyProfitOn5k: 5000 * Math.abs(v.fundingAnnual) / 100 / 365,
              type: 'EXTREME_FUNDING',
              direction: v.fundingAnnual > 0 ? 'SHORT_HARVEST' : 'LONG_HARVEST',
              oi: v.oi,
              scanTs,
              venueTs: null, // EM-STRAT-014-E11 item 1
              ts: scanTs,
            });
          }
        }
      }

      alerts.sort((a, b) => b.divergence - a.divergence);

    } catch (e: any) {
      console.warn(`[funding_divergence] scan failed: ${e.message}`);
    }

    return alerts;
  }
}
