/**
 * SportsArbStrategy — cross-book sports betting arbitrage scanner.
 *
 * Uses The Odds API (the-odds-api.com) for live odds across 10+ sportsbooks.
 * Free tier: 500 requests/month, 10+ sports, US + EU + UK books.
 *
 * Strategy:
 *   1. Pull live odds for a sport from The Odds API
 *   2. For each event, find the best (highest) price for each outcome across books
 *   3. Sum the implied probabilities across outcomes
 *   4. If sum < 1.0 (i.e. < 100%), arbitrage exists: bet each outcome at the
 *      best book, lock in riskless profit = (1 - sum) × stake
 *   5. Fire alert when arb % > 1.0% (covers typical 4-5% vig)
 *
 * Sharp vs soft books:
 *   - Sharp (Pinnacle, Circa): welcome professional action, don't stake-limit
 *   - Soft (DraftKings, FanDuel, BetMGM): stake-limit winning arbers
 *   - Strategy: prioritize arbs where the sharp book is on one side
 *     (these are "real" market moves, not soft-book lag)
 *
 * Principal note: non-US jurisdiction. Some books may not be accessible.
 * The Odds API covers both US and EU/UK books — filter by region.
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';

export interface SportsArbParams {
  /** Min arb % to fire alert (default 1.0%) */
  minArbPct: number;
  /** Max bet size per leg (default $500 — soft books limit) */
  maxSizeUsd: number;
  /** Sports to scan (sport keys from The Odds API) */
  sports: string[];
  /** Regions to scan: us, uk, eu, au */
  regions: string[];
  /** Odds format: 'american' | 'decimal' */
  oddsFormat: 'american' | 'decimal';
  /** Bookmaker whitelist (empty = all books in region) */
  bookmakers: string[];
}

export interface SportsArbAlert {
  sport: string;
  event: string;
  startTime: string;
  outcomes: Array<{
    label: string;           // 'Eagles' / 'Bears' / 'Draw'
    bestBook: string;        // 'DraftKings' / 'Pinnacle'
    bestPrice: number;       // decimal odds (e.g. 1.85)
    impliedProb: number;     // 1 / bestPrice
  }>;
  totalImpliedProb: number;  // sum of all outcomes' implied prob
  arbPct: number;            // (1 - totalImpliedProb) × 100
  estimatedProfitUsd: number; // at maxSizeUsd stake
  hasSharpBook: boolean;     // true if Pinnacle/Circa on any leg
}

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

export class SportsArbStrategy implements Strategy {
  readonly id = 'sports_arb';
  readonly landscape = 'E_sports' as const;

  constructor(
    private apiKey: string | undefined,
    private params: SportsArbParams,
  ) {}

  subscribesTo(): string[] {
    return [];
  }

  evaluate(_data: DataPoint): TradeOrder[] | null {
    return null;
  }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 5,
      maxSizeUsd: this.params.maxSizeUsd,
      maxConcurrent: 5,
      cooldownMs: 60_000,
      gasPriceCapMultiplier: 3,
    };
  }

  /**
   * Scan live odds for arbs across sportsbooks.
   * Requires The Odds API key.
   */
  async scan(): Promise<SportsArbAlert[]> {
    if (!this.apiKey) {
      // No API key — can't scan. Return empty.
      return [];
    }

    const alerts: SportsArbAlert[] = [];

    for (const sport of this.params.sports) {
      try {
        const odds = await this.fetchOdds(sport);
        const arbs = this.findArbs(odds, sport);
        alerts.push(...arbs);
      } catch (err) {
        console.warn(`SportsArbStrategy: failed to fetch ${sport}:`, err);
      }
    }

    alerts.sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd);
    return alerts;
  }

  /**
   * Fetch live odds from The Odds API for a sport.
   */
  private async fetchOdds(sport: string): Promise<any[]> {
    const params = new URLSearchParams({
      apiKey: this.apiKey!,
      regions: this.params.regions.join(','),
      oddsFormat: this.params.oddsFormat,
    });
    if (this.params.bookmakers.length > 0) {
      params.set('bookmakers', this.params.bookmakers.join(','));
    }
    const url = `${ODDS_API_BASE}/sports/${sport}/odds/?${params}`;
    const res = await fetch(url);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`The Odds API ${sport} ${res.status}: ${errText.slice(0, 200)}`);
    }
    return res.json() as Promise<any[]>;
  }

  /**
   * Find arbitrage opportunities in a list of events with odds.
   */
  private findArbs(events: any[], sport: string): SportsArbAlert[] {
    const alerts: SportsArbAlert[] = [];
    const SHARP_BOOKS = new Set(['pinnacle', 'circa', 'matchbook']);

    for (const event of events) {
      if (!event.bookmakers || event.bookmakers.length === 0) continue;

      // For each market type (h2h, spreads, totals), find best price per outcome
      const marketTypes = new Set<string>();
      for (const book of event.bookmakers) {
        for (const market of (book.markets || [])) {
          if (market.key) marketTypes.add(market.key);
        }
      }

      for (const marketKey of marketTypes) {
        // Collect best price per outcome across all books
        const outcomeBests = new Map<string, { book: string; price: number }>();

        for (const book of event.bookmakers) {
          const market = (book.markets || []).find((m: any) => m.key === marketKey);
          if (!market || !market.outcomes) continue;

          for (const outcome of market.outcomes) {
            const label = outcome.name;
            const price = Number(outcome.price);
            if (!price || price <= 1.0) continue;  // skip invalid prices

            const current = outcomeBests.get(label);
            if (!current || price > current.price) {
              outcomeBests.set(label, { book: book.title, price });
            }
          }
        }

        // Compute total implied probability
        if (outcomeBests.size < 2) continue;  // need at least 2 outcomes

        let totalImpliedProb = 0;
        const outcomes: SportsArbAlert['outcomes'] = [];
        let hasSharpBook = false;

        for (const [label, { book, price }] of outcomeBests) {
          const impliedProb = 1 / price;
          totalImpliedProb += impliedProb;
          outcomes.push({ label, bestBook: book, bestPrice: price, impliedProb });
          if (SHARP_BOOKS.has(book.toLowerCase())) hasSharpBook = true;
        }

        const arbPct = (1 - totalImpliedProb) * 100;

        if (arbPct >= this.params.minArbPct) {
          alerts.push({
            sport,
            event: `${event.home_team} vs ${event.away_team}`,
            startTime: event.commence_time || '',
            outcomes,
            totalImpliedProb,
            arbPct,
            estimatedProfitUsd: (arbPct / 100) * this.params.maxSizeUsd,
            hasSharpBook,
          });
        }
      }
    }

    return alerts;
  }

  /**
   * Get usage info for The Odds API (remaining requests).
   */
  async getUsage(): Promise<{ used: number; remaining: number; last: string } | null> {
    if (!this.apiKey) return null;
    try {
      // The Odds API returns usage headers on every response
      // We can make a lightweight call to get them
      const res = await fetch(`${ODDS_API_BASE}/sports/?apiKey=${this.apiKey}`);
      return {
        used: Number(res.headers.get('x-requests-used') || 0),
        remaining: Number(res.headers.get('x-requests-remaining') || 0),
        last: res.headers.get('x-requests-last') || '',
      };
    } catch {
      return null;
    }
  }
}
