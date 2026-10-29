/**
 * PrecompileFlashloanArbScanner — atomic arb between HL perps and HyperSwap.
 *
 * HOW IT WORKS:
 *   1. Read HL perp oracle price via HyperEVM precompile (0x...0807)
 *   2. Read HyperSwap V2/V3 price for same asset
 *   3. If spread > flashloan fee (0.04%) + AMM fee (0.01-0.3%) + HL fee:
 *      → Flashloan USDC from HyperLend
 *      → Buy on cheaper venue (HyperSwap or HL perp via CoreWriter)
 *      → Sell on more expensive venue
 *      → Repay flashloan
 *      → Keep profit
 *      → ALL ATOMIC in one HyperEVM transaction
 *
 * ADVANTAGE: ZERO capital needed — uses flashloaned funds!
 *
 * REQUIREMENTS:
 *   - HyperLend flashloan (✅ built: packages/executor/src/hyperlend-client.ts)
 *   - Precompile price reader (✅ verified)
 *   - HyperSwap V2/V3 price reader (✅ built)
 *   - CoreWriter for HL perp trades (needs to be built)
 *
 * NOTE: CoreWriter is needed to execute HL perp trades from HyperEVM.
 * This is the missing piece — we can READ prices but need to BUILD
 * the write capability to execute the arb.
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';

const RPC = 'https://rpc.hyperliquid.xyz/evm';
const HL_API = 'https://api.hyperliquid.xyz/info';
const PRECOMPILE_PERP_PRICE = '0x0000000000000000000000000000000000000807';
// EM-STRAT-012 Phase-0 (task D): fee constants used only by the removed
// fabricated-alert calculation. Kept as documentation of the assumed fee
// schedule for the future real implementation; noUnusedLocals is satisfied
// via the export below so the values remain inspectable.
export const QUARANTINED_PROTOTYPE_FEE_ASSUMPTIONS = {
  hyperlendFlashloanFee: 0.0004, // 0.04%
  hyperswapV2Fee: 0.003,         // 0.3%
  hlPerpTakerFee: 0.00035,       // 0.035%
} as const;

export interface PrecompileArbParams {
  /** Min spread % to alert (default 1% — needs to cover flashloan + AMM + HL fees) */
  minSpreadPct: number;
  /** Max flashloan amount (default $50k) */
  maxFlashloanUsd: number;
}

export interface PrecompileArbAlert {
  asset: string;
  perpIndex: number;
  hlPerpPrice: number;
  hyperswapPrice: number;
  spreadPct: number;
  direction: 'buy_hyperswap_sell_perp' | 'buy_perp_sell_hyperswap';
  estimatedProfitUsd: number;
  flashloanFeeUsd: number;
  ammFeeUsd: number;
  hlFeeUsd: number;
  netProfitUsd: number;
  executable: boolean;
  blocker?: string;
  ts: number;
}

export class PrecompileFlashloanArbScanner implements Strategy {
  readonly id = 'precompile_flashloan_arb';
  readonly landscape = 'C_dex_dex' as const;

  constructor(private params: PrecompileArbParams) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 5,
      maxSizeUsd: this.params.maxFlashloanUsd,
      maxConcurrent: 1,
      cooldownMs: 60_000,
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<PrecompileArbAlert[]> {
    // EM-STRAT-012 Phase-0 (task D): QUARANTINED — this unwired prototype
    // previously pushed a fabricated BTC divergence alert with hardcoded
    // prices that were not derived from any market data. Alert-integrity
    // hygiene: the scanner must not emit fabricated opportunities that
    // could flow into operational alerts. scan() now returns no
    // opportunities. The prototype is NOT wired in all-runner.ts and
    // remains unimplemented (CoreWriter interface required before this
    // concept can be built). Do not re-enable without real HyperSwap
    // price reads and explicit Instructor authorization.
    return [];
  }

  /** Quarantined prototype body (unreachable). Preserved for reference. */
  async quarantinedPrototypeScan(): Promise<PrecompileArbAlert[]> {
    const alerts: PrecompileArbAlert[] = [];

    // 1. Get HL perp meta
    const hlRes = await fetch(HL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    });
    const [meta, ctxs] = await hlRes.json() as any;

    // 2. For each perp, read precompile price + compare with HL mark price
    for (let i = 0; i < Math.min(50, meta.universe.length); i++) {
      const u = meta.universe[i];
      const ctx = ctxs[i];
      const hlMarkPrice = parseFloat(ctx.markPx || '0');
      if (hlMarkPrice <= 0) continue;

      // Read precompile price
      const data = '0x' + i.toString(16).padStart(64, '0');
      const r = await fetch(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: PRECOMPILE_PERP_PRICE, data }, 'latest'], id: 1 }),
      });
      const j = await r.json() as any;
      if (!j.result || j.result === '0x') continue;
      const precompileRaw = Number(BigInt(j.result));

      // The precompile returns the oracle price (slightly different from mark)
      // We compare precompile oracle vs mark price as a proxy for now
      // In production, we'd compare precompile vs HyperSwap price

      // For now, check if there's a significant oracle vs mark divergence
      // (This is NOT the real arb — real arb is precompile vs HyperSwap)
      // But it validates the concept

      // TODO: Need to map perp name to HyperSwap token pair
      // e.g., "BTC" → WHYPE/UBTC or USDC/UBTC on HyperSwap
      // For now, just log the capability

      if (i < 5) {
        console.log(`[precompile-arb] ${u.name}: precompile=${precompileRaw} mark=${hlMarkPrice}`);
      }
    }

    // 3. Check HyperSwap for token pairs that match HL perps
    // TODO: Build the HyperSwap price reader + compare
    // For now, mark as "needs CoreWriter" since we can't execute HL perp trades from HyperEVM yet

    // EM-STRAT-012 Phase-0 (task D): the fabricated alert that was pushed
    // here (hardcoded BTC hlPerpPrice / hyperswapPrice literals) has been
    // REMOVED, not just unreachable — the fake values must not exist in any
    // code path that could be re-attached to scan(). The reference prototype
    // logic above (read-only precompile-vs-mark logging) is preserved.
    return alerts;
  }
}
