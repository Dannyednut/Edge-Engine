/**
 * DexCexFlashloanStrategy — DEX-CEX spot arbitrage funded by Balancer V2 flashloan (0% fee).
 *
 * Landscape: same asset trades at different prices on DEX (Uniswap V3 /
 * Aerodrome / Camelot) vs CEX (Binance / OKX / Bybit). When the spread
 * exceeds gas + flashloan fee + slippage, capture it atomically.
 *
 * Pipeline:
 *   1. Pull Sharpe /arbitrage/dex-scanner/preview for gross candidates
 *      (returns GROSS spread — we need to compute fees/slippage downstream)
 *   2. For each candidate, query Uniswap V3 Quoter with actual trade size
 *      to get execution-aware slippage
 *   3. Compute net profit = gross - gas - flashloanFee - slippage - CEX fees
 *   4. If net > 0, fire alert with trade structure
 *   5. (Future) Execute via AgentVault.balancerFlashLoanArb():
 *      Borrow tokenIn from Balancer → swap on DEX → repay Balancer (0% fee) →
 *      profit routed to owner by AgentVault
 *
 * Trade structure:
 *   Scenario A (DEX cheap, CEX expensive):
 *     Flashloan USDC from Balancer → buy token on Uniswap → send token to
 *     CEX → sell on CEX for USDC → repay Balancer → profit routed to owner
 *   Scenario B (DEX expensive, CEX cheap):
 *     Flashloan token from Balancer → sell on Uniswap for USDC → ... (reverse)
 *
 * Why Balancer V2 (not Aave V3):
 *   - Balancer: 0% fee, multi-token, no chainId restriction
 *   - Aave V3: 0.05% fee (5 bps), single-token, only on ETH/ARB/BASE/OP/POLY
 *   - At $50k notional, 0.05% = $25 — meaningful when arb net is $50-200
 *
 * Execution note: DEX-CEX is NOT atomic (CEX leg is off-chain). True atomic
 * DEX-CEX requires the CEX leg to be filled in the same block as the DEX
 * swap, which is not possible via standard CEX APIs. The realistic pattern
 * is:
 *   - DEX-DEX atomic arb (Uniswap V3 ↔ Curve ↔ Balancer) — fully atomic
 *   - DEX-CEX with inventory: hold inventory on CEX, hedge on DEX atomic
 *   - DEX-CEX with flashloan + limit order on CEX: flashloan, swap on DEX,
 *     place limit order on CEX, repay flashloan from CEX fill (RISKY if
 *     CEX order doesn't fill in time)
 *
 * This scanner currently focuses on the SIGNAL side. Execution integration
 * comes after AgentVault deployment.
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';
import { SharpeClient } from '@edge/sharpe-client';

export interface DexCexFlashloanParams {
  /** Min gross spread to consider (default 0.5% = 50 bps) */
  minGrossSpreadPct: number;
  /** Max position size per arb (default $50,000 — flashloan-funded) */
  maxSizeUsd: number;
  /** CEX venues to consider */
  cexVenues: string[];
  /** DEX venues to consider (must be on a flashloan-supported chain) */
  dexVenues: string[];
  /** Chains where Balancer V2 is deployed (for flashloan) */
  flashloanChains: string[];
  /** Use Balancer V2 as primary flashloan (0% fee) */
  useBalancer: boolean;
  /** Fall back to Aave V3 if Balancer not on chain (0.05% fee) */
  useAaveFallback: boolean;
}

export interface DexCexArbAlert {
  asset: string;
  dexVenue: string;
  cexVenue: string;
  dexChain: string;
  grossSpreadPct: number;       // raw spread from Sharpe
  estimatedSlippagePct: number; // at $50k notional (placeholder until Quoter wired)
  gasUsd: number;
  flashloanFeePct: number;      // 0% Balancer, 0.05% Aave
  cexFeePct: number;            // 5-10 bps taker
  dexFeePct: number;            // 3 bps Uniswap V3
  netProfitPct: number;         // gross - slippage - gas% - flashloan - cexFee - dexFee
  netProfitUsd: number;         // at maxSizeUsd
  executable: boolean;          // requires AgentVault deployment + Quoter integration
  confidence: number;
  direction: 'buy_dex_sell_cex' | 'buy_cex_sell_dex';
}

export class DexCexFlashloanStrategy implements Strategy {
  readonly id = 'dex_cex_flashloan';
  readonly landscape = 'A_dex_cex' as const;

