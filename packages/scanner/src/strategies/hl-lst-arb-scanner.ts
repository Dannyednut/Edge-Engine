/**
 * HlLstArbScanner — kHYPE/WHYPE LST arbitrage on HyperSwap V3.
 *
 * THE EDGE:
 *   kHYPE (Kinetiq liquid staked HYPE) trades at a discount to WHYPE on HyperSwap V3.
 *   Verified live Oct 8 2026: 1 WHYPE = 0.9754 kHYPE → kHYPE at 2.46% discount.
 *   If kHYPE is 1:1 redeemable for HYPE (like stETH for ETH), this is a persistent arb.
 *
 *   The discount exists because:
 *   - kHYPE has withdrawal delay (unstake queue)
 *   - Liquidity is concentrated in V3 pools, not perfectly efficient
 *   - HL DeFi is new, few arb bots are monitoring it
 *
 * TRADE STRUCTURE:
 *   1. Buy kHYPE on HyperSwap V3 (0.01% fee pool) at 2.46% discount
 *   2. Hold or redeem kHYPE for HYPE (if redemption is available)
 *   3. Sell HYPE on HL orderbook at full price
 *   4. Capture the 2.46% spread minus fees (0.01% AMM fee + gas)
 *
 *   OR: atomic version via HyperLend flashloan:
 *   1. Flashloan WHYPE from HyperLend
 *   2. Swap WHYPE → kHYPE on HyperSwap V3 (buy at discount)
 *   3. Redeem kHYPE → HYPE (if instant redemption available)
 *   4. Wrap HYPE → WHYPE
 *   5. Repay flashloan
 *   6. Profit = 2.46% - 0.04% flashloan fee - 0.01% AMM fee = ~2.41%
 *
 * RISKS:
 *   - kHYPE redemption may have delay (not instant) → not atomic
 *   - kHYPE discount could widen (but that would increase the edge)
 *   - V3 pool liquidity may be insufficient for large trades
 *   - kHYPE smart contract risk (Kinetiq protocol)
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';
import { HYPERSWAP_V3_POOLS, HL_TOKEN_DECIMALS, HYPEREVM_RPC, v3PriceToHuman, HYPERLEND_FLASHLOAN_FEE } from '../lib/hyperliquid-defi.js';

export interface HlLstArbParams {
  /** Min discount % to fire alert (default 0.5%) */
  minDiscountPct: number;
  /** Max position size (default $5000) */
  maxSizeUsd: number;
  /** Pool fee tier to use (default 100 = 0.01%) */
  preferredFeeTier: number;
}

export interface HlLstArbAlert {
  pair: string;
  poolAddress: string;
  feeTier: number;
  khypePrice: number;        // kHYPE price in WHYPE (should be ~1.0 if peg holds)
  discountPct: number;       // how much kHYPE is below WHYPE
  poolLiquidity: bigint;
  estimatedProfitPct: number;  // discount - flashloan_fee - amm_fee
  estimatedProfitUsd: number;
  flashloanFeePct: number;
  ammFeePct: number;
  executable: boolean;
  ts: number;
}

export class HlLstArbScanner implements Strategy {
  readonly id = 'hl_lst_arb';
  readonly landscape = 'C_dex_dex' as const;

  constructor(private params: HlLstArbParams) {}

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

  async scan(): Promise<HlLstArbAlert[]> {
    const alerts: HlLstArbAlert[] = [];

    // Find all WHYPE/kHYPE V3 pools
    const khypePools = HYPERSWAP_V3_POOLS.filter(p => p.pair === 'WHYPE/kHYPE');

    for (const pool of khypePools) {
      try {
        // Get slot0() for sqrtPriceX96
        const slot0Res = await fetch(HYPEREVM_RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'eth_call',
            params: [{ to: pool.address, data: '0x3850c7bd' }, 'latest'], id: 1,
          }),
        });
        const slot0Json = await slot0Res.json() as { result?: string };
        const slot0Result = slot0Json.result || '0x';
        if (slot0Result.length < 66) continue;

        const sqrtPriceX96 = BigInt('0x' + slot0Result.slice(2, 66));
        const dec0 = HL_TOKEN_DECIMALS['WHYPE'] ?? 18;
        const dec1 = HL_TOKEN_DECIMALS['kHYPE'] ?? 18;
        const price = v3PriceToHuman(sqrtPriceX96, dec0, dec1);

        // price = kHYPE per WHYPE. If < 1, kHYPE is at discount
        if (price <= 0 || price > 2) continue;  // sanity check

        const discountPct = (1 - price) * 100;  // positive = kHYPE cheaper

        if (discountPct < this.params.minDiscountPct) continue;

        // Get liquidity
        const liqRes = await fetch(HYPEREVM_RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'eth_call',
            params: [{ to: pool.address, data: '0x1a686502' }, 'latest'], id: 1,
          }),
        });
        const liqJson = await liqRes.json() as { result?: string };
        const liqResult = liqJson.result || '0x';
        const liquidity = liqResult.length >= 66 ? BigInt('0x' + liqResult.slice(2, 66)) : 0n;

        if (liquidity === 0n) continue;

        // Compute profit
        const ammFeePct = (pool.fee / 10000) * 100;  // fee in bps → %
        const flashloanFeePct = HYPERLEND_FLASHLOAN_FEE * 100;  // 0.04%
        const estimatedProfitPct = discountPct - ammFeePct - flashloanFeePct;

        if (estimatedProfitPct <= 0) continue;

        const estimatedProfitUsd = (estimatedProfitPct / 100) * this.params.maxSizeUsd;

        alerts.push({
          pair: 'WHYPE/kHYPE',
          poolAddress: pool.address,
          feeTier: pool.fee,
          khypePrice: price,
          discountPct,
          poolLiquidity: liquidity,
          estimatedProfitPct,
          estimatedProfitUsd,
          flashloanFeePct,
          ammFeePct,
          executable: false,  // needs flashloan executor + kHYPE redemption check
          ts: Date.now(),
        });
      } catch {
        // skip
      }
    }

    // Sort by profit (best discount first)
    alerts.sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd);
    return alerts;
  }
}
