/**
 * HlAmmArbScanner — arb between HyperSwap AMM prices and HL orderbook prices.
 *
 * ARCHITECTURE:
 *   1. Query HyperSwap V2 pool reserves via HyperEVM RPC
 *   2. Compute AMM price from reserves (price = reserve1/reserve0)
 *   3. Query HL spot orderbook price for same asset via HL API
 *   4. Compare AMM price vs orderbook price
 *   5. If spread > threshold + depth is sufficient, alert
 *
 * EXECUTION PATH (future):
 *   flashloan USDC from HyperLend → swap on HyperSwap → repay
 *   All atomic on HL chain, no bridge needed.
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';
import { HYPERSWAP_V2_POOLS, HL_TOKEN_DECIMALS, HYPEREVM_RPC } from '../lib/hyperliquid-defi.js';

export interface HlAmmArbParams {
  /** Min price spread % between AMM and orderbook (default 0.5%) */
  minSpreadPct: number;
  /** Min pool liquidity in USD (default $1,000) */
  minPoolLiquidityUsd: number;
  /** Max position size (default $5,000) */
  maxSizeUsd: number;
}

export interface HlAmmArbAlert {
  pair: string;              // 'WHYPE/USDC'
  poolAddress: string;
  ammPrice: number;          // price from AMM reserves
  orderbookPrice: number;    // price from HL spot orderbook
  spreadPct: number;         // (amm - orderbook) / orderbook × 100
  direction: 'buy_amm_sell_orderbook' | 'buy_orderbook_sell_amm';
  poolLiquidityUsd: number;
  estimatedProfitUsd: number;
  executable: boolean;       // false until flashloan executor is built
  ts: number;
}

export class HlAmmArbScanner implements Strategy {
  readonly id = 'hl_amm_arb';
  readonly landscape = 'C_dex_dex' as const;

  constructor(private params: HlAmmArbParams) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 5,
      maxSizeUsd: this.params.maxSizeUsd,
      maxConcurrent: 2,
      cooldownMs: 30_000,
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<HlAmmArbAlert[]> {
    const alerts: HlAmmArbAlert[] = [];

    // Get HL orderbook prices
    const hlPrices = await this.getHlOrderbookPrices();

    // For each pool, get reserves + compute AMM price
    for (const [pairName, poolAddress] of Object.entries(HYPERSWAP_V2_POOLS)) {
      try {
        const [sym0, sym1] = pairName.split('/');
        const reserves = await this.getReserves(poolAddress);
        if (!reserves || reserves.reserve0 === 0n || reserves.reserve1 === 0n) continue;

        const dec0 = HL_TOKEN_DECIMALS[sym0] ?? 18;
        const dec1 = HL_TOKEN_DECIMALS[sym1] ?? 18;

        // AMM price: how many sym1 per 1 sym0
        const r0Human = Number(reserves.reserve0) / Math.pow(10, dec0);
        const r1Human = Number(reserves.reserve1) / Math.pow(10, dec1);
        const ammPrice = r1Human > 0 && r0Human > 0 ? r1Human / r0Human : 0;

        // Pool liquidity in USD (approximate — use sym1 as quote if it's a stablecoin)
        const isStable1 = ['USDC', 'USDT0', 'USDe', 'USDHL', 'USR', 'USDH'].includes(sym1);
        const poolLiquidityUsd = isStable1 ? r1Human * 2 : r0Human * 2 * (hlPrices.get(sym0) ?? 0);

        if (poolLiquidityUsd < this.params.minPoolLiquidityUsd) continue;

        // Get orderbook price for comparison
        // We need the price of sym0 in terms of sym1
        const obPriceSym0 = hlPrices.get(sym0);  // price of sym0 in USD
        const obPriceSym1 = hlPrices.get(sym1);  // price of sym1 in USD

        if (!obPriceSym0 || !obPriceSym1) continue;
        const orderbookPrice = obPriceSym0 / obPriceSym1;  // how many sym1 per 1 sym0

        if (orderbookPrice <= 0 || ammPrice <= 0) continue;

        const spreadPct = ((ammPrice - orderbookPrice) / orderbookPrice) * 100;

        if (Math.abs(spreadPct) < this.params.minSpreadPct) continue;

        const direction = spreadPct > 0
          ? 'buy_orderbook_sell_amm'   // AMM price is higher → buy on orderbook, sell on AMM
          : 'buy_amm_sell_orderbook';  // AMM price is lower → buy on AMM, sell on orderbook

        const estimatedProfitUsd = (Math.abs(spreadPct) / 100) * Math.min(this.params.maxSizeUsd, poolLiquidityUsd * 0.1);

        alerts.push({
          pair: pairName,
          poolAddress,
          ammPrice,
          orderbookPrice,
          spreadPct,
          direction,
          poolLiquidityUsd,
          estimatedProfitUsd,
          executable: false,  // needs flashloan executor
          ts: Date.now(),
        });
      } catch (err) {
        // Skip pools that fail to query
      }
    }

    alerts.sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd);
    return alerts;
  }

  /** Query HL spot orderbook prices for all listed tokens. */
  private async getHlOrderbookPrices(): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    try {
      const res = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'spotMetaAndAssetCtxs' }),
      });
      const data = await res.json() as any[];
      const meta = data[0];
      const ctxs = data[1];
      const tokens = meta.tokens || [];
      const universe = meta.universe || [];

      for (let i = 0; i < universe.length; i++) {
        const m = universe[i];
        const ctx = ctxs[i] || {};
        const markPx = parseFloat(ctx.markPx || '0');
        const vol = parseFloat(ctx.dayNtlVlm || '0');
        if (markPx > 0 && vol > 1000) {
          let name = m.name || '';
          if (name.startsWith('@')) {
            const idx = parseInt(name.slice(1));
            if (idx < tokens.length) name = tokens[idx].name || name;
          }
          prices.set(name, markPx);
        }
      }
    } catch (err) {
      console.warn('[hl_amm_arb] failed to get HL prices:', err);
    }
    return prices;
  }

  /** Query UniswapV2 pool reserves via HyperEVM RPC. */
  private async getReserves(poolAddress: string): Promise<{ reserve0: bigint; reserve1: bigint } | null> {
    try {
      // getReserves() = 0x0902f1ac
      const res = await fetch(HYPEREVM_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_call',
          params: [{ to: poolAddress, data: '0x0902f1ac' }, 'latest'],
          id: 1,
        }),
      });
      const json = await res.json() as { result?: string };
      const result = json.result || '0x';
      if (result.length < 130) return null;

      const reserve0 = BigInt('0x' + result.slice(2, 66));
      const reserve1 = BigInt('0x' + result.slice(66, 130));
      return { reserve0, reserve1 };
    } catch {
      return null;
    }
  }
}

