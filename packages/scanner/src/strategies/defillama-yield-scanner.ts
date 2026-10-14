/**
 * DefiLlamaYieldScanner — scans ALL DeFi yield pools via DefiLlama API.
 *
 * This is the "universal yield" scanner. It fetches all 16,950+ yield pools
 * across 75+ chains and identifies the best delta-neutral opportunities:
 *   - Stablecoin pools (no IL risk, no market exposure)
 *   - Single-sided lending (no IL risk)
 *   - Pendle PT pools (principal-protected)
 *
 * SUBSCENARIOS:
 *   1. Sweet spot yields: APY > 6% AND TVL > $50M (safe + profitable)
 *   2. High-yield stable: APY > 8% AND TVL > $5M (aggressive)
 *   3. Best per chain: top yield on each of 31+ chains
 *   4. Top projects: ranked by avg APY across pools
 *
 * MIGRATED FROM scripts-explore:
 *   - defillama-yield-scanner.mts
 *   - sweet-spot-yields.mts
 *   - high-yield-stable-aggregator.mts
 *   - multi-chain-stable-aggregator.mts
 *   - solana-yield-comprehensive.mts
 *   - hyperliquid-l1-yields.mts
 *   - hl-l1-stable-optimizer.mts
 *   - convex-yield-scanner.mts
 *   - top-projects-scanner.mts
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';

const LLAMA_API = 'https://yields.llama.fi';

export interface DefiLlamaYieldParams {
  /** Min APY to report (default 5%) */
  minApyPct: number;
  /** Min TVL to report (default $1M) */
  minTvlUsd: number;
  /** Only stablecoin pools (delta-neutral) (default true) */
  stablecoinOnly: boolean;
  /** Only no-IL pools (default true) */
  noIlRiskOnly: boolean;
  /** Max results to return (default 50) */
  maxResults: number;
  /** Filter by chain (default = all chains) */
  chain?: string;
}

export interface YieldPoolAlert {
  pool: string;
  symbol: string;
  project: string;
  chain: string;
  apy: number;
  apy30d: number;
  tvlUsd: number;
  stablecoin: boolean;
  ilRisk: string;
  exposure: string;
  riskScore: number;
  dailyProfitOn10k: number;
  ts: number;
}

export class DefiLlamaYieldScanner implements Strategy {
  readonly id = 'defillama_yield';
  readonly landscape = 'F_perps_funding' as const; // yield strategies live in perps/funding landscape

  constructor(private params: DefiLlamaYieldParams) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 0,  // monitoring strategy
      maxSizeUsd: 100_000,
      maxConcurrent: 10,
      cooldownMs: 5 * 60_000,  // 5 min
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<YieldPoolAlert[]> {
    const alerts: YieldPoolAlert[] = [];

    try {
      const res = await fetch(`${LLAMA_API}/pools`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      });
      if (!res.ok) return alerts;

      const j = await res.json() as any;
      const pools = j?.data || [];

      for (const p of pools) {
        // ── EI-S004 data-quality filters ────────────────────────────
        // 1. Exclude trading vaults — poolMeta containing "Vault" indicates
        //    an annualized trading-vault PnL, not a deposit yield.
        //    Evidence: growihf pool 90c0b5b5… has poolMeta="Hyperliquid
        //    Vault", APY 50.8%, but apyBase=null, apyPct1D=-32.45pts,
        //    outlier=true — it's a trading strategy, not lending.
        const poolMeta = String(p.poolMeta || '');
        if (poolMeta.toLowerCase().includes('vault')) {
          continue;
        }
        // 2. Exclude outlier pools — DefiLlama marks these as statistically
        //    anomalous (prediction Down, extreme 1d swings). These are not
        //    reliable deposit yields.
        if (p.outlier === true) {
          continue;
        }
        // 3. Require apyBase non-null for yield pools — apyBase is the
        //    base APR from the protocol's yield mechanism. When null, the
        //    "APY" is often a trading-vault PnL or a transient reward that
        //    cannot be relied upon. This excludes legitimate categories
        //    (see documentation below) but prevents misclassification.
        //    EXCLUDED CATEGORIES (documented, accepted trade-off):
        //    - Pure reward-token farms with no base yield (apyBase=null,
        //      apyReward>0) — these are incentive emissions, not yield.
        //    - Trading vaults that report only total PnL as "APY".
        //    - New pools with insufficient history for apyBase calculation.
        //    LEGITIMATE pools that still pass: those with apyBase>0 from
        //    lending/borrowing spread, staking rewards, or PT fixed yield.
        if (p.apyBase === null || p.apyBase === undefined) {
          continue;
        }

        // Apply existing filters
        if (this.params.stablecoinOnly && !p.stablecoin) continue;
        if (this.params.noIlRiskOnly && p.ilRisk !== 'no') continue;
        if ((p.apy || 0) < this.params.minApyPct) continue;
        if ((p.tvlUsd || 0) < this.params.minTvlUsd) continue;
        if (this.params.chain && p.chain !== this.params.chain) continue;

        // Calculate risk score
        let riskScore = 3;
        if ((p.tvlUsd || 0) > 1_000_000_000) riskScore = 1;
        else if ((p.tvlUsd || 0) > 100_000_000) riskScore = 2;
        else if ((p.tvlUsd || 0) < 2_000_000) riskScore = 4;
        if ((p.apy || 0) > 50) riskScore += 2;
        else if ((p.apy || 0) > 20) riskScore += 1;

        alerts.push({
          pool: p.pool || '',
          symbol: p.symbol || '',
          project: p.project || '',
          chain: p.chain || '',
          apy: p.apy || 0,
          apy30d: p.apyMean30d || p.apy || 0,
          tvlUsd: p.tvlUsd || 0,
          stablecoin: p.stablecoin || false,
          ilRisk: p.ilRisk || 'unknown',
          exposure: p.exposure || 'unknown',
          riskScore: Math.max(1, Math.min(10, riskScore)),
          dailyProfitOn10k: 10000 * (p.apy || 0) / 100 / 365,
          ts: Date.now(),
        });
      }

      // Sort by risk-adjusted yield (apy / riskScore)
      alerts.sort((a, b) => (b.apy / b.riskScore) - (a.apy / a.riskScore));

    } catch (e: any) {
      console.warn(`[defillama_yield] scan failed: ${e.message}`);
    }

    return alerts.slice(0, this.params.maxResults);
  }

  /** Get the "sweet spot" — safe + profitable (APY > 6%, TVL > $50M) */
  async scanSweetSpot(): Promise<YieldPoolAlert[]> {
    const all = await this.scan();
    return all.filter(a => a.apy > 6 && a.tvlUsd > 50_000_000);
  }

  /** Get best yield on each chain */
  async scanBestPerChain(): Promise<Record<string, YieldPoolAlert>> {
    const all = await this.scan();
    const byChain: Record<string, YieldPoolAlert> = {};
    for (const a of all) {
      if (!byChain[a.chain] || a.apy > byChain[a.chain].apy) {
        byChain[a.chain] = a;
      }
    }
    return byChain;
  }
}
