/**
 * WhaleSignalScanner — detects whale activity and TVL momentum signals.
 *
 * Two signal types:
 *   1. HL whale activity: high vol/OI ratio = whale playground,
 *      funding anomalies = whale squeeze indicators
 *   2. Protocol TVL momentum: TVL growing = bullish, declining = bearish
 *      (uses DefiLlama protocols API, 8,694 protocols analyzed)
 *
 * This is DIRECTIONAL (not delta-neutral). Use with small positions (max 5% portfolio).
 *
 * MIGRATED FROM scripts-explore:
 *   - whale-tracker.mts
 *   - social-signal-tracker.mts
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';

const HL_API = 'https://api.hyperliquid.xyz/info';
const PROTOCOLS_API = 'https://api.llama.fi/protocols';

export interface WhaleSignalParams {
  /** Min vol/OI ratio for whale activity (default 0.5) */
  minVolOiRatio: number;
  /** Min TVL change % to report (default 5%) */
  minTvlChangePct: number;
  /** Min TVL for protocol signals (default $5M) */
  minProtocolTvl: number;
}

export interface WhaleSignalAlert {
  type: 'WHALE_ACTIVITY' | 'TVL_BULLISH' | 'TVL_BEARISH';
  source: string;
  asset: string;
  detail: string;
  signal: 'STRONG' | 'MEDIUM' | 'WEAK';
  tvlChange1d: number;
  tvlChange7d: number;
  tvlUsd: number;
  action: string;
  riskScore: number;
  ts: number;
}

export class WhaleSignalScanner implements Strategy {
  readonly id = 'whale_signal';
  readonly landscape = 'G_mev' as const;

  constructor(private params: WhaleSignalParams) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 0,
      maxSizeUsd: 5_000,  // max 5% of $100k portfolio
      maxConcurrent: 5,
      cooldownMs: 15 * 60_000,
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<WhaleSignalAlert[]> {
    const alerts: WhaleSignalAlert[] = [];

    // 1. HL whale activity signals
    try {
      const res = await fetch(HL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      });
      const r = await res.json() as any;

      const universe = r?.[0]?.universe || [];
      const ctxs = r?.[1] || [];

      for (let i = 0; i < universe.length; i++) {
        const u = universe[i];
        const ctx = ctxs[i];
        if (!u || !ctx || u.name.startsWith('@')) continue;

        const oi = parseFloat(ctx.openInterest) * parseFloat(ctx.markPx);
        const volume24h = parseFloat(ctx.dayNtlVlm) || 0;
        if (oi < 5_000_000 || volume24h < 10_000_000) continue;

        const volOiRatio = volume24h / oi;
        if (volOiRatio < this.params.minVolOiRatio) continue;

        const fundingHourly = parseFloat(ctx.funding) || 0;
        const fundingAnnual = fundingHourly * 24 * 365 * 100;

        let whaleActivity = volOiRatio > 1 ? 'HIGH' : volOiRatio > 0.5 ? 'MEDIUM' : 'LOW';

        alerts.push({
          type: 'WHALE_ACTIVITY',
          source: 'Hyperliquid',
          asset: u.name,
          detail: `Vol/OI=${volOiRatio.toFixed(2)}, OI=$${(oi / 1e6).toFixed(1)}M, Vol=$${(volume24h / 1e6).toFixed(1)}M, Funding=${fundingAnnual.toFixed(0)}/yr`,
          signal: whaleActivity === 'HIGH' ? 'STRONG' : whaleActivity === 'MEDIUM' ? 'MEDIUM' : 'WEAK',
          tvlChange1d: 0,
          tvlChange7d: 0,
          tvlUsd: oi,
          action: whaleActivity === 'HIGH' ? 'MONITOR_FOR_FRONT_RUN' : 'WATCH',
          riskScore: 6,
          ts: Date.now(),
        });
      }
    } catch (e: any) {
      console.warn(`[whale_signal] HL scan failed: ${e.message}`);
    }

    // 2. TVL momentum signals (via DefiLlama)
    try {
      const res = await fetch(PROTOCOLS_API, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const protocols = await res.json() as any[];

      for (const p of protocols) {
        if (!p.tvl || p.tvl < this.params.minProtocolTvl) continue;

        const change1d = p.change_1d || 0;
        const change7d = p.change_7d || 0;

        if (change1d > this.params.minTvlChangePct) {
          alerts.push({
            type: 'TVL_BULLISH',
            source: 'DefiLlama',
            asset: p.symbol || p.name,
            detail: `TVL +${change1d.toFixed(1)}% 1d, +${change7d.toFixed(1)}% 7d`,
            signal: change1d > 10 ? 'STRONG' : change1d > 5 ? 'MEDIUM' : 'WEAK',
            tvlChange1d: change1d,
            tvlChange7d: change7d,
            tvlUsd: p.tvl,
            action: change1d > 10 ? 'ACCUMULATE' : 'WATCH',
            riskScore: 6,
            ts: Date.now(),
          });
        } else if (change1d < -this.params.minTvlChangePct) {
          alerts.push({
            type: 'TVL_BEARISH',
            source: 'DefiLlama',
            asset: p.symbol || p.name,
            detail: `TVL ${change1d.toFixed(1)}% 1d, ${change7d.toFixed(1)}% 7d`,
            signal: change1d < -10 ? 'STRONG' : 'MEDIUM',
            tvlChange1d: change1d,
            tvlChange7d: change7d,
            tvlUsd: p.tvl,
            action: change1d < -10 ? 'SHORT_CANDIDATE' : 'AVOID',
            riskScore: 7,
            ts: Date.now(),
          });
        }
      }
    } catch (e: any) {
      console.warn(`[whale_signal] TVL scan failed: ${e.message}`);
    }

    // Sort: STRONG first, then by abs TVL change
    const priority = { 'STRONG': 0, 'MEDIUM': 1, 'WEAK': 2 };
    alerts.sort((a, b) => {
      if (priority[a.signal] !== priority[b.signal]) {
        return priority[a.signal] - priority[b.signal];
      }
      return Math.abs(b.tvlChange1d) - Math.abs(a.tvlChange1d);
    });

    return alerts.slice(0, 30);
  }
}
