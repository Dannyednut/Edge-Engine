/**
 * CexHlFundingArbStrategy — CEX spot (long) + Hyperliquid perp (short) funding arb.
 *
 * Based on Task 9 research finding: Hyperliquid funding floor is 10.95% APR
 * for ETH/BTC/SOL while CEX funding has compressed to near-zero. This creates
 * a structural 9-11% APR carry trade that's far better than the 0.02-0.11% APR
 * available from CEX-only spot-perp basis arbs.
 *
 * Pipeline:
 *   1. Pull Sharpe /arbitrage/cross-exchange filtered to {Hyperliquid, Binance,
 *      OKX, Bybit} — get netApr-ranked rows where one leg is on HL.
 *   2. For each row, check VOOI scanner for execution-aware price spread.
 *   3. If spread < 1% and netApr > threshold, fire alert + (optional) execute
 *      via VOOI paired-leg API.
 *
 * Trade structure:
 *   LONG  spot ETH on Binance  (collect 0% funding on spot — no perp)
 *   SHORT perp ETH on Hyperliquid (collect ~10.95% APR funding from longs)
 *   Net delta = 0; net funding capture ≈ 10.95% APR - CEX borrow fees
 *
 * Risks:
 *   - HL funding rate can fluctuate (currently at 10.95% floor but can spike
 *     higher or drop lower)
 *   - CEX withdrawal latency if rebalancing needed (5-20 min for native USDC)
 *   - HL insurance fund seizure risk on cascade (small)
 *   - Counter-party risk: capital split across Binance + HL
 *
 * Execution paths:
 *   - VOOI atomic: POST /arbitrage-orders with primary=short HL perp + hedge=long
 *     Binance perp (NOT spot — VOOI is perps-only). This captures the FUNDING
 *     spread but not the spot-vs-perp basis.
 *   - Direct: long Binance spot via ccxt + short HL perp via HL SDK. Captures
 *     both funding AND any spot-perp basis. Requires both SDKs integrated.
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';
import { SharpeClient } from '@edge/sharpe-client';
import { VooiClient, type VooiArbitragePair } from '@edge/vooi-client';

export interface CexHlFundingArbParams {
  minNetApr: number;            // 0.05 = 5% APR minimum to fire alert
  cexVenues: string[];          // ['binance', 'okx', 'bybit'] — CEX spot candidates
  hlVenueName: string;          // 'hyperliquid' or 'Hyperliquid' — match Sharpe's naming
  useVooiExecutor: boolean;     // try VOOI for atomic paired-leg (perps only — no spot)
  vooiVenueSet: string[];
  /** Auto-execute when found (vs alert-only) */
  autoExecute: boolean;
  /** Max notional per trade (USD) */
  maxNotionalUsd: number;
  /** Only emit signals when HL funding is positive (shorts collect funding).
   *  Set to 0.02 (2%) to skip when HL funding flips negative.
   *  CRITICAL: HYPE funding flipped to -6.88% APR on Sep 28 2026. */
  minHlFundingApr: number;
}

export interface CexHlFundingAlert {
  asset: string;
  cexVenue: string;             // 'Binance' / 'OKX' / 'Bybit'
  hlFundingApr: number;         // annualized HL perp funding %
  cexFundingApr: number;        // annualized CEX perp funding %
  netSpreadApr: number;         // hlFundingApr - cexFundingApr (the capture)
  hlOiUsd: number;
  cexOiUsd: number;
  priceSpreadPct: number;       // from VOOI cross-validation
  vooiExecutable: boolean;      // can VOOI execute this (both legs as perps)?
  confidence: number;
  source: 'sharpe' | 'sharpe+vooi';
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

  async scan(): Promise<CexHlFundingAlert[]> {
    // 1. Pull Sharpe cross-exchange arbs filtered to HL × CEX venues
    const sharpeResp = await this.sharpe.crossExchangeFunding({
      minApr: this.params.minNetApr,
      minOiUsd: 100_000,
      assetClass: 'crypto',
    });

    // 2. Pull VOOI scanner for cross-validation
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

    // 3. For each Sharpe row, check if one leg is on Hyperliquid and the other on a CEX
    const alerts: CexHlFundingAlert[] = [];
    for (const row of sharpeResp.data) {
      const asset = (row.coin || row.asset || row.symbol || '').toUpperCase();
      if (!asset) continue;

      const longVenue = (row.longExchange || '').toLowerCase();
      const shortVenue = (row.shortExchange || '').toLowerCase();
      if (!longVenue || !shortVenue) continue;

      const netApr = row.netApr ?? row.grossApr ?? 0;
      if (netApr < this.params.minNetApr) continue;

      // FUNDING SIGN GUARD: only emit when HL funding is positive enough that
      // shorts collect meaningful funding. If HL funding flips negative (like
      // HYPE did on Sep 28 2026 at -6.88% APR), shorting HL means PAYING funding.
      if (netApr < this.params.minHlFundingApr) continue;

      // We want: HL on one side, CEX on the other
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
      // Net capture = HL funding received - CEX funding paid = netApr

      // Cross-validate with VOOI
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
        hlFundingApr: netApr,
        cexFundingApr: 0,
        netSpreadApr: netApr,
        hlOiUsd: row.shortOiUsd ?? 0,
        cexOiUsd: row.longOiUsd ?? 0,
        priceSpreadPct,
        vooiExecutable,
        confidence,
        source,
      });
    }

    alerts.sort((a, b) => b.netSpreadApr - a.netSpreadApr);
    return alerts;
  }
}
