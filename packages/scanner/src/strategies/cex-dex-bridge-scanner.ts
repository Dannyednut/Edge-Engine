/**
 * CexDexBridgeScanner — detects CEX-DEX price spreads via bridge arbitrage.
 *
 * Compares HL perp prices vs CoinGecko aggregated CEX prices.
 * When spread > bridge cost + fees → profitable arbitrage.
 *
 * Strategy:
 *   1. Buy on cheaper venue (CEX or DEX)
 *   2. Bridge asset to other venue
 *   3. Sell on more expensive venue
 *   4. Net profit = spread - bridge cost - fees
 *
 * MIGRATED FROM scripts-explore:
 *   - cex-dex-bridge-scanner.mts
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';

const HL_API = 'https://api.hyperliquid.xyz/info';

export interface CexDexBridgeParams {
  /** Min spread % to report (default 0.05%) */
  minSpreadPct: number;
  /** Coins to compare (default: top 10) */
  coins: string[];
}

export interface CexDexBridgeAlert {
  asset: string;
  buyVenue: string;
  sellVenue: string;
  buyPrice: number;
  sellPrice: number;
  spreadPct: number;
  bridgeCostUsd: number;
  netProfitOn10k: number;
  bridgeTime: string;
  riskScore: number;
  ts: number;
}

const BRIDGE_COSTS: Record<string, { cost: number; time: string }> = {
  BTC: { cost: 5, time: '10-30min' },
  ETH: { cost: 3, time: '5-15min' },
  SOL: { cost: 0.5, time: '1-5min' },
  XRP: { cost: 0.5, time: '1-5min' },
  DOGE: { cost: 0.5, time: '1-5min' },
  AVAX: { cost: 1, time: '5-10min' },
  LINK: { cost: 2, time: '5-10min' },
  UNI: { cost: 2, time: '5-10min' },
  AAVE: { cost: 2, time: '5-10min' },
  CRV: { cost: 2, time: '5-10min' },
};

const COINGECKO_IDS: Record<string, string> = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple',
  DOGE: 'dogecoin', AVAX: 'avalanche-2', LINK: 'chainlink',
  UNI: 'uniswap', AAVE: 'aave', CRV: 'curve-dao-token',
};

export class CexDexBridgeScanner implements Strategy {
  readonly id = 'cex_dex_bridge';
  readonly landscape = 'A_dex_cex' as const;

  constructor(private params: CexDexBridgeParams) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 5,
      maxSizeUsd: 20_000,
      maxConcurrent: 5,
      cooldownMs: 10 * 60_000,
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<CexDexBridgeAlert[]> {
    const alerts: CexDexBridgeAlert[] = [];

    try {
      // Fetch HL prices
      const hlRes = await fetch(HL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      });
      const hlData = await hlRes.json() as any;

      const hlPrices: Record<string, number> = {};
      const universe = hlData?.[0]?.universe || [];
      const ctxs = hlData?.[1] || [];
      for (let i = 0; i < universe.length; i++) {
        if (!universe[i] || !ctxs[i] || universe[i].name.startsWith('@')) continue;
        hlPrices[universe[i].name] = parseFloat(ctxs[i].markPx);
      }

      // Fetch CoinGecko prices
      const ids = this.params.coins.map(c => COINGECKO_IDS[c]).filter(Boolean).join(',');
      const cgRes = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const cgData = await cgRes.json() as any;

      // Compare
      for (const coin of this.params.coins) {
        const hlPrice = hlPrices[coin];
        const cgId = COINGECKO_IDS[coin];
        const cgPrice = cgData?.[cgId]?.usd;
        if (!hlPrice || !cgPrice) continue;

        const spreadPct = ((hlPrice - cgPrice) / cgPrice) * 100;
        if (Math.abs(spreadPct) < this.params.minSpreadPct) continue;

        const bridge = BRIDGE_COSTS[coin] || { cost: 5, time: '10min' };
        const bridgeCostPct = (bridge.cost / 10000) * 100;
        const netProfitPct = Math.abs(spreadPct) - bridgeCostPct - 0.1;
        if (netProfitPct <= 0) continue;

        const buyVenue = spreadPct > 0 ? 'CEX (CoinGecko avg)' : 'Hyperliquid';
        const sellVenue = spreadPct > 0 ? 'Hyperliquid' : 'CEX (CoinGecko avg)';

        alerts.push({
          asset: coin,
          buyVenue,
          sellVenue,
          buyPrice: spreadPct > 0 ? cgPrice : hlPrice,
          sellPrice: spreadPct > 0 ? hlPrice : cgPrice,
          spreadPct,
          bridgeCostUsd: bridge.cost,
          netProfitOn10k: 10000 * netProfitPct / 100,
          bridgeTime: bridge.time,
          riskScore: 4,
          ts: Date.now(),
        });
      }

      alerts.sort((a, b) => b.netProfitOn10k - a.netProfitOn10k);

    } catch (e: any) {
      console.warn(`[cex_dex_bridge] scan failed: ${e.message}`);
    }

    return alerts;
  }
}
