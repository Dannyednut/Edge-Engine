/**
 * TokenizedEquityScanner — monitoring-only scanner for tokenized equity
 * spot-perp basis arbitrage on Backpack exchange.
 *
 * DISCOVERY (Sep 30 2026):
 *   Backpack exchange (Solana) lists tokenized US equities:
 *     SPCX (SpaceX) — spot + perp
 *     SNDK (SanDisk) — spot + perp
 *     TSLA (Tesla) — perp only
 *     NVDA (NVIDIA) — perp only
 *     AAPL (Apple) — perp only
 *
 *   Last-price basis: 0.6-1.5% (perp at premium)
 *   Order book reality: 48-65% spreads, $0.01 bid depth
 *
 * STRATEGY:
 *   When liquidity improves (Q4 2026 DTCC tokenization launch):
 *   - Buy spot SPCX, short perp SPCX → capture basis + funding
 *   - Same for SNDK
 *
 * CURRENT MODE: MONITORING ONLY
 *   - Tracks basis (last price spot vs perp)
 *   - Tracks spread (best ask - best bid on each leg)
 *   - Alerts when spread < 2% AND depth > $500 per leg (actionable threshold)
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';

export interface TokenizedEquityParams {
  /** Min spread (%) to consider the market actionable (default 2.0%) */
  minActionableSpreadPct: number;
  /** Min depth (USD) per leg to consider actionable (default $500) */
  minActionableDepthUsd: number;
  /** Markets to monitor */
  markets: string[];
}

export interface TokenizedEquityAlert {
  symbol: string;
  spotPrice?: number;
  perpPrice?: number;
  basisPct: number;           // (perp - spot) / spot × 100
  spotSpreadPct?: number;     // (best_ask - best_bid) / mid × 100
  perpSpreadPct?: number;
  spotDepthUsd?: number;      // depth at best bid/ask
  perpDepthUsd?: number;
  actionable: boolean;        // true when spread + depth meet thresholds
  ts: number;
}

const BACKPACK_API = 'https://api.backpack.exchange/api/v1';

export class TokenizedEquityScanner implements Strategy {
  readonly id = 'tokenized_equity';
  readonly landscape = 'A_dex_cex' as const;  // closest existing landscape

  constructor(private params: TokenizedEquityParams) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 5,
      maxSizeUsd: 500,   // small — these are illiquid
      maxConcurrent: 1,
      cooldownMs: 5 * 60_000,
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<TokenizedEquityAlert[]> {
    const alerts: TokenizedEquityAlert[] = [];

    for (const symbol of this.params.markets) {
      try {
        const alert = await this.scanMarket(symbol);
        if (alert) alerts.push(alert);
      } catch (err) {
        console.warn(`[tokenized_equity] ${symbol} scan failed:`, err);
      }
    }

    alerts.sort((a, b) => b.basisPct - a.basisPct);
    return alerts;
  }

  private async scanMarket(symbol: string): Promise<TokenizedEquityAlert | null> {
    // Determine spot + perp symbols
    const spotSymbol = symbol.includes('_PERP') ? symbol.replace('_PERP', '') : symbol;
    const perpSymbol = symbol.includes('_PERP') ? symbol : `${symbol}_PERP`;

    // Fetch tickers
    const [spotTicker, perpTicker] = await Promise.all([
      this.fetchTicker(spotSymbol).catch(() => null),
      this.fetchTicker(perpSymbol).catch(() => null),
    ]);

    const spotPrice = spotTicker ? Number(spotTicker.lastPrice) : undefined;
    const perpPrice = perpTicker ? Number(perpTicker.lastPrice) : undefined;

    if (!spotPrice || !perpPrice) {
      // If only perp (TSLA, NVDA, AAPL), still track the price
      if (perpPrice) {
        return {
          symbol: perpSymbol,
          perpPrice,
          basisPct: 0,
          actionable: false,
          ts: Date.now(),
        };
      }
      return null;
    }

    const basisPct = ((perpPrice - spotPrice) / spotPrice) * 100;

    // Fetch order book depth
    const [spotDepth, perpDepth] = await Promise.all([
      this.fetchDepth(spotSymbol).catch(() => null),
      this.fetchDepth(perpSymbol).catch(() => null),
    ]);

    let spotSpreadPct: number | undefined;
    let perpSpreadPct: number | undefined;
    let spotDepthUsd: number | undefined;
    let perpDepthUsd: number | undefined;

    if (spotDepth && spotDepth.asks.length > 0 && spotDepth.bids.length > 0) {
      const bestAsk = Number(spotDepth.asks[0][0]);
      const bestBid = Number(spotDepth.bids[0][0]);
      const mid = (bestAsk + bestBid) / 2;
      spotSpreadPct = mid > 0 ? ((bestAsk - bestBid) / mid) * 100 : 0;
      spotDepthUsd = Number(spotDepth.asks[0][0]) * Number(spotDepth.asks[0][1]);
    }

    if (perpDepth && perpDepth.asks.length > 0 && perpDepth.bids.length > 0) {
      const bestAsk = Number(perpDepth.asks[0][0]);
      const bestBid = Number(perpDepth.bids[0][0]);
      const mid = (bestAsk + bestBid) / 2;
      perpSpreadPct = mid > 0 ? ((bestAsk - bestBid) / mid) * 100 : 0;
      perpDepthUsd = Number(perpDepth.asks[0][0]) * Number(perpDepth.asks[0][1]);
    }

    const actionable =
      (spotSpreadPct ?? 100) < this.params.minActionableSpreadPct &&
      (perpSpreadPct ?? 100) < this.params.minActionableSpreadPct &&
      (spotDepthUsd ?? 0) >= this.params.minActionableDepthUsd &&
      (perpDepthUsd ?? 0) >= this.params.minActionableDepthUsd;

    return {
      symbol: spotSymbol,
      spotPrice,
      perpPrice,
      basisPct,
      spotSpreadPct,
      perpSpreadPct,
      spotDepthUsd,
      perpDepthUsd,
      actionable,
      ts: Date.now(),
    };
  }

  private async fetchTicker(symbol: string): Promise<{ lastPrice: string } | null> {
    const res = await fetch(`${BACKPACK_API}/ticker?symbol=${symbol}`);
    if (!res.ok) return null;
    return res.json() as Promise<{ lastPrice: string }>;
  }

  private async fetchDepth(symbol: string): Promise<{ asks: [string, string][]; bids: [string, string][] } | null> {
    const res = await fetch(`${BACKPACK_API}/depth?symbol=${symbol}`);
    if (!res.ok) return null;
    return res.json() as Promise<{ asks: [string, string][]; bids: [string, string][] }>;
  }
}
