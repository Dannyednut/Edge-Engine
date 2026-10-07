/**
 * HlpYieldScanner — monitors Hyperliquid HLP vault yield.
 *
 * HLP (Hyperliquidity Provider) is Hyperliquid's native market-maker vault:
 *   - $180M+ TVL (as of Oct 7 2026)
 *   - Provides liquidity, performs liquidations, accrues platform fees
 *   - Historical average: 15-30% APR (per DefiLlama)
 *   - Vault address: 0xdfc24b077bc1425ad1dea75bcb6f8158e10df303
 *
 * STRATEGY:
 *   HLP is the SAFEST yield on Hyperliquid (team-operated, no smart contract risk
 *   beyond the HL protocol itself). When APR is favorable (>15%), deposit for
 *   passive yield. When APR is negative (drawdown), withdraw or avoid.
 *
 *   This scanner monitors the vault and alerts:
 *   - APR > 15% → ENTRY SIGNAL (good time to deposit)
 *   - APR < -5% → WARNING (drawdown in progress)
 *   - APR 5-15% → MONITORING (neutral zone)
 *
 * CURRENT STATUS (Oct 7 2026):
 *   1-day APR: -270% (HYPE pump caused losses — HLP likely short or arbed against)
 *   7-day APR: -78.65%
 *   30-day APR: -50.22%
 *   → NOT a good entry. Wait for APR to normalize.
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';

const HL_API = 'https://api.hyperliquid.xyz/info';
export const HLP_VAULT_ADDRESS = '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303';

export interface HlpYieldParams {
  /** Min APR to fire ENTRY signal (default 15%) */
  minEntryAprPct: number;
  /** Min APR (negative) to fire WARNING (default -5%) */
  warningAprPct: number;
  /** Timeframe to use for APR calculation: 'day', 'week', 'month' (default 'week') */
  timeframe: 'day' | 'week' | 'month';
}

export interface HlpYieldAlert {
  vaultAddress: string;
  vaultName: string;
  tvlUsd: number;
  apr1d: number;
  apr7d: number;
  apr30d: number;
  signal: 'ENTRY' | 'WARNING' | 'NEUTRAL';
  timeframe: 'day' | 'week' | 'month';
  currentApr: number;
  ts: number;
}

export class HlpYieldScanner implements Strategy {
  readonly id = 'hlp_yield';
  readonly landscape = 'F_perps_funding' as const;

  constructor(private params: HlpYieldParams) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 0,  // monitoring strategy
      maxSizeUsd: 50_000,
      maxConcurrent: 1,
      cooldownMs: 60 * 60_000,  // 1 hour
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<HlpYieldAlert[]> {
    const alerts: HlpYieldAlert[] = [];

    try {
      const r = await fetch(HL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'vaultDetails', vaultAddress: HLP_VAULT_ADDRESS }),
      });
      const data = await r.json() as any;
      if (!data || !data.portfolio) return alerts;

      // Extract APR for each timeframe
      const aprs: Record<string, number> = {};
      let tvl = 0;
      for (const [period, pdata] of data.portfolio as [string, any]) {
        const history = pdata.accountValueHistory || [];
        if (history.length < 2) continue;
        const latest = history[history.length - 1];
        const earliest = history[0];
        const latestValue = parseFloat(latest[1]);
        const earliestValue = parseFloat(earliest[1]);
        if (earliestValue <= 0) continue;
        const timeDiffDays = (latest[0] - earliest[0]) / 86400000;
        if (timeDiffDays <= 0) continue;
        const returnPct = ((latestValue - earliestValue) / earliestValue) * 100;
        const apr = (returnPct / timeDiffDays) * 365;
        aprs[period] = apr;
        if (period === this.params.timeframe) tvl = latestValue;
      }

      const apr1d = aprs['day'] ?? 0;
      const apr7d = aprs['week'] ?? 0;
      const apr30d = aprs['month'] ?? 0;
      const currentApr = aprs[this.params.timeframe] ?? apr7d;

      let signal: 'ENTRY' | 'WARNING' | 'NEUTRAL';
      if (currentApr >= this.params.minEntryAprPct) {
        signal = 'ENTRY';
      } else if (currentApr <= this.params.warningAprPct) {
        signal = 'WARNING';
      } else {
        signal = 'NEUTRAL';
      }

      alerts.push({
        vaultAddress: HLP_VAULT_ADDRESS,
        vaultName: data.name || 'HLP',
        tvlUsd: tvl,
        apr1d,
        apr7d,
        apr30d,
        signal,
        timeframe: this.params.timeframe,
        currentApr,
        ts: Date.now(),
      });
    } catch (e: any) {
      console.warn(`[hlp_yield] scan failed: ${e.message}`);
    }

    return alerts;
  }
}
