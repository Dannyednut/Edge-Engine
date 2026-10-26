/**
 * CexHlFundingArbStrategy — CEX perpetual (long) + Hyperliquid perpetual (short)
 * funding-rate carry.
 *
 * TRADE STRUCTURE (corrected EM-STRAT-005 §2):
 *   LONG  perp ETH on a CEX venue (e.g., Binance) — pays CEX perp funding
 *   SHORT perp ETH on Hyperliquid — receives HL perp funding (when positive)
 *   Net delta ≈ 0; net funding capture ≈ HL funding (received) − CEX funding (paid)
 *
 *   The previous documentation described this as "CEX spot (long) + HL perp
 *   (short)" while subtracting a CEX perp funding rate — internally
 *   inconsistent. EM-STRAT-005 §2 corrects the documentation: BOTH legs
 *   are perpetuals, and the net carry is the difference of perp funding
 *   rates. A spot leg would not have a funding rate at all.
 *
 * PROVENANCE MODEL (EM-STRAT-005 §2):
 *   Sharpe's `/arbitrage/cross-exchange` endpoint returns `netApr`/`grossApr`
 *   as third-party NET estimates. Sharpe's `/funding/rates` endpoint returns
 *   per-venue funding APRs. Both endpoints come from the SAME provider
 *   (Sharpe). A second Sharpe endpoint is NOT independent corroboration —
 *   it is the same source relabelled.
 *
 *   EM-STRAT-005 §2 therefore distinguishes two levels of verification:
 *     - "third-party-sourced": data comes from Sharpe (either endpoint).
 *       This is sufficient to IDENTIFY a candidate carry but NOT to label
 *       the net spread as independently verified.
 *     - "independently corroborated": per-leg raw rates have been
 *       cross-checked against venue-native free public endpoints (e.g.,
 *       Hyperliquid `/info` for HL funding; Binance `/fapi/v1/premiumIndex`
 *       for Binance funding), with validated units (APR vs 8h fraction)
 *       and source freshness. This is required before `actionable = true`.
 *
 *   This implementation does NOT yet wire venue-native endpoints. Until
 *   such corroboration is implemented, every alert has:
 *     - provenance = 'third-party-sourced'  (Sharpe only)
 *     - actionable = false
 *
 *   `hlFundingApr` and `cexFundingApr` are the raw per-venue funding APRs
 *   from Sharpe `/funding/rates` (percent units, already annualized). They
 *   are NEVER Sharpe's `netApr`/`grossApr`. They are stored for diagnostic
 *   visibility but are NOT treated as independently verified.
 *
 *   `netSpreadApr = hlFundingApr - cexFundingApr` is computed when both
 *   raw rates are available. It is labeled as a third-party-sourced
 *   estimate — NOT independently verified — and the alert remains
 *   non-actionable until venue-native corroboration is added.
 *
 * RISKS:
 *   - HL funding rate can fluctuate (floor was 10.95% APR; HYPE flipped
 *     to -6.88% APR on Sep 28 2026)
 *   - CEX perp funding can spike above HL funding, inverting the carry
 *   - Counter-party risk: capital split across CEX + HL
 *   - Liquidation risk on both perp legs
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';
import { SharpeClient } from '@edge/sharpe-client';
import { VooiClient, type VooiArbitragePair } from '@edge/vooi-client';
import { canonAsset, canonVenue, fundingJoinKey } from '../lib/venue-asset-aliases.js';

export interface CexHlFundingArbParams {
  /** Min net APR (fraction; 0.05 = 5%) for the actionable threshold. */
  minNetApr: number;
  /** CEX perp venues to consider (e.g., ['binance', 'okx', 'bybit']). */
  cexVenues: string[];
  /** Hyperliquid venue name as Sharpe spells it (e.g., 'Hyperliquid'). */
  hlVenueName: string;
  useVooiExecutor: boolean;
  vooiVenueSet: string[];
  autoExecute: boolean;
  maxNotionalUsd: number;
  /**
   * Min HL funding APR (fraction; 0.02 = 2%) for an actionable alert.
   * Guards against the HYPE -6.88% case where shorts pay funding.
   */
  minHlFundingApr: number;
}

