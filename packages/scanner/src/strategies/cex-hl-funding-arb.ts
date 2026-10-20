/**
 * CexHlFundingArbStrategy — CEX spot (long) + Hyperliquid perp (short) funding arb.
 *
 * Based on Task 9 research finding: Hyperliquid funding floor is 10.95% APR
 * for ETH/BTC/SOL while CEX funding has compressed to near-zero. This creates
 * a structural 9-11% APR carry trade that's far better than the 0.02-0.11% APR
 * available from CEX-only spot-perp basis arbs.
 *
 * SIGNAL-INTEGRITY MODEL (corrected EM-STRAT-003, hardened EM-STRAT-004):
 *   Sharpe's `/arbitrage/cross-exchange` endpoint returns a `netApr` that is
 *   itself a *third-party net/spread estimate* — it is NOT the raw Hyperliquid
 *   funding rate and NOT the raw CEX funding rate. Treating `netApr` as either
 *   raw rate, or recomputing a "new net" by subtracting a CEX rate from it,
 *   double-counts and produces an unreliable actionable signal.
 *
 *   This scanner therefore:
 *     1. Pulls Sharpe cross-exchange rows to IDENTIFY candidate asset × venue
 *        pairs (one leg HL, other leg CEX). `sharpeNetApr` is stored as a
 *        third-party reference only.
 *     2. Pulls RAW per-venue funding rates from Sharpe `/funding/rates` for
 *        the HL leg and the CEX leg. These are the only rates eligible to
 *        compute an actionable net spread.
 *     3. Computes `netSpreadApr = hlRawFundingApr - cexRawFundingApr` ONLY
 *        when both raw rates are available, correctly oriented (short-side
 *        positive funding = receipts), and finite. Otherwise `netSpreadApr`
 *        is null and the alert is NOT actionable.
 *
 *   `hlFundingApr` is the raw HL perp funding APR (separately sourced) or null.
 *   `cexFundingApr` is the raw CEX perp funding APR (separately sourced) or null.
 *   `sharpeNetApr` is the third-party estimate, explicitly labeled.
 *
 * Trade structure:
 *   LONG  spot ETH on Binance  (collect 0% funding on spot — no perp)
 *   SHORT perp ETH on Hyperliquid (collect ~10.95% APR funding from longs)
 *   Net delta = 0; net funding capture ≈ HL funding - CEX borrow fees
 *
 * Risks:
 *   - HL funding rate can fluctuate (currently at 10.95% floor but can spike
 *     higher or drop lower)
 *   - CEX withdrawal latency if rebalancing needed (5-20 min for native USDC)
 *   - HL insurance fund seizure risk on cascade (small)
 *   - Counter-party risk: capital split across Binance + HL
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';
import { SharpeClient } from '@edge/sharpe-client';
import { VooiClient, type VooiArbitragePair } from '@edge/vooi-client';

export interface CexHlFundingArbParams {
  minNetApr: number;            // 0.05 = 5% APR minimum to fire actionable alert
  cexVenues: string[];          // ['binance', 'okx', 'bybit'] — CEX spot candidates
  hlVenueName: string;          // 'hyperliquid' or 'Hyperliquid' — match Sharpe's naming
  useVooiExecutor: boolean;     // try VOOI for atomic paired-leg (perps only — no spot)
  vooiVenueSet: string[];
  /** Auto-execute when found (vs alert-only) */
  autoExecute: boolean;
  /** Max notional per trade (USD) */
  maxNotionalUsd: number;
  /** Only emit actionable alerts when HL funding is positive (shorts collect funding).
   *  Set to 0.02 (2%) to skip when HL funding flips negative.
   *  CRITICAL: HYPE funding flipped to -6.88% APR on Sep 28 2026. */
  minHlFundingApr: number;
}

