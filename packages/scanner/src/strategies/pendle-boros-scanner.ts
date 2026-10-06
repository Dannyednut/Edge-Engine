/**
 * PendleBorosScanner — funding rate swap arbitrage via Pendle Boros.
 *
 * NEW LANDSCAPE (verified live Oct 1 2026):
 *   Pendle Boros (api-boros.pendle.finance) lets you trade FUNDING RATES
 *   directly as fixed-yield instruments with maturity dates. 50+ markets
 *   covering Binance, Hyperliquid, OKX funding rates for BTC/ETH/SOL/etc.
 *
 * THE ARB:
 *   Each market has:
 *     - markApr:    current implied fixed yield (what you lock in by buying)
 *     - floatingApr: actual current floating funding rate on the source venue
 *
 *   If markApr < floatingApr: BUY fixed → lock in (floatingApr - markApr) spread
 *   If markApr > floatingApr: SELL fixed → lock in (markApr - floatingApr) spread
 *
 *   Example (live Oct 1 2026):
 *     Hyperliquid BTC: markApr 10.76%, floatingApr 10.95% → spread 0.19%
 *     Binance ETH:     markApr 9.60%,  floatingApr 9.83%  → spread 0.23%
 *
 *   This is a NEW arb landscape — we are trading the funding rate itself,
 *   not the perp position. No delta exposure. Pure yield curve arbitrage.
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';

const BOROS_API = 'https://api-boros.pendle.finance/apis/v1';

export interface PendleBorosParams {
  /** Min spread (APR difference) to fire alert (default 0.5%) */
  minSpreadApr: number;
  /** Max position size (default $5000) */
  maxSizeUsd: number;
  /** Min OI (notional open interest) for liquidity (default $10,000) */
  minNotionalOI: number;
  /** Platforms to scan (empty = all) */
  platforms: string[];
  /** Min 24h volume (default $50k — filters illiquid markets) */
  minVolume24h?: number;
  /** Min days to maturity (default 7 — filters markets expiring too soon) */
  minDaysToMaturity?: number;
  /** Spread persistence — require spread to hold across N scans (default 1 = no persistence) */
  minSpreadPersistence?: number;
}

export interface BorosMarket {
  marketId: number;
  address: string;
  name: string;
  symbol: string;
  platform: string;            // 'Binance', 'Hyperliquid', 'OKX'
  underlying: string;          // 'BTC', 'ETH', 'SOL'
  maturity: number;            // epoch ms
  markApr: number;             // implied fixed yield
  floatingApr: number;         // actual current funding rate
  lastTradedApr: number;
  midApr: number;
  bestBid?: number;
  bestAsk?: number;
  volume24h: number;
  notionalOI: number;          // open interest in USD
  maxLeverage: number;
  nextSettlementTime: number;
}

export interface BorosArbAlert {
  market: BorosMarket;
  spreadApr: number;           // |markApr - floatingApr| × 100
  direction: 'buy_fixed' | 'sell_fixed';
  estimatedProfitUsd: number;  // at maxSizeUsd, held to maturity
  daysToMaturity: number;
  annualizedReturnPct: number; // spread / maxSizeUsd × 365 / daysToMaturity
}

export class PendleBorosScanner implements Strategy {
  readonly id = 'pendle_boros';
  readonly landscape = 'F_perps_funding' as const;

  // Persistence tracking: marketId → array of recent spread values
  private spreadHistory = new Map<number, number[]>();
  private static readonly HISTORY_SIZE = 5;

