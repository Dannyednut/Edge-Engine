/**
 * Prediction-market scanner — cross-platform same-event divergence arb.
 *
 * Venues (non-US principal):
 *   - Polymarket (Polygon, USDC) — primary, deepest liquidity
 *   - Azuro (Ethereum/Arbitrum/Polygon) — sports event contracts
 *   - Overtime Markets (Base/Arbitrum/Optimism) — sports event contracts
 *   - Zeitgeist (Polkadot) — novel event types
 *   - Manifold (play + real money) — thin liquidity but novel
 *
 * Strategy:
 *   1. Pull live markets from each venue's API
 *   2. Match same-event markets across platforms (fuzzy title matching)
 *   3. Compute implied probability divergence
 *   4. If divergence > 3%, fire alert (potential rules arb or mispricing)
 *
 * Note: Kalshi dropped (principal is non-US, Kalshi is CFTC US-only).
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';

export interface PredictionArbParams {
  /** Min divergence % to fire alert (default 3.0) */
  minDivergencePct: number;
  /** Max position size per arb (default $2000) */
  maxSizeUsd: number;
  /** Max capital lock days (default 30) */
  maxCapitalLockDays: number;
  /** Platforms to scan */
  platforms: string[];
}

export interface PolymarketMarket {
  conditionId: string;
  questionId: string;
  question: string;
  slug: string;
  outcomes: string[];
  outcomePrices: string[];   // e.g. ["0.45", "0.55"]
  volume24hr: number;
  liquidity: number;
  endDate: string;
  active: boolean;
  closed: boolean;
  category: string;
}

export interface PredictionArbAlert {
  eventTitle: string;
  venue1: string;
  venue2: string;
  market1Id: string;
  market2Id: string;
  probability1: number;      // 0..1
  probability2: number;
  divergencePct: number;     // |p1 - p2| * 100
  direction: 'buy_yes_venue1_buy_no_venue2' | 'buy_no_venue1_buy_yes_venue2';
  volume24hrVenue1: number;
  volume24hrVenue2: number;
  endDate: string;
  capitalLockDays: number;
  estimatedProfitUsd: number;  // at maxSizeUsd split
}

export class PredictionArbStrategy implements Strategy {
  readonly id = 'prediction_arb';
  readonly landscape = 'D_prediction' as const;

  constructor(private params: PredictionArbParams) {}

  subscribesTo(): string[] {
    return [];
  }