export interface CexHlFundingAlert {
  asset: string;
  cexVenue: string;
  /**
   * Raw Hyperliquid perp funding APR (separately sourced from
   * Sharpe `/funding/rates`). null = not independently verified.
   *
   * EM-STRAT-004: this is NEVER the Sharpe `netApr` or `grossApr`.
   * Those third-party estimates are stored separately in `sharpeNetApr`.
   */
  hlFundingApr: number | null;
  /**
   * Raw CEX perp funding APR (separately sourced from
   * Sharpe `/funding/rates`). null = not independently verified.
   */
  cexFundingApr: number | null;
  /**
   * Independently-verified net carry = hlFundingApr - cexFundingApr.
   * null = unavailable (one or both raw rates missing, or sign/orientation
   * inconsistent). When null, the alert MUST NOT be presented as actionable.
   *
   * EM-STRAT-004: this is NEVER computed by subtracting a CEX rate from
   * Sharpe's netApr. Only raw rates are subtracted.
   */
  netSpreadApr: number | null;
  hlOiUsd: number;
  cexOiUsd: number;
  priceSpreadPct: number;
  vooiExecutable: boolean;
  confidence: number;
  source: 'sharpe' | 'sharpe+vooi';
  /**
   * Sharpe's third-party netApr estimate — explicitly labeled as a
   * reference. NOT used as a raw funding rate and NOT used to compute
   * netSpreadApr. Present for diagnostic visibility only.
   */
  sharpeNetApr: number | null;
  /** Whether the alert is actionable (requires independently verified net carry). */
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

  subscribesTo(): string[] {
    return [];
  }

  evaluate(_data: DataPoint): TradeOrder[] | null {
    return null;
  }

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
   * Look up a raw per-venue funding APR from Sharpe `/funding/rates`.
   * Returns null if no row matches (asset, venue) or the rate is not finite.
   *
   * Both arguments are case-insensitive; Sharpe exchange names are normalized
   * to lowercase for matching. The returned APR is already annualized.
   */
  private async fetchRawFundingApr(
    fundingRows: { coin: string; exchange: string; annualized: number; rate: number }[],
    asset: string,
    venue: string,
  ): Promise<number | null> {
    const a = asset.toUpperCase();
    const v = venue.toLowerCase();
    const row = fundingRows.find(
      r => (r.coin?.toUpperCase() === a) && (r.exchange?.toLowerCase() === v),
    );
    if (!row) return null;
    if (!isFinite(row.annualized)) return null;
    return row.annualized;
  }

