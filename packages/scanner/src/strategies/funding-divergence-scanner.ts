/**
 * FundingDivergenceScanner — detects cross-venue funding rate divergences.
 *
 * EM-STRAT-014-E11 items 4 + 5:
 *   - Item 4: venue/asset identity canonicalized via the table-driven alias
 *     map in lib/venue-asset-aliases.ts. Unmapped identities are NOT guessed
 *     into a match.
 *   - Item 5:
 *     - VOOI sampling ordered by funding spread (was: priceSpread).
 *     - Real OI derived from payload fields; `oi: null` when missing.
 *     - Null OI excluded from EXTREME_FUNDING.
 *     - HL `res.ok` checked.
 *     - VOOI `{items: []}` failure surfaced as a counted degradation marker,
 *       not a silent empty-array fallback.
 *     - scanTs (scan clock) distinguished from venueTs (null — APIs provide
 *       no verified venue observation timestamp).
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';
import { canonAsset, canonVenue } from '../lib/venue-asset-aliases.js';

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
  /** EM-STRAT-014-E11 item 5: null when OI is missing/unverifiable. */
  oi: number | null;
  /** EM-STRAT-014-E11 item 5: scan clock — when the scan ran. */
  scanTs: number;
  /** EM-STRAT-014-E11 item 5: venue observation time — null (APIs provide none). */
  venueTs: number | null;
  /** @deprecated Use scanTs / venueTs. */
  ts: number;
}

/**
 * EM-STRAT-014-E11 item 5: degradation markers for partial API failures.
 * The scan returns alerts AND a degradation object so the caller can surface
 * data-quality issues rather than silently treating an empty result as
 * "no opportunities."
 */
export interface FundingDegradation {
  /** HL metaAndAssetCtxs fetch failed (non-ok or network error). */
  hlFailed: boolean;
  /** VOOI arbitrage-scanner fetch failed (non-ok or returned {items:[]}). */
  vooiFailed: boolean;
  /** Count of HL entries skipped due to missing/invalid funding or OI. */
  hlSkipped: number;
  /** Count of VOOI entries skipped due to missing funding. */
  vooiSkipped: number;
}

export interface FundingDivergenceScanResult {
  alerts: FundingDivergenceAlert[];
  degradation: FundingDegradation;
}

/**
 * EM-STRAT-014-E11-Cluster2-R1: production-visible degradation summary.
 *
 * The runner MUST log this on every scan — including when alerts are empty —
 * so that "APIs failed / rows were skipped" is never confusable with
 * "no opportunities". Pure function, exported for offline deterministic
 * testing of exactly what production logs.
 */
