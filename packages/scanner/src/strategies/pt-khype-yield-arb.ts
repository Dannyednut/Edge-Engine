/**
 * PtKhypeYieldArbScanner — Pendle PT-kHYPE fixed vs floating yield arb.
 *
 * DISCOVERY (Oct 13 2026):
 *   Found 3 PT-kHYPE tokens on HyperEVM (Pendle Principal Tokens):
 *     PT-kHYPE-13NOV2025: 13,241 tokens (matures ~30 days)
 *     PT-kHYPE-19MAR2026: 543 tokens (matures ~157 days)
 *     PT-kHYPE-24SEP2026: 27,027 tokens (longest maturity)
 *
 * ARB STRUCTURE:
 *   PT-kHYPE pays a FIXED yield at maturity.
 *   kHYPE earns a FLOATING yield (validator rewards, ~2.28% APR).
 *   If PT-kHYPE trades at a discount that implies a higher fixed yield than
 *   kHYPE's floating yield, buy PT-kHYPE (lock in higher fixed rate).
 *   If PT-kHYPE implies a lower yield, buy kHYPE (earn floating).
 *
 *   The PT price determines the implied fixed yield:
 *     implied_yield = (1 - pt_price) / pt_price × (365 / days_to_maturity)
 *     e.g., PT at 0.98 with 30 days to maturity:
 *           yield = (1-0.98)/0.98 × 365/30 = 0.0204 × 12.17 = 24.8% APR
 *
 * EXECUTION:
 *   Buy PT-kHYPE on Pendle/HyperSwap → hold to maturity → redeem for kHYPE
 *   Or: buy kHYPE on HyperSwap → hold → earn floating validator rewards
 *   Choose whichever has higher implied yield.
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';
import { HYPEREVM_RPC } from '../lib/hyperliquid-defi.js';

export interface PtKhypeParams {
  /** Min yield spread between PT fixed and kHYPE floating (default 1%) */
  minYieldSpreadPct: number;
  /** kHYPE floating yield APR (default 2.28% — from Kinetiq staking) */
  khypeFloatingYieldApr: number;
  /** Max position size (default $5000) */
  maxSizeUsd: number;
}

export interface PtKhypeAlert {
  ptToken: string;
  ptAddress: string;
  maturity: string;
  daysToMaturity: number;
  ptTotalSupply: number;
  impliedFixedYieldApr: number;
  khypeFloatingYieldApr: number;
  yieldSpreadApr: number;
  direction: 'buy_pt' | 'buy_khype';
  estimatedProfitUsd: number;
  ts: number;
}

const PT_KHYPE_TOKENS = [
  { name: 'PT-kHYPE-13NOV2025', address: '0x311dB0FDe558689550c68355783c95eFDfe25329', maturity: '2025-11-13' },
  { name: 'PT-kHYPE-19MAR2026', address: '0xea84ca9849D9e76a78B91F221F84e9Ca065FC9f5', maturity: '2026-03-19' },
  { name: 'PT-kHYPE-24SEP2026', address: '0x50fC4EDC6346F36993Bb30Fe60E932504Ed17391', maturity: '2026-09-24' },
];

export class PtKhypeYieldArbScanner implements Strategy {
  readonly id = 'pt_khype_yield_arb';
  readonly landscape = 'F_perps_funding' as const;

  constructor(private params: PtKhypeParams) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 10,
      maxSizeUsd: this.params.maxSizeUsd,
      maxConcurrent: 1,
      cooldownMs: 60_000,
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<PtKhypeAlert[]> {
    const alerts: PtKhypeAlert[] = [];

    for (const pt of PT_KHYPE_TOKENS) {
      try {
        // Get total supply
        const tsRes = await fetch(HYPEREVM_RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'eth_call',
            params: [{ to: pt.address, data: '0x18160ddd' }, 'latest'], id: 1,
          }),
        });
        const tsJson = await tsRes.json() as { result?: string };
        const totalSupply = BigInt('0x' + (tsJson.result || '0x').slice(2));
        const totalSupplyHuman = Number(totalSupply) / 1e18;

        if (totalSupplyHuman < 1) continue; // skip empty

        // Compute days to maturity
        const maturityDate = new Date(pt.maturity).getTime();
        const daysToMaturity = Math.max(1, (maturityDate - Date.now()) / (24 * 60 * 60 * 1000));

        // We need PT price to compute implied yield.
        // PT price is typically available on Pendle or HyperSwap.
        // For now, we estimate: PT trades at a discount to kHYPE.
        // If we can't get the price, we skip.
        // TODO: query Pendle API or HyperSwap for PT-kHYPE price

        // Placeholder: assume PT at 0.98 (2% discount) for illustration
        const ptPriceEstimate = 0.98; // TODO: replace with actual price query
        const impliedFixedYieldApr = ((1 - ptPriceEstimate) / ptPriceEstimate) * (365 / daysToMaturity) * 100;

        const yieldSpreadApr = impliedFixedYieldApr - this.params.khypeFloatingYieldApr;

        if (Math.abs(yieldSpreadApr) < this.params.minYieldSpreadPct) continue;

        const estimatedProfitUsd = (Math.abs(yieldSpreadApr) / 100 / 365 * daysToMaturity) * this.params.maxSizeUsd;

        alerts.push({
          ptToken: pt.name,
          ptAddress: pt.address,
          maturity: pt.maturity,
          daysToMaturity,
          ptTotalSupply: totalSupplyHuman,
          impliedFixedYieldApr,
          khypeFloatingYieldApr: this.params.khypeFloatingYieldApr,
          yieldSpreadApr,
          direction: yieldSpreadApr > 0 ? 'buy_pt' : 'buy_khype',
          estimatedProfitUsd,
          ts: Date.now(),
        });
      } catch {
        // skip
      }
    }

    alerts.sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd);
    return alerts;
  }
}