  async scan(): Promise<CexHlFundingAlert[]> {
    // 1. Pull Sharpe cross-exchange arbs filtered to HL × CEX venues.
    //    These rows identify candidate asset × venue pairs. The `netApr`
    //    on each row is a third-party estimate (stored as `sharpeNetApr`),
    //    NOT a raw funding rate.
    const sharpeResp = await this.sharpe.crossExchangeFunding({
      minApr: this.params.minNetApr,
      minOiUsd: 100_000,
      assetClass: 'crypto',
    });

    // 2. Pull Sharpe /funding/rates — RAW per-venue funding rates.
    //    This is the only source eligible to compute an actionable net.
    let hlRawFundingRows: { coin: string; exchange: string; annualized: number; rate: number }[] = [];
    try {
      const ratesResp = await this.sharpe.fundingRates({ assetClass: 'crypto' });
      hlRawFundingRows = ratesResp.data as typeof hlRawFundingRows;
    } catch (err) {
      // Without raw rates we cannot compute actionable net spreads.
      // Continue — alerts will be emitted with netSpreadApr=null and actionable=false.
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

    // Build VOOI lookup by (asset, venue1, venue2)
    const vooiMap = new Map<string, VooiArbitragePair & { asset: string }>();
    for (const p of vooiPairs) {
      const key1 = `${p.asset}|${p.long.exchange.toLowerCase()}|${p.short.exchange.toLowerCase()}`;
      vooiMap.set(key1, p);
      const key2 = `${p.asset}|${p.short.exchange.toLowerCase()}|${p.long.exchange.toLowerCase()}`;
      vooiMap.set(key2, { ...p, long: p.short, short: p.long });
    }

    // 4. For each Sharpe row, check if one leg is on Hyperliquid and the other on a CEX.
    //    We DO NOT treat `netApr` as a raw rate. We separately look up raw rates
    //    from /funding/rates for both legs.
    const alerts: CexHlFundingAlert[] = [];
    for (const row of sharpeResp.data) {
      const asset = (row.coin || row.asset || row.symbol || '').toUpperCase();
      if (!asset) continue;

      const longVenue = (row.longExchange || '').toLowerCase();
      const shortVenue = (row.shortExchange || '').toLowerCase();
      if (!longVenue || !shortVenue) continue;

      const hlOnLong  = longVenue  === this.params.hlVenueName.toLowerCase();
      const hlOnShort = shortVenue === this.params.hlVenueName.toLowerCase();
      if (!hlOnLong && !hlOnShort) continue;

      const cexVenue = hlOnLong ? shortVenue : longVenue;
      if (!this.params.cexVenues.includes(cexVenue)) continue;

      // The CEX side should be the low-funding leg (we go LONG perp on CEX = pay CEX funding)
      // The HL side should be the high-funding leg (we go SHORT perp on HL = receive HL funding)
      // If HL is the long side in Sharpe's row, that means HL longs pay shorts (negative HL funding)
      // — which is the OPPOSITE of what we want. Skip those.
      if (hlOnLong) continue;

      // Now: HL is short side (HL longs pay shorts → we short HL = collect funding)
      // CEX is long side (we long CEX perp = pay CEX funding)

      // ── Third-party reference (NOT used as a raw rate) ───────────────
      const sharpeNetApr: number | null =
        (typeof row.netApr === 'number' && isFinite(row.netApr)) ? row.netApr
        : (typeof row.grossApr === 'number' && isFinite(row.grossApr)) ? row.grossApr
        : null;

      // ── Raw per-leg funding rates (separately sourced) ──────────────
      // EM-STRAT-004: hlFundingApr is the raw HL funding APR from /funding/rates.
      // It is NEVER equal to sharpeNetApr.
      const hlFundingApr = await this.fetchRawFundingApr(hlRawFundingRows, asset, this.params.hlVenueName);
      const cexFundingApr = await this.fetchRawFundingApr(hlRawFundingRows, asset, cexVenue);

      // ── Actionable net spread ────────────────────────────────────────
      // EM-STRAT-004: compute only when BOTH raw rates are available.
      //   Net = HL funding (received by shorts) - CEX funding (paid by longs)
      // If HL funding is negative, shorts pay funding — that flips the trade
      // and we should NOT treat it as the same carry. We still emit the alert
      // but with netSpreadApr reflecting the actual signed values, and
      // `actionable` is only true when the trade direction is profitable
      // (netSpreadApr >= minNetApr) AND HL funding is positive enough that
      // shorts collect (per minHlFundingApr).
      let netSpreadApr: number | null = null;
      if (hlFundingApr !== null && cexFundingApr !== null) {
        netSpreadApr = hlFundingApr - cexFundingApr;
      }

      // ── Actionable flag ─────────────────────────────────────────────
      // An alert is actionable only when:
      //   1. netSpreadApr is independently verified (both raw rates present)
      //   2. HL funding is positive enough that shorts collect funding
      //      (per minHlFundingApr — guards against the HYPE -6.88% case)
      //   3. netSpreadApr >= minNetApr
      //
      // UNIT NORMALIZATION (EM-STRAT-004):
      //   - hlFundingApr / cexFundingApr / netSpreadApr are in PERCENT
      //     (e.g., 11 means 11% APR) — sourced from Sharpe /funding/rates
      //     `annualized` field which follows APR convention.
      //   - this.params.minNetApr and minHlFundingApr are configured in
      //     FRACTION (e.g., 0.05 means 5%) per the existing convention
      //     used for row.netApr comparison.
      //   - Convert params from fraction to percent before comparing.
      const minNetAprPct = this.params.minNetApr * 100;
      const minHlFundingAprPct = this.params.minHlFundingApr * 100;
      const hlFundingPositive =
        hlFundingApr !== null && hlFundingApr >= minHlFundingAprPct;
      const actionable =
        netSpreadApr !== null &&
        hlFundingPositive &&
        netSpreadApr >= minNetAprPct;

      // ── Cross-validate with VOOI (price spread, not funding) ────────
      const vooiKey = `${asset}|${longVenue}|${shortVenue}`;
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
        actionable,
      });
    }

    alerts.sort((a, b) => (b.netSpreadApr ?? -Infinity) - (a.netSpreadApr ?? -Infinity));
    return alerts;
  }
}