  constructor(private params: PendleBorosParams) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 10,
      maxSizeUsd: this.params.maxSizeUsd,
      maxConcurrent: 3,
      cooldownMs: 5 * 60_000,
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<BorosArbAlert[]> {
    const markets = await this.fetchMarkets();
    const alerts: BorosArbAlert[] = [];

    for (const m of markets) {
      // Filter by platform
      if (this.params.platforms.length > 0 && !this.params.platforms.includes(m.platform)) continue;

      // Filter by liquidity (OI)
      if (m.notionalOI < this.params.minNotionalOI) continue;

      // Filter by 24h volume (default $50k — illiquid markets have stale spreads)
      if (this.params.minVolume24h && m.volume24h < this.params.minVolume24h) continue;

      // Compute spread
      const spread = m.floatingApr - m.markApr;  // positive = buy fixed (lock in yield)
      const spreadApr = Math.abs(spread) * 100;

      if (spreadApr < this.params.minSpreadApr) continue;

      // Compute days to maturity
      const daysToMaturity = Math.max(1, (m.maturity - Date.now()) / (24 * 60 * 60 * 1000));

      // Filter by min days to maturity (default 7)
      if (this.params.minDaysToMaturity && daysToMaturity < this.params.minDaysToMaturity) continue;

      // Spread persistence check: require spread to hold across N consecutive scans
      const persistenceRequired = this.params.minSpreadPersistence ?? 1;
      if (persistenceRequired > 1) {
        const history = this.spreadHistory.get(m.marketId) ?? [];
        history.push(spreadApr);
        if (history.length > PendleBorosScanner.HISTORY_SIZE) history.shift();
        this.spreadHistory.set(m.marketId, history);
        // Need at least persistenceRequired entries AND all must be above threshold
        if (history.length < persistenceRequired) continue;
        const recentN = history.slice(-persistenceRequired);
        if (!recentN.every(v => v >= this.params.minSpreadApr)) continue;
      }

      // Estimated profit: spread × size × (daysToMaturity / 365)
      const estimatedProfitUsd = (spreadApr / 100) * this.params.maxSizeUsd * (daysToMaturity / 365);

      // Annualized return
      const annualizedReturnPct = spreadApr * (365 / daysToMaturity);

      alerts.push({
        market: m,
        spreadApr,
        direction: spread > 0 ? 'buy_fixed' : 'sell_fixed',
        estimatedProfitUsd,
        daysToMaturity,
        annualizedReturnPct,
      });
    }

    alerts.sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd);
    return alerts;
  }

  private async fetchMarkets(): Promise<BorosMarket[]> {
    const markets: BorosMarket[] = [];
    let skip = 0;
    const limit = 50;

    // Paginate through all markets
    for (let page = 0; page < 5; page++) {  // max 5 pages = 250 markets
      const url = `${BOROS_API}/markets?limit=${limit}&skip=${skip}`;
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`[pendle_boros] API ${res.status}: ${await res.text().catch(() => '')}`);
        break;
      }

      const json = await res.json() as { results: any[]; resumeToken?: string };
      if (!json.results || json.results.length === 0) break;

      for (const m of json.results) {
        try {
          markets.push(this.parseMarket(m));
        } catch { /* skip malformed */ }
      }

      skip += limit;
      if (json.results.length < limit) break;  // no more pages
    }

    return markets;
  }

  private parseMarket(m: any): BorosMarket {
    return {
      marketId: m.marketId,
      address: m.address,
      name: m.imData?.name || m.metadata?.name || 'unknown',
      symbol: m.imData?.symbol || '',
      platform: m.platform?.name || 'unknown',
      underlying: m.metadata?.underlyingSymbol || '',
      maturity: (m.imData?.maturity || 0) * 1000,  // sec → ms
      markApr: m.data?.markApr || 0,
      floatingApr: m.data?.floatingApr || 0,
      lastTradedApr: m.data?.lastTradedApr || 0,
      midApr: m.data?.midApr || 0,
      bestBid: m.data?.bestBid,
      bestAsk: m.data?.bestAsk,
      volume24h: m.data?.volume24h || 0,
      notionalOI: m.data?.notionalOI || 0,
      maxLeverage: m.metadata?.maxLeverage || 1,
      nextSettlementTime: (m.data?.nextSettlementTime || 0) * 1000,
    };
  }
}
