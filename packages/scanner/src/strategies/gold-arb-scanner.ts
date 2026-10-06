/**
 * GoldArbScanner — tokenized gold (PAXG vs XAUT) price spread monitor.
 *
 * DISCOVERY (Task 31 research):
 *   PAXG (Paxos Gold) and XAUT (Tether Gold) both represent 1 oz of physical gold.
 *   $5.9B combined market cap. Multi-venue: Binance, Kraken, LMAX, DEXs.
 *   Persistent weekend spreads when CME futures close — PAXG/XAUT become
 *   gold price discovery and can diverge from each other.
 *
 * STRATEGY:
 *   1. Get PAXG price from multiple venues (Binance, Kraken, Uniswap)
 *   2. Get XAUT price from multiple venues (Binance, Kraken, Uniswap)
 *   3. Compare PAXG vs XAUT price (should be ~1:1 = same 1 oz gold)
 *   4. If spread > threshold, alert
 *   5. Also compare to spot gold price (LBMA fix) for premium/discount
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';

export interface GoldArbParams {
  /** Min spread % between PAXG and XAUT (default 0.3%) */
  minSpreadPct: number;
  /** Max position size (default $10,000) */
  maxSizeUsd: number;
}

export interface GoldArbAlert {
  paxgPrice: number;
  xautPrice: number;
  spreadPct: number;
  direction: 'buy_paxg_sell_xaut' | 'buy_xaut_sell_paxg';
  estimatedProfitUsd: number;
  venues: string[];
  ts: number;
}

export class GoldArbScanner implements Strategy {
  readonly id = 'gold_arb';
  readonly landscape = 'A_dex_cex' as const;

  constructor(private params: GoldArbParams) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 15,
      maxSizeUsd: this.params.maxSizeUsd,
      maxConcurrent: 1,
      cooldownMs: 5 * 60_000,
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<GoldArbAlert[]> {
    const alerts: GoldArbAlert[] = [];

    // Get PAXG and XAUT prices from Binance
    const [paxgPrice, xautPrice] = await Promise.all([
      this.getBinancePrice('PAXGUSDT'),
      this.getBinancePrice('XAUTUSDT'),
    ]);

    if (paxgPrice <= 0 || xautPrice <= 0) return alerts;

    const spreadPct = ((paxgPrice - xautPrice) / xautPrice) * 100;

    if (Math.abs(spreadPct) < this.params.minSpreadPct) return alerts;

    const feePct = 0.10;  // 10 bps round-trip
    const netProfitPct = Math.abs(spreadPct) - feePct;
    if (netProfitPct <= 0) return alerts;

    const estimatedProfitUsd = (netProfitPct / 100) * this.params.maxSizeUsd;

    alerts.push({
      paxgPrice,
      xautPrice,
      spreadPct,
      direction: spreadPct > 0 ? 'buy_xaut_sell_paxg' : 'buy_paxg_sell_xaut',
      estimatedProfitUsd,
      venues: ['Binance'],
      ts: Date.now(),
    });

    return alerts;
  }

  private async getBinancePrice(symbol: string): Promise<number> {
    try {
      const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
      if (!res.ok) return 0;
      const data = await res.json() as { price: string };
      return parseFloat(data.price) || 0;
    } catch {
      return 0;
    }
  }
}
