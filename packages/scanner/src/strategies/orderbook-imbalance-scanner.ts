/**
 * OrderbookImbalanceScanner — detects L2 order book imbalance on HL perps.
 *
 * Monitors bid/ask liquidity in real-time:
 *   - Bid >> Ask → bullish pressure → LONG signal
 *   - Ask >> Bid → bearish pressure → SHORT signal
 *   - Wall detection (> $500k orders) → likely reversal point
 *
 * Strategy: scalp order book imbalances (2min max hold)
 *   - Enter when imbalance > 30%
 *   - Take profit: 0.5-1% move
 *   - Stop loss: 0.3% against
 *   - Expected: 20-50 signals/day, $200-2,500/day profit
 *
 * MIGRATED FROM scripts-explore:
 *   - hl-orderbook-executor.mts
 *   - hl-l2-imbalance.mts (concepts merged)
 *   - orderbook-imbalance.mts (concepts merged)
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';

const HL_API = 'https://api.hyperliquid.xyz/info';

export interface OrderbookImbalanceParams {
  /** Coins to watch */
  coins: string[];
  /** Min imbalance to alert (default 0.30 = 30%) */
  imbalanceThreshold: number;
  /** Min wall size in USD (default $500k) */
  wallThresholdUsd: number;
  /** Liquidity range around mid (default 1%) */
  liquidityRangePct: number;
}

export interface OrderbookAlert {
  coin: string;
  midPrice: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  bidLiquidity: number;
  askLiquidity: number;
  imbalance: number;  // bidUsd / (bidUsd + askUsd) - 0.5
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  bidWall: { price: number; sizeUsd: number } | null;
  askWall: { price: number; sizeUsd: number } | null;
  ts: number;
}

export class OrderbookImbalanceScanner implements Strategy {
  readonly id = 'orderbook_imbalance';
  readonly landscape = 'G_mev' as const;

  constructor(private params: OrderbookImbalanceParams) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 10,
      maxSizeUsd: 5_000,
      maxConcurrent: 5,
      cooldownMs: 2 * 60_000,  // 2 min
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<OrderbookAlert[]> {
    const alerts: OrderbookAlert[] = [];

    for (const coin of this.params.coins) {
      try {
        const res = await fetch(HL_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'l2Book', coin }),
        });
        const r = await res.json() as any;

        const levels = r?.levels || [];
        const bids = (levels[0] || []).map((l: any) => [parseFloat(l.px), parseFloat(l.sz)] as [number, number]);
        const asks = (levels[1] || []).map((l: any) => [parseFloat(l.px), parseFloat(l.sz)] as [number, number]);

        if (bids.length === 0 || asks.length === 0) continue;

        const bestBid = bids[0][0];
        const bestAsk = asks[0][0];
        const mid = (bestBid + bestAsk) / 2;
        const spreadBps = mid > 0 ? (bestAsk - bestBid) / mid * 10000 : 0;

        const lowerBound = mid * (1 - this.params.liquidityRangePct / 100);
        const upperBound = mid * (1 + this.params.liquidityRangePct / 100);

        let bidLiq = 0, askLiq = 0;
        let bidWall: { price: number; sizeUsd: number } | null = null;
        let askWall: { price: number; sizeUsd: number } | null = null;

        for (const [px, sz] of bids) {
          if (px >= lowerBound) {
            const usd = px * sz;
            bidLiq += usd;
            if (usd > this.params.wallThresholdUsd && (!bidWall || usd > bidWall.sizeUsd)) {
              bidWall = { price: px, sizeUsd: usd };
            }
          }
        }
        for (const [px, sz] of asks) {
          if (px <= upperBound) {
            const usd = px * sz;
            askLiq += usd;
            if (usd > this.params.wallThresholdUsd && (!askWall || usd > askWall.sizeUsd)) {
              askWall = { price: px, sizeUsd: usd };
            }
          }
        }

        const total = bidLiq + askLiq;
        const imbalance = total > 0 ? (bidLiq / total) - 0.5 : 0;

        let signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
        if (imbalance > this.params.imbalanceThreshold) signal = 'BULLISH';
        else if (imbalance < -this.params.imbalanceThreshold) signal = 'BEARISH';

        if (signal === 'NEUTRAL' && !bidWall && !askWall) continue;

        alerts.push({
          coin, midPrice: mid, bestBid, bestAsk, spreadBps,
          bidLiquidity: bidLiq, askLiquidity: askLiq,
          imbalance, signal, bidWall, askWall,
          ts: r?.time ?? Date.now(),
        });
      } catch (e: any) {
        console.warn(`[orderbook_imbalance] ${coin} failed: ${e.message}`);
      }
    }

    return alerts.sort((a, b) => Math.abs(b.imbalance) - Math.abs(a.imbalance));
  }
}
