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
 *
 * E-12 (Issue #17) — APR unit + gross/net integrity:
 *   - ONE canonical internal APR unit: DECIMAL FRACTION (0.08 = 8%/yr).
 *     Sharpe netApr/grossApr are decimal fractions per the Sharpe
 *     cross-exchange API docs; `min_spread_apr` (default 0.08) is decimal.
 *     The VOOI-only branch previously multiplied by 100 (percentage
 *     points), producing 100×-inflated values that were incomparable with
 *     the threshold and with Sharpe sorting. That multiplication is
 *     REMOVED.
 *   - VOOI annualization basis: fundingSpread1h / fundingRate are HOURLY
 *     decimal rates (VOOI's own `fundingRate8h` field is defined as
 *     fundingRate × 3 — see the vooi-client schema comment), so
 *     ×24×365 is the annualization; it is an EXPLICIT ASSUMPTION recorded
 *     on every VOOI-only alert.
 *   - GROSS vs NET separation: `netApr` is populated ONLY from a verifiably
 *     sourced fee-adjusted value (the Sharpe `netApr` field). A missing
 *     netApr is NEVER silently replaced by grossApr and labeled net — the
 *     alert carries `netApr: null` + `netAprBasis: 'unavailable'` and is
 *     excluded from net-economics sorting/eligibility. VOOI-only rows have
 *     no fee model at all → always gross-indicative (netApr: null).
 *   - Fail-closed on malformed inputs: non-finite/malformed rates skip the
 *     row rather than propagating NaN into accounting-adjacent fields.
 */

import type { Strategy, DataPoint, TradeOrder, RiskParams } from '@edge/types';
import { SharpeClient } from '@edge/sharpe-client';
import { VooiClient, type VooiArbitragePair } from '@edge/vooi-client';
import { canonAsset, canonVenue } from '../lib/venue-asset-aliases.js';

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
  /** Decimal-fraction APR, gross-indicative (1h-basis annualization); 0 = not available from the provider row. */
  longFundingApr: number;
  /** Decimal-fraction APR, gross-indicative (1h-basis annualization); 0 = not available from the provider row. */
  shortFundingApr: number;
  /**
   * Indicative annualized spread, DECIMAL-FRACTION APR (E-12 canonical unit).
   * Equals the verified netApr when available, else the gross/indicative
   * spread — check `netAprBasis` before interpreting. Used only for the
   * threshold pre-filter; never presented as net.
   */
  spreadApr: number;
  /**
   * Fee-adjusted net APR, DECIMAL-FRACTION APR — ONLY when verifiably
   * sourced (Sharpe `netApr` field). null = net economics UNAVAILABLE:
   * never fabricate it from gross, and exclude the row from net-economics
   * sorting/eligibility (E-12, Issue #17).
   */
  netApr: number | null;
  /** Provenance of `netApr`. 'unavailable' rows are gross/indicative only. */
  netAprBasis: 'sharpe-net' | 'unavailable';
  longOiUsd: number;
  shortOiUsd: number;
  priceSpreadPct: number;        // from VOOI (execution-aware)
  confidence: number;            // 0..1, from cross-validation
  source: 'sharpe+vooi' | 'sharpe' | 'vooi';
  vooiExecutable: boolean;       // true if both legs on VOOI venue set
  /**
   * EM-STRAT-014-E11-Cluster1-R1: server-provided Sharpe observation
   * timestamp (epoch ms), propagated verbatim from the response meta.
   * null when the server did not provide one — NEVER fabricated with
   * Date.now(), and never inferred from local scan time.
   */
  sharpeAsOf: number | null;
  /**
   * EM-STRAT-014-E11-Cluster1-R1: explicit freshness label for the Sharpe
   * leg of this alert. 'server-asof' means the server supplied an asOf
   * timestamp (carried in sharpeAsOf); 'unknown' means the server did not,
   * so the data's freshness is UNVERIFIED. No freshness SLA is configured
   * for this provider, so no fresh/stale judgment is made — unknown stays
   * unknown. VOOI-only alerts (no Sharpe row) are always 'unknown'.
   */
  freshness: 'server-asof' | 'unknown';
  /**
   * E-12: annualization-interval assumption behind the annualized APR
   * fields of this alert. 'sharpe-row' = the value is the provider's own
   * APR (no local annualization applied). '1h-assumed' = annualized from a
   * per-hour rate with an explicit 24×365 assumption (VOOI-only rows).
   */
  annualizationBasis: 'sharpe-row' | '1h-assumed';
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

    // EM-STRAT-014-E11-Cluster1-R1: propagate the server-provided asOf
    // verbatim. Absent → null → every Sharpe-derived alert is labeled
    // freshness 'unknown'. Local scan time is NEVER substituted. A malformed
    // value (non-number / non-finite) is treated as absent (defensive at
    // the consumer even though the client already normalizes to null).
    const rawAsOf = sharpeResp.meta?.asOf;
    const sharpeAsOf: number | null =
      typeof rawAsOf === 'number' && Number.isFinite(rawAsOf) && rawAsOf > 0
        ? rawAsOf
        : null;
    const sharpeFreshness: PerpFundingAlert['freshness'] =
      sharpeAsOf === null ? 'unknown' : 'server-asof';

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

    // 3. Build VOOI lookup by (asset, longExchange, shortExchange).
    // EM-STRAT-014-E11-Cluster2-R1: BOTH sides of the perp_funding join are
    // normalized through the reviewed table-driven canonicalizer
    // (lib/venue-asset-aliases.ts) — same canonical form on insertion and
    // lookup. Case differences and approved aliases now match; UNMAPPED
    // aliases still never match by guesswork (canon* passes unknown
    // identities through unchanged; no substring matching anywhere).
    const vooiJoinKey = (asset: string, longVenue: string, shortVenue: string): string =>
      `${canonAsset(asset)}|${canonVenue(longVenue)}|${canonVenue(shortVenue)}`;
    const vooiMap = new Map<string, VooiArbitragePair>();
    for (const p of vooiPairs) {
      vooiMap.set(vooiJoinKey(p.asset, p.long.exchange, p.short.exchange), p);
      // Also store reverse direction
      vooiMap.set(vooiJoinKey(p.asset, p.short.exchange, p.long.exchange), { ...p, long: p.short, short: p.long });
    }

    // 4. For each Sharpe row, try to find a matching VOOI pair
    const alerts: PerpFundingAlert[] = [];
    for (const row of sharpeResp.data) {
      const asset = (row.coin || row.asset || row.symbol || '').toUpperCase();
      if (!asset) continue;

      const longVenue = (row.longExchange || '') ;
      const shortVenue = (row.shortExchange || '');
      if (!longVenue || !shortVenue) continue;

      // E-12: gross/net separation with fail-closed validation.
      //   netApr  — ONLY the provider's own fee-adjusted field, and only if
      //             a finite number. A missing/malformed netApr is NEVER
      //             replaced by grossApr and labeled net.
      //   grossApr — indicative, kept separate.
      //   spreadApr — the indicative spread for the threshold pre-filter:
      //             verified net when available, else gross, else the row
      //             cannot be gated (0 → fails any positive threshold).
      const rawNet = row.netApr;
      const rawGross = row.grossApr;
      const netApr: number | null =
        typeof rawNet === 'number' && Number.isFinite(rawNet) ? rawNet : null;
      const grossApr: number | null =
        typeof rawGross === 'number' && Number.isFinite(rawGross) ? rawGross : null;
      const spreadApr = netApr ?? grossApr ?? 0;
      if (spreadApr < this.params.minSpreadApr) continue;

      // Determine if this arb is executable via VOOI (both legs on VOOI venue set)
      const vooiLongOk  = this.params.vooiVenueSet.includes(longVenue.toLowerCase());
      const vooiShortOk = this.params.vooiVenueSet.includes(shortVenue.toLowerCase());
      const vooiExecutable = vooiLongOk && vooiShortOk;

      // Cross-validate with VOOI (canonical join — see vooiJoinKey above)
      const vooiPair = vooiMap.get(vooiJoinKey(asset, longVenue, shortVenue));

      let confidence = 0.5;
      let priceSpreadPct = 0;
      let source: PerpFundingAlert['source'] = 'sharpe';

      if (vooiPair) {
        // EM-STRAT-014-E11-Cluster1-R1: VOOI agreement must NOT silently
        // upgrade confidence for data whose Sharpe freshness is unknown.
        // Full 0.9 cross-validated confidence requires a server-verified
        // Sharpe asOf; with unknown freshness the cap is 0.7.
        confidence = sharpeFreshness === 'server-asof' ? 0.9 : 0.7;
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
        // E-12: netApr is ONLY the Sharpe netApr field (verified, fee-adjusted,
        // decimal fraction). When it is absent the row is gross/indicative —
        // netApr stays null and the basis says so. Gross is never labeled net.
        netApr,
        netAprBasis: netApr === null ? 'unavailable' : 'sharpe-net',
        longOiUsd: row.longOiUsd ?? 0,
        shortOiUsd: row.shortOiUsd ?? 0,
        priceSpreadPct,
        confidence,
        source,
        vooiExecutable,
        sharpeAsOf,
        freshness: sharpeFreshness,
        annualizationBasis: 'sharpe-row', // provider's own APR — no local annualization
      });
    }

    // Also surface VOOI-only opportunities (not in Sharpe top results)
    if (vooiPairs.length > 0) {
      // Canonical asset identity for the Sharpe↔VOOI membership check too
      // (same table-driven normalization; unlisted aliases still never match).
      const sharpeAssets = new Set(sharpeResp.data.map(r => canonAsset(r.coin || r.asset || r.symbol || '')));
      let vooiSkippedMalformed = 0;
      for (const p of vooiPairs) {
        if (!sharpeAssets.has(canonAsset(p.asset))) {
          // E-12: VOOI fundingSpread1h is a HOURLY decimal-fraction rate
          // (VOOI's own fundingRate8h field is defined as fundingRate × 3 —
          // 8h = 3 × 1h — see the vooi-client schema comment). Annualize
          // ×24×365 into the CANONICAL DECIMAL-FRACTION APR. The previous
          // extra ×100 produced percentage points — 100× larger than the
          // decimal threshold (min_spread_apr = 0.08) and than Sharpe rows,
          // corrupting both the gate and the shared sort. The 1h basis is
          // an explicit assumption recorded on the alert.
          const fundingSpread1h = p.fundingSpread1h;
          if (typeof fundingSpread1h !== 'number' || !Number.isFinite(fundingSpread1h) || fundingSpread1h < 0) {
            // Fail-closed: a malformed spread must not propagate into
            // threshold/sort math (NaN comparisons are always false, which
            // would silently drop the row anyway — we count it instead).
            vooiSkippedMalformed++;
            continue;
          }
          const spreadApr = fundingSpread1h * 24 * 365;
          if (spreadApr < this.params.minSpreadApr) continue;

          // Leg rates: same hourly decimal basis, fail-closed on malformed.
          const longFundingRate = Number(p.long.fundingRate);
          const shortFundingRate = Number(p.short.fundingRate);
          if (!Number.isFinite(longFundingRate) || !Number.isFinite(shortFundingRate)) {
            vooiSkippedMalformed++;
            continue;
          }

          // No venue filter — VOOI already guarantees both legs are on supported venues
          alerts.push({
            asset: p.asset,
            longVenue: p.long.exchange,
            shortVenue: p.short.exchange,
            longFundingApr: longFundingRate * 24 * 365,
            shortFundingApr: shortFundingRate * 24 * 365,
            spreadApr,
            // E-12: VOOI provides NO fee-adjusted net APR, and this scanner
            // has no cost model — the row is GROSS-INDICATIVE. netApr stays
            // null; it must never be dressed up as net from the raw spread.
            netApr: null,
            netAprBasis: 'unavailable',
            longOiUsd: Number(p.long.openInterest) * Number(p.long.price),
            shortOiUsd: Number(p.short.openInterest) * Number(p.short.price),
            priceSpreadPct: (p.priceSpreadAtSize ?? p.priceSpread ?? 0) * 100,
            confidence: 0.7,
            source: 'vooi',
            vooiExecutable: true,   // VOOI pair → both legs are on VOOI venues by definition
            // VOOI-only row: no Sharpe data behind it, so freshness is
            // unknown regardless of the VOOI row's presence (a VOOI row
            // must never silently upgrade Sharpe-side freshness).
            sharpeAsOf: null,
            freshness: 'unknown',
            annualizationBasis: '1h-assumed', // explicit 24×365 hourly-basis assumption
          });
        }
      }
      if (vooiSkippedMalformed > 0) {
        // Visible degradation — malformed rows are skipped, never silently.
        console.warn(`[perp_funding] E-12: skipped ${vooiSkippedMalformed} VOOI rows with malformed funding fields (fail-closed)`);
      }
    }

    // Filter out illiquid pairs (OI < $50k on EITHER side — removes stale/phantom quotes)
    const MIN_OI_USD = 50_000;
    const filtered = alerts.filter(a => a.longOiUsd >= MIN_OI_USD && a.shortOiUsd >= MIN_OI_USD);

    // E-12: net-economics-aware sort. Rows with a VERIFIED net APR sort
    // first (by netApr desc — the only values comparable as net economics);
    // rows whose net is unavailable (gross/indicative only) sort AFTER them
    // (by indicative spread desc) so they remain visible for monitoring but
    // can never outrank — or be confused with — net-verified rows. A gross
    // value is never treated as net for ordering.
    filtered.sort((a, b) => {
      if (a.netApr !== null && b.netApr !== null) return b.netApr - a.netApr;
      if (a.netApr !== null) return -1;
      if (b.netApr !== null) return 1;
      return b.spreadApr - a.spreadApr;
    });
    return filtered;
  }
}
