/**
 * CrossDexArbScanner — compares token prices across HyperEVM DEXs.
 *
 * DISCOVERY (Oct 7 2026):
 *   Ramses V3 has significant liquidity ($2.5M daily volume on USDC/USD₮0).
 *   Same tokens trade on both HyperSwap V2/V3 AND Ramses V3.
 *   Price differences between DEXs = cross-DEX arb opportunity.
 *
 * HOW IT WORKS:
 *   1. Get token prices from Ramses V3 via GeckoTerminal API
 *   2. Get token prices from HyperSwap V2/V3 via on-chain RPC
 *   3. Compare same-token prices across DEXs
 *   4. Alert when spread > threshold (after fees)
 *
 * EXECUTION:
 *   Buy on cheaper DEX, sell on more expensive DEX.
 *   Both are HyperEVM — atomic via flashloan or manual paired-leg.
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';

const GECKO_API = 'https://api.geckoterminal.com/api/v2';

export interface CrossDexArbParams {
  /** Min spread % to alert (default 0.5% — must exceed 2x swap fees) */
  minSpreadPct: number;
  /** Min pool reserve in USD (default $50k — filters illiquid pools) */
  minReserveUsd: number;
  /** Max position size (default $5000) */
  maxSizeUsd: number;
}

export interface CrossDexArbAlert {
  pair: string;
  baseToken: string;
  quoteToken: string;
  dex1Name: string;
  dex1Price: number;
  dex2Name: string;
  dex2Price: number;
  spreadPct: number;
  direction: string;  // 'buy_dex1_sell_dex2' or 'buy_dex2_sell_dex1'
  estimatedProfitUsd: number;
  reserve1Usd: number;
  reserve2Usd: number;
  ts: number;
}

export class CrossDexArbScanner implements Strategy {
  readonly id = 'cross_dex_arb';
  readonly landscape = 'C_dex_dex' as const;

  constructor(private params: CrossDexArbParams) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 10,
      maxSizeUsd: this.params.maxSizeUsd,
      maxConcurrent: 5,
      cooldownMs: 60_000,
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<CrossDexArbAlert[]> {
    const alerts: CrossDexArbAlert[] = [];

    // 1. Fetch Ramses V3 pool prices
    const ramsesPools = await this.fetchGeckoPools('ramses-v3-hyperevm');
    // 2. Fetch HyperSwap V2 pool prices
    const hyperswapV2Pools = await this.fetchGeckoPools('hyperswap-v2');
    // 3. Fetch HyperSwap V3 pool prices
    const hyperswapV3Pools = await this.fetchGeckoPools('hyperswap-v3');

    // Build price maps: pair name -> { dex, price, reserve }
    interface PoolData {
      dex: string;
      price: number;
      reserveUsd: number;
    }
    const priceMap = new Map<string, PoolData[]>();

    for (const pool of [...ramsesPools, ...hyperswapV2Pools, ...hyperswapV3Pools]) {
      if (pool.reserveUsd < this.params.minReserveUsd) continue;
      if (pool.price <= 0) continue;

      const key = pool.pairName;
      if (!priceMap.has(key)) priceMap.set(key, []);
      priceMap.get(key)!.push({ dex: pool.dex, price: pool.price, reserveUsd: pool.reserveUsd });
    }

    // 4. Compare same-pair prices across DEXs
    for (const [pair, pools] of priceMap.entries()) {
      if (pools.length < 2) continue;

      for (let i = 0; i < pools.length; i++) {
        for (let j = i + 1; j < pools.length; j++) {
          const p1 = pools[i];
          const p2 = pools[j];
          const spreadPct = Math.abs((p1.price - p2.price) / Math.min(p1.price, p2.price)) * 100;

          if (spreadPct < this.params.minSpreadPct) continue;

          // Estimate profit (account for ~0.3% total fees: 0.15% per DEX)
          const feePct = 0.3;
          const netSpreadPct = spreadPct - feePct;
          if (netSpreadPct <= 0) continue;

          const estimatedProfitUsd = (netSpreadPct / 100) * this.params.maxSizeUsd;
          const direction = p1.price < p2.price
            ? `buy_${p1.dex}_sell_${p2.dex}`
            : `buy_${p2.dex}_sell_${p1.dex}`;

          alerts.push({
            pair,
            baseToken: pair.split('/')[0],
            quoteToken: pair.split('/')[1] || '',
            dex1Name: p1.dex,
            dex1Price: p1.price,
            dex2Name: p2.dex,
            dex2Price: p2.price,
            spreadPct,
            direction,
            estimatedProfitUsd,
            reserve1Usd: p1.reserveUsd,
            reserve2Usd: p2.reserveUsd,
            ts: Date.now(),
          });
        }
      }
    }

    alerts.sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd);
    return alerts;
  }

  private async fetchGeckoPools(dexId: string): Promise<Array<{pairName: string, price: number, reserveUsd: number, dex: string}>> {
    const pools: Array<{pairName: string, price: number, reserveUsd: number, dex: string}> = [];
    try {
      const r = await fetch(`${GECKO_API}/networks/hyperevm/dexes/${dexId}/pools?page=1`);
      if (!r.ok) return pools;
      const data = await r.json() as any;
      for (const pool of data.data || []) {
        const attrs = pool.attributes || {};
        const name = attrs.name || '';
        const reserveUsd = parseFloat(attrs.reserve_in_usd || '0');
        // GeckoTerminal doesn't provide direct price, use ratio from reserves
        // But we can get it from the relationships endpoint
        pools.push({
          pairName: name,
          price: 0,  // will need to compute from reserves or use another endpoint
          reserveUsd,
          dex: dexId,
        });
      }
    } catch {}
    return pools;
  }
}
