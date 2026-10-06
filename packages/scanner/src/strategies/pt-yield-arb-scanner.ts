/**
 * PtYieldArbScanner — Pendle PT (Principal Token) yield arb across all HL LSTs.
 *
 * DISCOVERY (Oct 13 2026 — HYPE LST Atlas):
 *   17 HYPE LSTs on HyperEVM with Pendle markets. Each has:
 *     - underlyingApy: floating yield (e.g., kHYPE = 2.37%)
 *     - impliedApy: PT fixed yield (e.g., stHYPE PT = 17.96%)
 *
 * ARB STRUCTURE:
 *   When PT implied yield > underlying floating yield, buy the PT (lock fixed rate).
 *   When PT implied yield < underlying floating yield, sell the PT (earn floating).
 *
 * TOP OPPORTUNITIES (Oct 13 2026):
 *   stHYPE PT: 17.96% implied vs 2.56% floating = 15.40% spread ($12.9M TVL)
 *   AVLT PT:   33.51% implied vs 17.51% floating = 16.00% spread ($4.9M TVL)
 *   hwHYPE PT: 29.94% implied vs 8.45% floating = 21.49% spread ($2.4M TVL)
 *   haHYPE PT: 43.52% implied vs 4.79% floating = 38.73% spread ($4.0M TVL — illiquid)
 *
 * EXECUTION:
 *   1. Swap kHYPE → target PT on Pendle AMM (locks fixed yield until maturity)
 *   2. Hold PT to maturity
 *   3. Redeem PT for underlying LST at 1:1
 *   4. Swap LST → kHYPE if needed
 *
 * RISK:
 *   - PT implied yield may be stale (low volume = unreliable)
 *   - Need to verify volume + depth before claiming arb
 *   - Capital lock until maturity (e.g., stHYPE PT matures Feb 2026)
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';
import { PendleClient } from '../lib/pendle-client.js';

export interface PtYieldArbParams {
  /** Min yield spread to alert (default 3%) */
  minYieldSpreadPct: number;
  /** Min TVL for a market to be considered (default $500K — filters illiquid) */
  minTvlUsd: number;
  /** Max PT implied APY (filters suspicious >50% yields) */
  maxImpliedApyPct: number;
  /** kHYPE floating yield — used as baseline funding cost */
  khypeFloatingYieldApr: number;
}

export interface PtYieldArbAlert {
  lst: string;
  ptAddress: string;
  marketAddress: string;
  expiry: string;
  daysToMaturity: number;
  tvlUsd: number;
  underlyingApyPct: number;       // floating yield
  impliedApyPct: number;          // PT fixed yield
  yieldSpreadPct: number;         // implied - underlying
  vsKhypeSpreadPct: number;       // implied - kHYPE floating (funding cost)
  estimatedProfitUsd: number;     // on $5k capital held to maturity
  daysLocked: number;
  annualizedReturnPct: number;    // spread * (365 / daysToMaturity)
  ts: number;
}

export class PtYieldArbScanner implements Strategy {
  readonly id = 'pt_yield_arb';
  readonly landscape = 'F_perps_funding' as const;

  private pendle: PendleClient;

  constructor(private params: PtYieldArbParams) {
    this.pendle = new PendleClient();
  }

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 50,
      maxSizeUsd: 5_000,
      maxConcurrent: 3,
      cooldownMs: 60 * 60_000,  // 1 hour
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<PtYieldArbAlert[]> {
    const alerts: PtYieldArbAlert[] = [];

    const markets = await this.pendle.getHlLstMarkets();

    for (const m of markets) {
      const tvl = m.details.totalTvl;
      if (tvl < this.params.minTvlUsd) continue;

      const underlying = m.details.underlyingApy * 100;
      // Filter out suspicious: -1 (stale) and >100%
      if (m.details.impliedApy <= 0 || m.details.impliedApy > this.params.maxImpliedApyPct / 100) continue;
      const implied = m.details.impliedApy * 100;

      const yieldSpread = implied - underlying;
      const vsKhypeSpread = implied - this.params.khypeFloatingYieldApr;

      // Only alert if PT is meaningfully better than both underlying AND kHYPE funding
      if (yieldSpread < this.params.minYieldSpreadPct) continue;
      if (vsKhypeSpread < this.params.minYieldSpreadPct) continue;

      // Compute days to maturity
      const maturityDate = m.expiry ? new Date(m.expiry).getTime() : Date.now() + 90 * 86400000;
      const daysToMaturity = (maturityDate - Date.now()) / (24 * 60 * 60 * 1000);
      // Skip expired markets (daysToMaturity <= 0)
      if (daysToMaturity <= 0) continue;
      // Skip very-short-maturity markets (<7 days — spread capture too small)
      if (daysToMaturity < 7) continue;

      // Profit calculation: hold $5k for `daysToMaturity` days at `vsKhypeSpread` APR
      const annualizedReturnPct = vsKhypeSpread * (365 / daysToMaturity);
      const estimatedProfitUsd = (vsKhypeSpread / 100 / 365 * daysToMaturity) * 5_000;

      alerts.push({
        lst: m.name,
        ptAddress: m.pt.split('-')[1] || '',
        marketAddress: m.address,
        expiry: m.expiry?.slice(0, 10) || 'unknown',
        daysToMaturity,
        tvlUsd: tvl,
        underlyingApyPct: underlying,
        impliedApyPct: implied,
        yieldSpreadPct: yieldSpread,
        vsKhypeSpreadPct: vsKhypeSpread,
        estimatedProfitUsd,
        daysLocked: daysToMaturity,
        annualizedReturnPct,
        ts: Date.now(),
      });
    }

    // Sort by annualized return
    alerts.sort((a, b) => b.annualizedReturnPct - a.annualizedReturnPct);
    return alerts;
  }
}