// ─── V3 pool support (added Oct 13 2026) ──────────────────────────────

import { HYPERSWAP_V3_POOLS, v3PriceToHuman } from '../lib/hyperliquid-defi.js';

/**
 * Scan V3 pools for AMM vs orderbook price spreads.
 * V3 pools have MUCH deeper liquidity than V2.
 */
async scanV3(): Promise<HlAmmArbAlert[]> {
  const alerts: HlAmmArbAlert[] = [];
  const hlPrices = await this.getHlOrderbookPrices();

  for (const pool of HYPERSWAP_V3_POOLS) {
    try {
      const [sym0, sym1] = pool.pair.split('/');
      const dec0 = HL_TOKEN_DECIMALS[sym0] ?? 18;
      const dec1 = HL_TOKEN_DECIMALS[sym1] ?? 18;

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
      const ammPrice = v3PriceToHuman(sqrtPriceX96, dec0, dec1);
      if (ammPrice <= 0) continue;

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

      // Compare to orderbook
      const obPriceSym0 = hlPrices.get(sym0);
      const obPriceSym1 = hlPrices.get(sym1);
      if (!obPriceSym0 || !obPriceSym1) continue;
      const orderbookPrice = obPriceSym0 / obPriceSym1;
      if (orderbookPrice <= 0) continue;

      const spreadPct = ((ammPrice - orderbookPrice) / orderbookPrice) * 100;
      if (Math.abs(spreadPct) < this.params.minSpreadPct) continue;

      // Estimate pool liquidity in USD (rough)
      const poolLiquidityUsd = obPriceSym0 * 1000;  // rough estimate
      if (poolLiquidityUsd < this.params.minPoolLiquidityUsd) continue;

      const estimatedProfitUsd = (Math.abs(spreadPct) / 100) * Math.min(this.params.maxSizeUsd, poolLiquidityUsd * 0.05);

      alerts.push({
        pair: `${pool.pair} (V3 ${pool.fee/10000}%)`,
        poolAddress: pool.address,
        ammPrice,
        orderbookPrice,
        spreadPct,
        direction: spreadPct > 0 ? 'buy_orderbook_sell_amm' : 'buy_amm_sell_orderbook',
        poolLiquidityUsd,
        estimatedProfitUsd,
        executable: false,
        ts: Date.now(),
      });
    } catch {
      // skip
    }
  }

  alerts.sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd);
  return alerts;
}
