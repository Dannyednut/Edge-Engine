/**
 * StablecoinDepegScanner — detects stablecoin depeg arbitrage opportunities.
 *
 * When a stablecoin deviates from $1:
 *   - Below $1 (e.g., $0.97): BUY → sell at $1 when repegs
 *   - Above $1 (e.g., $1.03): SHORT → cover at $1 when repegs
 *
 * Historical events:
 *   - USDC (March 2023, SVB collapse): $1 → $0.87 → repegged in 3 days = 13% profit
 *   - DAI (March 2023): $1 → $0.98 → repegged in 2 days = 2% profit
 *   - UST (May 2022): $1 → $0.01 → NEVER repegged (AVOID algorithmic stablecoins)
 *
 * MIGRATED FROM scripts-explore:
 *   - stablecoin-depeg-scanner.mts
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';

export interface DepegParams {
  /** Min depeg % to alert (default 0.3%) */
  minDepegPct: number;
  /** Alert threshold for major depeg (default 2%) */
  majorDepegPct: number;
}

export interface DepegAlert {
  stablecoin: string;
  price: number;
  depegPct: number;
  action: 'BUY' | 'SHORT' | 'WATCH';
  potentialProfitOn10k: number;
  riskScore: number;
  venue: string;
  ts: number;
}

const COINGECKO_IDS: Record<string, string> = {
  'usd-coin': 'USDC',
  'tether': 'USDT',
  'dai': 'DAI',
  'frax': 'FRAX',
  'true-usd': 'TUSD',
  'paypal-usd': 'PYUSD',
  'ethena-usde': 'USDe',
  'first-digital-usd': 'FDUSD',
};

export class StablecoinDepegScanner implements Strategy {
  readonly id = 'stablecoin_depeg';
  readonly landscape = 'B_cex_cex' as const;  // cross-venue stablecoin arb

  constructor(private params: DepegParams) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 100,
      maxSizeUsd: 10_000,
      maxConcurrent: 3,
      cooldownMs: 30 * 60_000,  // 30 min
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<DepegAlert[]> {
    const alerts: DepegAlert[] = [];

    try {
      const ids = Object.keys(COINGECKO_IDS).join(',');
      const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      if (!res.ok) return alerts;

      const j = await res.json() as any;

      for (const [id, data] of Object.entries(j)) {
        const price = (data as any).usd;
        if (!price) continue;

        const symbol = COINGECKO_IDS[id] || id;
        const depegPct = ((price - 1) / 1) * 100;
        const absDepeg = Math.abs(depegPct);

        if (absDepeg < this.params.minDepegPct) continue;

        let action: 'BUY' | 'SHORT' | 'WATCH' = 'WATCH';
        let riskScore = 3;

        if (depegPct < -this.params.majorDepegPct) {
          action = 'BUY';
          riskScore = depegPct < -5 ? 8 : 5;
        } else if (depegPct > this.params.majorDepegPct) {
          action = 'SHORT';
          riskScore = depegPct > 5 ? 8 : 5;
        } else if (absDepeg > this.params.minDepegPct) {
          action = 'WATCH';
          riskScore = 4;
        }

        alerts.push({
          stablecoin: symbol,
          price,
          depegPct,
          action,
          potentialProfitOn10k: 10000 * absDepeg / 100,
          riskScore,
          venue: 'CoinGecko (aggregated)',
          ts: Date.now(),
        });
      }

      alerts.sort((a, b) => Math.abs(b.depegPct) - Math.abs(a.depegPct));

    } catch (e: any) {
      console.warn(`[stablecoin_depeg] scan failed: ${e.message}`);
    }

    return alerts;
  }
}