/**
 * Provenance of the per-leg funding rates.
 * - 'third-party-sourced': rates come from Sharpe `/funding/rates` (one provider).
 *   Net spread is computable but NOT independently verified.
 * - 'independently-corroborated': rates have been cross-checked against
 *   venue-native public endpoints (not yet implemented). Required for
 *   `actionable = true`.
 */
export type CexHlFundingProvenance = 'third-party-sourced' | 'independently-corroborated';

export interface CexHlFundingAlert {
  asset: string;
  cexVenue: string;
  /**
   * Raw HL perp funding APR (percent units, already annualized) sourced
   * from Sharpe `/funding/rates`. null = no matching row.
   *
   * EM-STRAT-004: NEVER equal to Sharpe `netApr`/`grossApr`.
   * EM-STRAT-005 §2: NOT independently verified — same provider as cross-exchange.
   */
  hlFundingApr: number | null;
  /**
   * Raw CEX perp funding APR (percent units, already annualized) sourced
   * from Sharpe `/funding/rates`. null = no matching row.
   * EM-STRAT-005 §2: NOT independently verified — same provider as cross-exchange.
   */
  cexFundingApr: number | null;
  /**
   * Net carry = hlFundingApr - cexFundingApr (percent units). Computed only
   * when both raw rates are available. null = one or both rates missing.
   *
   * EM-STRAT-005 §2: labeled as third-party-sourced until venue-native
   * corroboration is implemented. Actionable requires 'independently-corroborated'.
   */
  netSpreadApr: number | null;
  hlOiUsd: number;
  cexOiUsd: number;
  priceSpreadPct: number;
  vooiExecutable: boolean;
  confidence: number;
  source: 'sharpe' | 'sharpe+vooi';
  /**
   * Sharpe's third-party netApr estimate (fraction or percent — Sharpe's
   * own convention). Explicitly labeled as a reference. NOT used as a raw
   * funding rate and NOT used to compute netSpreadApr.
   */
  sharpeNetApr: number | null;
  /**
   * Provenance of hlFundingApr / cexFundingApr.
   * - 'third-party-sourced': from Sharpe only (current implementation).
   * - 'independently-corroborated': cross-checked against venue-native
   *   endpoints (not yet implemented).
   */
  provenance: CexHlFundingProvenance;
  /**
   * Whether the alert is actionable. Requires provenance =
   * 'independently-corroborated' (not yet implemented) AND netSpreadApr
   * >= minNetApr AND hlFundingApr >= minHlFundingApr.
   *
   * EM-STRAT-005 §2: until venue-native corroboration is wired, this is
   * ALWAYS false. The alert is reported as a third-party-sourced reference.
   */
  actionable: boolean;
}

export class CexHlFundingArbStrategy implements Strategy {
  readonly id = 'cex_hl_funding_arb';
  readonly landscape = 'F_perps_funding' as const;