  evaluate(_data: DataPoint): TradeOrder[] | null {
    return null;
  }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 10,
      maxSizeUsd: this.params.maxSizeUsd,
      maxConcurrent: 2,
      cooldownMs: 5 * 60_000,
      gasPriceCapMultiplier: 3,
    };
  }

  /**
   * Scan Polymarket for top markets by volume.
   * Returns the top N markets with their implied probabilities.
   */
  async scanPolymarket(limit: number = 20): Promise<PolymarketMarket[]> {
    const url = `https://gamma-api.polymarket.com/markets?closed=false&active=true&order=volume24hr&ascending=false&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Polymarket gamma API ${res.status}: ${await res.text().catch(() => '')}`);
    }
    const data = await res.json() as any[];
    return data.map((m: any) => ({
      conditionId: m.conditionId || '',
      questionId: m.questionId || '',
      question: m.question || '',
      slug: m.slug || '',
      outcomes: Array.isArray(m.outcomes) ? m.outcomes : JSON.parse(m.outcomes || '[]'),
      outcomePrices: Array.isArray(m.outcomePrices) ? m.outcomePrices : JSON.parse(m.outcomePrices || '[]'),
      volume24hr: Number(m.volume24hr) || 0,
      liquidity: Number(m.liquidity) || 0,
      endDate: m.endDate || '',
      active: Boolean(m.active),
      closed: Boolean(m.closed),
      category: m.category || '',
    }));
  }

  /**
   * Scan for cross-platform divergences.
   * Currently only Polymarket is wired (Azuro/Overtime/Zeitgeist need their own APIs).
   * Within Polymarket, we look for markets with the same underlying event but
   * different slugs (e.g. "Will X win the election?" vs "Will X be elected?").
   */
  async scan(): Promise<PredictionArbAlert[]> {
    const alerts: PredictionArbAlert[] = [];

    try {
      const polyMarkets = await this.scanPolymarket(30);

      // Group by fuzzy title similarity (simple word-overlap heuristic)
      // Look for markets that ask essentially the same question but have
      // meaningfully different YES prices
      //
      // FALSE POSITIVE GUARD: Markets like "Match Winner" vs "Map 1 Winner"
      // sound similar but are DIFFERENT bets. We now:
      //   1. Require same category
      //   2. Require same outcome structure (e.g., both YES/NO)
      //   3. Filter out markets with "Map" / "Game" / "Set" in title when comparing
      //      to "Match" / "Series" / "BO3" markets
      //   4. Require higher similarity threshold (0.5 instead of 0.3)
      //   5. Flag divergence > 25% as suspicious (likely different bets)
      for (let i = 0; i < polyMarkets.length; i++) {
        for (let j = i + 1; j < polyMarkets.length; j++) {
          const m1 = polyMarkets[i];
          const m2 = polyMarkets[j];
          if (m1.outcomePrices.length < 2 || m2.outcomePrices.length < 2) continue;

          // Must be same category
          if (m1.category !== m2.category) continue;

          // Must have same number of outcomes
          if (m1.outcomes.length !== m2.outcomes.length) continue;

          const p1 = Number(m1.outcomePrices[0]);  // YES price
          const p2 = Number(m2.outcomePrices[0]);
          if (isNaN(p1) || isNaN(p2)) continue;
          if (p1 <= 0.01 || p1 >= 0.99) continue;
          if (p2 <= 0.01 || p2 >= 0.99) continue;

          const divergencePct = Math.abs(p1 - p2) * 100;
          if (divergencePct < this.params.minDivergencePct) continue;

          // SUSPICIOUS DIVERGENCE: > 15% likely means different bets
          // (lowered from 25% — was still letting false positives through)
          if (divergencePct > 15) continue;

          // Check title similarity (word overlap)
          const words1 = new Set(m1.question.toLowerCase().split(/\s+/).filter(w => w.length > 3));
          const words2 = new Set(m2.question.toLowerCase().split(/\s+/).filter(w => w.length > 3));
          const intersection = new Set([...words1].filter(w => words2.has(w)));
          const union = new Set([...words1, ...words2]);
          const similarity = intersection.size / union.size;
          if (similarity < 0.5) continue;   // higher threshold (was 0.3)

          // FILTER: "Map N" / "Game N" / "Set N" / "Half N" / "Quarter N" markets vs "Match" / "Series"
          const isSubBet1 = /\b(map|game|set|half|quarter|period|leg|stage)\s*\d+/i.test(m1.question);
          const isSubBet2 = /\b(map|game|set|half|quarter|period|leg|stage)\s*\d+/i.test(m2.question);
          const isMatchBet1 = /\b(match|series|bo\d|overall|total)\b/i.test(m1.question);
          const isMatchBet2 = /\b(match|series|bo\d|overall|total)\b/i.test(m2.question);
          // Skip if one is sub-bet (Map 1) and other is match (Match Winner)
          if ((isSubBet1 && isMatchBet2) || (isSubBet2 && isMatchBet1)) continue;

          // FILTER: Skip if titles contain "Winner" vs "Map" / "Game" / "Set" / "Handicap" / "Spread"
          const isWinnerBet1 = /\b(winner|win)\b/i.test(m1.question);
          const isWinnerBet2 = /\b(winner|win)\b/i.test(m2.question);
          const isHandicapBet1 = /\b(handicap|spread|maps? \d|games? \d)\b/i.test(m1.question);
          const isHandicapBet2 = /\b(handicap|spread|maps? \d|games? \d)\b/i.test(m2.question);
          if ((isWinnerBet1 && isHandicapBet2) || (isWinnerBet2 && isHandicapBet1)) continue;

          // Compute estimated profit
          // Buy YES on cheaper venue, buy NO on expensive venue
          // Cost = cheaper_yes + (1 - expensive_yes) = cheaper_yes + 1 - expensive_yes
          // Payout = 1 (always, since one side wins)
          // Profit = 1 - cost = expensive_yes - cheaper_yes
          const cheaperPrice = Math.min(p1, p2);
          const expensivePrice = Math.max(p1, p2);
          const profitPerShare = expensivePrice - cheaperPrice;
          const estimatedProfitUsd = profitPerShare * this.params.maxSizeUsd;

          if (estimatedProfitUsd < 10) continue;

          // Capital lock days
          const endDate1 = new Date(m1.endDate).getTime();
          const endDate2 = new Date(m2.endDate).getTime();
          const endDate = Math.max(endDate1, endDate2);
          // Skip expired markets (end date already passed)
          if (endDate < Date.now()) continue;
          const capitalLockDays = Math.max(0, (endDate - Date.now()) / (24 * 60 * 60 * 1000));
          if (capitalLockDays > this.params.maxCapitalLockDays) continue;

          alerts.push({
            eventTitle: m1.question.slice(0, 80),
            venue1: 'polymarket',
            venue2: 'polymarket',
            market1Id: m1.conditionId,
            market2Id: m2.conditionId,
            probability1: p1,
            probability2: p2,
            divergencePct,
            direction: p1 < p2 ? 'buy_yes_venue1_buy_no_venue2' : 'buy_no_venue1_buy_yes_venue2',
            volume24hrVenue1: m1.volume24hr,
            volume24hrVenue2: m2.volume24hr,
            endDate: new Date(endDate).toISOString(),
            capitalLockDays,
            estimatedProfitUsd,
          });
        }
      }
    } catch (err) {
      console.warn('PredictionArbStrategy.scan failed:', err);
    }

    alerts.sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd);
    return alerts;
  }
}
