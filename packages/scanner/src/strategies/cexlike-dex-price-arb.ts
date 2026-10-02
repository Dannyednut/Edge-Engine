/**
 * CexLikeDexPriceArbStrategy — price spread arbitrage between CEX-like DEX
 * perp venues (Hyperliquid, Aster, Lighter, trade.xyz, etc.) via VOOI.
 *
 * DISCOVERY (Oct 7 2026):
 *   VOOI scanner shows 61 markets with price spreads > 0.5% between
 *   CEX-like DEX venues. Unlike funding rate spreads (which are APR-based
 *   and require holding to maturity), price spreads are immediate —
 *   buy on cheaper venue, sell on expensive venue, capture the gap.
 *
 *   Example (live Oct 7):
 *     ONE: Gate $0.002027 vs Aster $0.00216 = 6.33% spread
 *     OpenAI token: Gate $1577 vs Lighter $1655 = 5.60% spread
 *
 *   These are PERP markets — no token transfer needed. Just open opposite
 *   positions on two venues via VOOI atomic paired-leg execution.
 *
 * HOW IT DIFFERS FROM PerpFundingStrategy:
 *   - PerpFundingStrategy looks at FUNDING RATE spreads (APR, held to maturity)
 *   - CexLikeDexPriceArb looks at PRICE spreads (immediate, captured at entry)
 *   - Both use VOOI for execution
 *   - Price spread arb is higher-frequency (capture immediately, close when spread converges)
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';
import { VooiClient, type VooiArbitragePair } from '@edge/vooi-client';

export interface CexLikeDexPriceArbParams {
  /** Min price spread % to fire alert (default 0.5%) */
  minPriceSpreadPct: number;
  /** Max notional per trade (default $5000) */
  maxSizeUsd: number;
  /** Min OI for liquidity (default $50,000) */
  minOpenInterest: number;
  /** Venues to consider (empty = all VOOI venues) */
  venues: string[];
}

export interface PriceArbAlert {
  asset: string;
  longVenue: string;
  shortVenue: string;
  longPrice: number;
  shortPrice: number;
  priceSpreadPct: number;        // (short - long) / long × 100
  fundingSpread1h: number;       // also check funding for additional edge
  longOiUsd: number;
  shortOiUsd: number;
  estimatedProfitUsd: number;    // at maxSizeUsd minus fees
  vooiExecutable: boolean;
  ts: number;
}

export class CexLikeDexPriceArbStrategy implements Strategy {
  readonly id = 'cexlike_dex_price_arb';
  readonly landscape = 'B_cex_cex' as const;

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
        const priceSpread = pair.priceSpread ?? 0;
        if (Math.abs(Number(priceSpread)) < this.params.minPriceSpreadPct / 100) continue;

        const longVenue = pair.long.exchange;
        const shortVenue = pair.short.exchange;

        // Filter by venue set if specified
        if (this.params.venues.length > 0) {
          if (!this.params.venues.includes(longVenue) || !this.params.venues.includes(shortVenue)) continue;
        }

        const longPrice = Number(pair.long.price || 0);
        const shortPrice = Number(pair.short.price || 0);
        const priceSpreadPct = Number(priceSpread) * 100;
        const fundingSpread1h = Number(pair.fundingSpread1h || 0);

        // Estimated profit = price spread × size - fees
        // VOOI fee: 2 bps taker on DEX venues, 0 on CEX venues
        // Round-trip fee estimate: 4 bps = 0.04%
        const feePct = 0.04;
        const grossProfitPct = Math.abs(priceSpreadPct) - feePct;
        if (grossProfitPct <= 0) continue;

        const estimatedProfitUsd = (grossProfitPct / 100) * this.params.maxSizeUsd;

        alerts.push({
          asset: item.asset,
          longVenue,
          shortVenue,
          longPrice,
          shortPrice,
          priceSpreadPct,
          fundingSpread1h,
          longOiUsd: Number(pair.long.openInterest || 0) * longPrice,
          shortOiUsd: Number(pair.short.openInterest || 0) * shortPrice,
          estimatedProfitUsd,
          vooiExecutable: true,  // VOOI can execute any pair it shows
          ts: Date.now(),
        });
      }
    }

    alerts.sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd);
    return alerts;
  }
}