  constructor(
    private sharpe: SharpeClient,
    private vooi: VooiClient,
    private params: CexHlFundingArbParams,
  ) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 10,
      maxSizeUsd: this.params.maxNotionalUsd,
      maxConcurrent: 2,
      cooldownMs: 5 * 60_000,
      gasPriceCapMultiplier: 3,
    };
  }

  /**
   * Look up a raw per-venue funding APR (percent, already annualized) from
   * Sharpe `/funding/rates`. Returns null if no row matches (asset, venue)
   * or the rate is not finite.
   *
   * Both arguments are case-insensitive. EM-STRAT-005 §2: this is
   * third-party-sourced data — NOT independently verified.
   */
  private async fetchRawFundingApr(
    fundingRows: { coin: string; exchange: string; annualized: number; rate: number }[],
    asset: string,
    venue: string,
  ): Promise<number | null> {
    // EM-STRAT-014-E11 item 4: canonicalize both sides before joining.
    const a = canonAsset(asset);
    const v = canonVenue(venue);
    const row = fundingRows.find(
      r => canonAsset(r.coin) === a && canonVenue(r.exchange) === v,
    );
    if (!row) return null;
    if (!isFinite(row.annualized)) return null;
    return row.annualized;
  }

  async scan(): Promise<CexHlFundingAlert[]> {
    // 1. Pull Sharpe cross-exchange arbs filtered to HL × CEX venues.
    //    These rows IDENTIFY candidate asset × venue pairs. The `netApr`
    //    on each row is a third-party NET estimate (stored as `sharpeNetApr`),
    //    NOT a raw funding rate.
    const sharpeResp = await this.sharpe.crossExchangeFunding({
      minApr: this.params.minNetApr,
      minOiUsd: 100_000,
      assetClass: 'crypto',
    });

    // 2. Pull Sharpe /funding/rates — per-venue funding APRs.
    //    EM-STRAT-005 §2: this is a DISTINCT endpoint from cross-exchange,
    //    but the SAME provider. The result is NOT "independently verified"
    //    merely because it comes from /funding/rates. It is third-party-sourced.
    let fundingRows: { coin: string; exchange: string; annualized: number; rate: number }[] = [];
    try {
      const ratesResp = await this.sharpe.fundingRates({ assetClass: 'crypto' });
      fundingRows = ratesResp.data as typeof fundingRows;
    } catch (err) {
      // Provider failure — continue with empty funding rows. All alerts
      // will have hlFundingApr=cexFundingApr=netSpreadApr=null and
      // actionable=false. This is the non-actionable fallback (EM-STRAT-005 §2).
      console.warn('Sharpe /funding/rates unavailable (continuing with non-actionable alerts):', err);
    }

    // 3. Pull VOOI scanner for cross-validation of price spread
    let vooiPairs: Array<VooiArbitragePair & { asset: string }> = [];
    try {
      const vooiResp = await this.vooi.scanArbitrage({
        minFundingSpread: 0,
        minOpenInterest: 100_000,
        notionalUsd: this.params.maxNotionalUsd,
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

    // Build VOOI lookup by canonical (asset, venue1, venue2) — EM-STRAT-014-E11 item 4
    const vooiMap = new Map<string, VooiArbitragePair & { asset: string }>();
    for (const p of vooiPairs) {
      const key1 = fundingJoinKey(p.asset, p.long.exchange) + '|' + fundingJoinKey(p.asset, p.short.exchange);
      vooiMap.set(key1, p);
      const key2 = fundingJoinKey(p.asset, p.short.exchange) + '|' + fundingJoinKey(p.asset, p.long.exchange);
      vooiMap.set(key2, { ...p, long: p.short, short: p.long });
    }

    // 4. For each Sharpe row, check if one leg is on Hyperliquid and the other on a CEX.
    //    We DO NOT treat `netApr` as a raw rate. We separately look up raw rates
    //    from /funding/rates for both legs.
    const alerts: CexHlFundingAlert[] = [];
    for (const row of sharpeResp.data) {
      // EM-STRAT-014-E11 item 4: canonicalize asset + venue identity.
      const asset = canonAsset(row.coin || row.asset || row.symbol || '');
      if (!asset) continue;

      const longVenue = canonVenue(row.longExchange || '');
      const shortVenue = canonVenue(row.shortExchange || '');
      if (!longVenue || !shortVenue) continue;

      const hlVenueCanon = canonVenue(this.params.hlVenueName);
      const hlOnLong  = longVenue  === hlVenueCanon;
      const hlOnShort = shortVenue === hlVenueCanon;
      if (!hlOnLong && !hlOnShort) continue;

      const cexVenue = hlOnLong ? shortVenue : longVenue;
      // EM-STRAT-014-E11 item 4: compare canonical venue against canonicalized cexVenues list.
      const cexVenuesCanon = this.params.cexVenues.map(canonVenue);
      if (!cexVenuesCanon.includes(cexVenue)) continue;

      // EM-STRAT-005 §2: BOTH legs are perpetuals. We want HL on the SHORT
      // side (shorts collect positive funding) and CEX on the LONG side
      // (longs pay CEX funding). If HL is the long side, the trade direction
      // is inverted — skip.
      if (hlOnLong) continue;

      // ── Third-party reference (NOT used as a raw rate) ───────────────
      const sharpeNetApr: number | null =
        (typeof row.netApr === 'number' && isFinite(row.netApr)) ? row.netApr
        : (typeof row.grossApr === 'number' && isFinite(row.grossApr)) ? row.grossApr
        : null;

      // ── Per-leg funding rates (third-party-sourced) ─────────────────
      // EM-STRAT-005 §2: sourced from Sharpe /funding/rates. Same provider
      // as cross-exchange. NOT independently verified.
      const hlFundingApr = await this.fetchRawFundingApr(fundingRows, asset, this.params.hlVenueName);
      const cexFundingApr = await this.fetchRawFundingApr(fundingRows, asset, cexVenue);

      // ── Net spread (third-party-sourced) ────────────────────────────
      // Computed only when BOTH raw rates are available.
      let netSpreadApr: number | null = null;
      if (hlFundingApr !== null && cexFundingApr !== null) {
        netSpreadApr = hlFundingApr - cexFundingApr;
      }

      // ── Provenance ──────────────────────────────────────────────────
      // EM-STRAT-005 §2: until venue-native corroboration is implemented,
      // provenance is ALWAYS 'third-party-sourced'. This means hlFundingApr
      // and cexFundingApr come from Sharpe only — same provider as the
      // cross-exchange estimate. They are NOT independently verified.
      //
      // The constant below is typed as CexHlFundingProvenance (a union) and
      // then re-assigned through a `let` so TypeScript does not narrow it
      // to the literal 'third-party-sourced' — keeping the `actionable`
      // comparison below typecheck-meaningful for the future when this
      // branch flips to 'independently-corroborated'.
      let provenance: CexHlFundingProvenance = 'third-party-sourced' as CexHlFundingProvenance;

      // ── Actionable flag ─────────────────────────────────────────────
      // Actionable requires:
      //   1. provenance === 'independently-corroborated' (NOT YET IMPLEMENTED)
      //   2. netSpreadApr !== null
      //   3. hlFundingApr >= minHlFundingApr (shorts collect funding)
      //   4. netSpreadApr >= minNetApr
      //
      // UNIT NORMALIZATION:
      //   - hlFundingApr / cexFundingApr / netSpreadApr are in PERCENT
      //     (e.g., 11 means 11% APR) — sourced from Sharpe /funding/rates
      //     `annualized` field which follows APR convention.
      //   - this.params.minNetApr and minHlFundingApr are configured in
      //     FRACTION (e.g., 0.05 means 5%).
      //   - Convert params from fraction to percent before comparing.
      const minNetAprPct = this.params.minNetApr * 100;
      const minHlFundingAprPct = this.params.minHlFundingApr * 100;
      const hlFundingPositive =
        hlFundingApr !== null && hlFundingApr >= minHlFundingAprPct;
      const isCorroborated = provenance === ('independently-corroborated' as CexHlFundingProvenance);
      const actionable =
        isCorroborated &&
        netSpreadApr !== null &&
        hlFundingPositive &&
        netSpreadApr >= minNetAprPct;
      // With provenance always 'third-party-sourced' (current impl),
      // actionable is ALWAYS false. This is the EM-STRAT-005 §2 non-actionable
      // fallback until venue-native corroboration is wired.

      // EM-STRAT-014-E11 item 4: cross-validate with VOOI using canonical join key.
      const vooiKey = fundingJoinKey(asset, longVenue) + '|' + fundingJoinKey(asset, shortVenue);
      const vooiPair = vooiMap.get(vooiKey);
      let priceSpreadPct = 0;
      let confidence = 0.6;
      let source: CexHlFundingAlert['source'] = 'sharpe';
      const vooiExecutable = this.params.vooiVenueSet.includes(longVenue) &&
                              this.params.vooiVenueSet.includes(shortVenue);

      if (vooiPair) {
        confidence = 0.9;
        priceSpreadPct = (vooiPair.priceSpreadAtSize ?? vooiPair.priceSpread ?? 0) * 100;
        source = 'sharpe+vooi';
        if (Math.abs(priceSpreadPct) > 1.0) continue;
      }

      alerts.push({
        asset,
        cexVenue,
        hlFundingApr,
        cexFundingApr,
        netSpreadApr,
        hlOiUsd: row.shortOiUsd ?? 0,
        cexOiUsd: row.longOiUsd ?? 0,
        priceSpreadPct,
        vooiExecutable,
        confidence,
        source,
        sharpeNetApr,
        provenance,
        actionable,
      });
    }

    alerts.sort((a, b) => (b.netSpreadApr ?? -Infinity) - (a.netSpreadApr ?? -Infinity));
    return alerts;
  }
}
