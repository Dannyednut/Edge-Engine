/**
 * SportsArbStrategy — real sports arbitrage via The Odds API.
 *
 * Scans 80+ sports for arbitrage opportunities across bookmakers.
 * When combined implied probability < 100% → guaranteed profit.
 *
 * Strategy:
 *   - Team A at Book X @ 2.05 (48.8% implied)
 *   - Team B at Book Y @ 1.80 (55.6% implied)
 *   - Total implied: 104.3% → NO ARB (books always have vig)
 *   - But if Team A @ 2.10 (47.6%) + Team B @ 1.85 (54.1%) = 101.7% → still no arb
 *   - Real arbs are rare (~1-2% of games) but guaranteed when found
 *
 * Data source: The Odds API (api.the-odds-api.com)
 * Coverage: NFL, NBA, MLB, NHL, soccer, tennis, MMA, etc.
 * Rate limit: 500 requests/month (free tier)
 *
 * ENHANCES: existing sports-arb.ts (which used hardcoded data)
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';

const ODDS_API = 'https://api.the-odds-api.com/v4';

export interface SportsArbParams {
  /** Sports to scan (default: top 5 US sports) */
  sports: string[];
  /** Min arb % to report (default 1%) */
  minArbPct: number;
  /** Regions to scan (default: us) */
  regions: string;
  /** Odds format (default: decimal) */
  oddsFormat: 'decimal' | 'american';
}

export interface SportsArbAlert {
  sport: string;
  event: string;
  commenceTime: string;
  teamA: string;
  teamB: string;
  bookA: string;
  bookB: string;
  oddsA: number;
  oddsB: number;
  impliedProbA: number;
  impliedProbB: number;
  totalImplied: number;
  arbPct: number;
  profitOn1k: number;
  ts: number;
}

const DEFAULT_SPORTS = [
  'basketball_nba',
  'americanfootball_nfl',
  'baseball_mlb',
  'icehockey_nhl',
  'soccer_epl',
];

export class SportsArbStrategy implements Strategy {
  readonly id = 'sports_arb';
  readonly landscape = 'E_sports' as const;

  constructor(private params: SportsArbParams) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 10,
      maxSizeUsd: 2_000,
      maxConcurrent: 5,
      cooldownMs: 5 * 60_000,
      gasPriceCapMultiplier: 1,  // off-chain, no gas
    };
  }

  async scan(): Promise<SportsArbAlert[]> {
    const alerts: SportsArbAlert[] = [];
    const apiKey = process.env.ODDS_API_KEY;
    if (!apiKey) return alerts;

    for (const sport of (this.params.sports || DEFAULT_SPORTS)) {
      try {
        const url = `${ODDS_API}/sports/${sport}/odds/?apiKey=${apiKey}&regions=${this.params.regions}&markets=h2h&oddsFormat=${this.params.oddsFormat}`;
        const res = await fetch(url);
        if (!res.ok) continue;

        const games = await res.json() as any[];

        for (const game of games) {
          const bookmakers = game.bookmakers || [];
          if (bookmakers.length < 2) continue;

          // Find the best odds for each team across all bookmakers
          let bestA: { book: string; odds: number } | null = null;
          let bestB: { book: string; odds: number } | null = null;

          for (const bm of bookmakers) {
            const h2h = bm.markets?.find((m: any) => m.key === 'h2h');
            if (!h2h) continue;

            const outcomeA = h2h.outcomes?.find((o: any) => o.name === game.away_team);
            const outcomeB = h2h.outcomes?.find((o: any) => o.name === game.home_team);

            if (outcomeA && (!bestA || outcomeA.price > bestA.odds)) {
              bestA = { book: bm.title, odds: outcomeA.price };
            }
            if (outcomeB && (!bestB || outcomeB.price > bestB.odds)) {
              bestB = { book: bm.title, odds: outcomeB.price };
            }
          }

          if (!bestA || !bestB || bestA.book === bestB.book) continue;

          const impliedA = 1 / bestA.odds;
          const impliedB = 1 / bestB.odds;
          const totalImplied = impliedA + impliedB;

          // Arb exists when total implied < 1.0 (100%)
          if (totalImplied >= 1.0) continue;

          const arbPct = (1 - totalImplied) * 100;
          if (arbPct < this.params.minArbPct) continue;

          const event = `${game.away_team} vs ${game.home_team}`;
          alerts.push({
            sport,
            event,
            commenceTime: game.commence_time,
            teamA: game.away_team,
            teamB: game.home_team,
            bookA: bestA.book,
            bookB: bestB.book,
            oddsA: bestA.odds,
            oddsB: bestB.odds,
            impliedProbA: impliedA * 100,
            impliedProbB: impliedB * 100,
            totalImplied: totalImplied * 100,
            arbPct,
            profitOn1k: 1000 * arbPct / 100,
            ts: Date.now(),
          });
        }
      } catch (e: any) {
        console.warn(`[sports_arb] ${sport} failed: ${e.message}`);
      }
    }

    alerts.sort((a, b) => b.arbPct - a.arbPct);
    return alerts;
  }
}