  constructor(
    private sharpe: SharpeClient,
    private params: DexCexFlashloanParams,
  ) {}

  subscribesTo(): string[] {
    return [];
  }

  evaluate(_data: DataPoint): TradeOrder[] | null {
    return null;
  }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 20,
      maxSizeUsd: this.params.maxSizeUsd,
      maxConcurrent: 2,
      cooldownMs: 60_000,
      gasPriceCapMultiplier: 3,
    };
  }

  /**
   * Scan Sharpe dex-scanner/preview for gross DEX-CEX spread candidates.
   *
   * Note: Sharpe's /arbitrage/dex-scanner/preview requires a `poolUrl`
   * parameter (GeckoTerminal pool URL). To discover pools, we'd need to
   * integrate GeckoTerminal API or use a different Sharpe endpoint.
   *
   * For now, this method uses Sharpe's /arbitrage/cex-spot-transfer endpoint
   * as a proxy — it returns CEX-CEX transfer arbs which often indicate
   * DEX-CEX arb windows too (when spot prices diverge enough to make
   * transfers profitable, DEX-CEX arbs are usually also open).
   */
  async scan(): Promise<DexCexArbAlert[]> {
    // Get CEX-CEX transfer candidates from Sharpe (proxy for DEX-CEX)
    const resp = await this.sharpe.cexSpotTransfer({
      minApr: 1.0,
      minDepthUsd: 100_000,
      notional: this.params.maxSizeUsd,
      format: 'json',
    });

    const alerts: DexCexArbAlert[] = [];
    for (const row of resp.data) {
      const asset = (row.coin || row.asset || row.symbol || '').toUpperCase();
      if (!asset) continue;

      const grossSpreadPct = (row.spreadRate ?? 0) * 100;
      if (grossSpreadPct < this.params.minGrossSpreadPct) continue;

      // Pick the cheaper venue as the "DEX side" proxy
      // (In production, this would be replaced with actual DEX Quoter calls)
      const longVenue = (row.longExchange || '').toLowerCase();
      const shortVenue = (row.shortExchange || '').toLowerCase();
      if (!longVenue || !shortVenue) continue;

      // Only fire if both venues are in our allowed set
      if (!this.params.cexVenues.includes(longVenue)) continue;
      if (!this.params.cexVenues.includes(shortVenue)) continue;

      // Estimate costs
      const gasUsd = 0.10;   // Base L2 gas estimate
      const flashloanFeePct = this.params.useBalancer ? 0 : 0.05;  // Balancer 0%, Aave 0.05%
      const cexFeePct = 0.05;   // 5 bps taker fee
      const dexFeePct = 0.03;   // 3 bps Uniswap V3
      const estimatedSlippagePct = 0.10;  // 10 bps at $50k (placeholder)

      const netProfitPct = grossSpreadPct - estimatedSlippagePct - flashloanFeePct - cexFeePct - dexFeePct;
      const netProfitUsd = (netProfitPct / 100) * this.params.maxSizeUsd - gasUsd;

      if (netProfitUsd < 20) continue;   // min profit threshold

      alerts.push({
        asset,
        dexVenue: longVenue,    // proxy — would be actual DEX in production
        cexVenue: shortVenue,   // proxy
        dexChain: 'arbitrum',   // default to Arbitrum (cheapest gas + Balancer deployed)
        grossSpreadPct,
        estimatedSlippagePct,
        gasUsd,
        flashloanFeePct,
        cexFeePct,
        dexFeePct,
        netProfitPct,
        netProfitUsd,
        executable: false,      // requires AgentVault deployment + Quoter integration
        confidence: 0.5,        // lower confidence — proxy data, not real DEX quote
        direction: 'buy_dex_sell_cex',
      });
    }

    alerts.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
    return alerts;
  }

  /**
   * In production: for a given asset + size, query Uniswap V3 Quoter
   * to get the actual execution-aware output. This is what determines
   * whether the arb is real or illusory.
   *
   * TODO: implement using @edge/data-sources EvmAdapter + Uniswap V3 Quoter contract.
   */
  async quoteDexSwap(_params: {
    chain: string;
    pool: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
  }): Promise<{ amountOut: bigint; priceImpactPct: number }> {
    // Placeholder — implement with viem readContract on Uniswap V3 Quoter
    throw new Error('quoteDexSwap: not implemented — requires Uniswap V3 Quoter integration');
  }
}