export function formatFundingDegradation(d: FundingDegradation): string {
  const flags: string[] = [];
  if (d.hlFailed) flags.push('HL_FETCH_FAILED');
  if (d.vooiFailed) flags.push('VOOI_FETCH_FAILED');
  const parts = [
    `hlFailed=${d.hlFailed}`,
    `vooiFailed=${d.vooiFailed}`,
    `hlSkipped=${d.hlSkipped}`,
    `vooiSkipped=${d.vooiSkipped}`,
  ];
  if (flags.length > 0) {
    return `[funding_divergence] DEGRADED ${flags.join(',')} | ${parts.join(' ')}`;
  }
  return `[funding_divergence] ok | ${parts.join(' ')}`;
}

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

  /**
   * EM-STRAT-014-E11 item 5: scan() now returns FundingDivergenceAlert[]
   * for Strategy-interface compatibility. Use scanWithDegradation() to get
   * the degradation markers.
   */
  async scan(): Promise<FundingDivergenceAlert[]> {
    return (await this.scanWithDegradation()).alerts;
  }

  async scanWithDegradation(): Promise<FundingDivergenceScanResult> {
    const fetchFn = this.deps.fetchImpl ?? fetch;
    const now = (this.deps.now ?? Date.now)();
    const scanTs = now;
    const degradation: FundingDegradation = { hlFailed: false, vooiFailed: false, hlSkipped: 0, vooiSkipped: 0 };
    const alerts: FundingDivergenceAlert[] = [];

    // ── Item 4: canonicalized funding map: canonAsset → [{ canonVenue, fundingAnnual, oi }] ──
    const fundingMap: Record<string, Array<{ venue: string; fundingAnnual: number; oi: number | null }>> = {};

    // ── HL data (item 5: check res.ok) ────────────────────────────────
    let hlData: any = null;
    try {
      const hlRes = await fetchFn(HL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      });
      if (!hlRes.ok) {
        degradation.hlFailed = true;
        console.warn(`[funding_divergence] HL API non-ok: ${hlRes.status}`);
      } else {
        hlData = await hlRes.json() as any;
      }
    } catch (e: any) {
      degradation.hlFailed = true;
      console.warn(`[funding_divergence] HL fetch failed: ${e.message}`);
    }

    if (hlData) {
      const universe = hlData?.[0]?.universe || [];
      const ctxs = hlData?.[1] || [];
      for (let i = 0; i < universe.length; i++) {
        const u = universe[i];
        const ctx = ctxs[i];
        if (!u || !ctx || u.name.startsWith('@')) continue;

        const fundingHourly = parseFloat(ctx.funding);
        // Item 5: reject NaN funding instead of `|| 0`
        if (!isFinite(fundingHourly)) { degradation.hlSkipped++; continue; }
        const fundingAnnual = fundingHourly * 24 * 365 * 100;
        if (Math.abs(fundingAnnual) < 5) continue;

        // Item 5: derive real OI; null when missing/invalid
        const oi = parseFloat(ctx.openInterest);
        const markPx = parseFloat(ctx.markPx);
        const oiUsd = (isFinite(oi) && isFinite(markPx) && oi > 0 && markPx > 0) ? oi * markPx : null;

        // Item 4: canonicalize asset identity
        const canonA = canonAsset(u.name);
        if (!fundingMap[canonA]) fundingMap[canonA] = [];
        fundingMap[canonA].push({ venue: 'Hyperliquid', fundingAnnual, oi: oiUsd });
      }
    }

    // ── VOOI data (item 5: order by funding spread; res.ok check; degradation) ──
    let vooiData: any = null;
    try {
      // Item 5: orderBy=fundingSpread1h (was: priceSpread)
      const vooiRes = await fetchFn(`${VOI_API}/arbitrage-scanner?limit=100&orderBy=fundingSpread1h&orderDirection=desc`);
      if (!vooiRes.ok) {
        degradation.vooiFailed = true;
        console.warn(`[funding_divergence] VOOI API non-ok: ${vooiRes.status}`);
      } else {
        vooiData = await vooiRes.json() as any;
        // Item 5: silent {items:[]} failure → degradation marker
        if (!vooiData?.items || vooiData.items.length === 0) {
          degradation.vooiFailed = true;
        }
      }
    } catch (e: any) {
      degradation.vooiFailed = true;
      console.warn(`[funding_divergence] VOOI fetch failed: ${e.message}`);
    }

    if (vooiData?.items) {
      // EM-STRAT-014-E11-Cluster2-R1: OI is derived from the ACTUAL VOOI
      // response fields — `openInterest × price` (both provider fields per
      // the VooiArbitragePair schema) — with strict finite-positive
      // validation on each input and the product. Absent/invalid fields →
      // null (excluded from EXTREME_FUNDING downstream). A precomputed
      // `oiUsd` field is NOT part of the provider schema and is not
      // consulted.
      const parseVooiOiUsd = (leg: { openInterest?: unknown; price?: unknown }): number | null => {
        const toNum = (v: unknown): number =>
          typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? parseFloat(v) : NaN;
        const oi = toNum(leg.openInterest);
        const px = toNum(leg.price);
        if (!Number.isFinite(oi) || !Number.isFinite(px) || oi <= 0 || px <= 0) return null;
        const product = oi * px;
        return Number.isFinite(product) && product > 0 ? product : null;
      };
      for (const item of vooiData.items) {
        // Item 4: canonicalize asset identity
        const canonA = canonAsset(item.asset || '');
        if (!canonA) { degradation.vooiSkipped++; continue; }
        for (const p of (item.pairs || [])) {
          if (p.long?.exchange) {
            const fr = p.long.fundingRate;
            // Item 5: reject NaN funding instead of `|| 0`
            if (typeof fr !== 'number' || !isFinite(fr)) { degradation.vooiSkipped++; continue; }
            const longFunding = fr * 24 * 365 * 100;
            if (Math.abs(longFunding) > 5) {
              if (!fundingMap[canonA]) fundingMap[canonA] = [];
              // Cluster2-R1: OI = openInterest × price (strict); null if invalid.
              const vooiOi = parseVooiOiUsd(p.long);
              fundingMap[canonA].push({ venue: canonVenue(p.long.exchange), fundingAnnual: longFunding, oi: vooiOi });
            }
          }
          if (p.short?.exchange) {
            const fr = p.short.fundingRate;
            if (typeof fr !== 'number' || !isFinite(fr)) { degradation.vooiSkipped++; continue; }
            const shortFunding = fr * 24 * 365 * 100;
            if (Math.abs(shortFunding) > 5) {
              if (!fundingMap[canonA]) fundingMap[canonA] = [];
              // Cluster2-R1: OI = openInterest × price (strict); null if invalid.
              const vooiOi = parseVooiOiUsd(p.short);
              fundingMap[canonA].push({ venue: canonVenue(p.short.exchange), fundingAnnual: shortFunding, oi: vooiOi });
            }
          }
        }
      }
    }

    // ── Find divergences ──────────────────────────────────────────────
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
          oi: highest.oi, // may be null
          scanTs,
          venueTs: null,
          ts: scanTs,
        });
      }
    }

    // ── Find extreme funding (item 5: exclude null OI) ────────────────
    for (const [asset, venues] of Object.entries(fundingMap)) {
      for (const v of venues) {
        if (Math.abs(v.fundingAnnual) >= this.params.extremeFundingThreshold) {
          // Item 5: null OI excluded from EXTREME_FUNDING
          if (v.oi === null) continue;
          if (v.oi < this.params.minExtremeOiUsd) continue;
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
            venueTs: null,
            ts: scanTs,
          });
        }
      }
    }

    alerts.sort((a, b) => b.divergence - a.divergence);
    return { alerts, degradation };
  }
}
