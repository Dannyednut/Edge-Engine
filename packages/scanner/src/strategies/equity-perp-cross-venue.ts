/**
 * EquityPerpCrossVenueScanner — compare tokenized equity perp prices
 * across trade.xyz (via HL HIP-3) and Backpack Exchange.
 *
 * DISCOVERY (Task 31 research):
 *   trade.xyz lists equity perps on Hyperliquid (AAPL, MSFT, NVDA, TSLA).
 *   Backpack lists equity perps (AAPL, MSFT, NVDA, TSLA, SPCX, SNDK, AMD, HOOD, INTC).
 *   Same underlying assets, two venues = potential price spread arb.
 *
 * HOW IT WORKS:
 *   1. Get Backpack equity perp prices via Backpack API
 *   2. Get trade.xyz/HL equity perp prices via HL Info API
 *   3. Compare same-asset prices across venues
 *   4. If spread > threshold, alert
 *
 * EXECUTION:
 *   Backpack perp on one side, HL perp on the other.
 *   Not atomic (different chains) but both are API-based with fast settlement.
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';
import { BackpackClient } from '@edge/backpack-client';

export interface EquityPerpArbParams {
  /** Min spread % to fire alert (default 0.5%) */
  minSpreadPct: number;
  /** Max position size (default $2000 — equity perps are illiquid) */
  maxSizeUsd: number;
}

export interface EquityPerpArbAlert {
  asset: string;
  backpackPrice: number;
  hlPrice: number;
  spreadPct: number;
  direction: 'buy_backpack_sell_hl' | 'buy_hl_sell_backpack';
  estimatedProfitUsd: number;
  ts: number;
}

const HL_API = 'https://api.hyperliquid.xyz/info';
const EQUITY_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD', 'HOOD', 'INTC'];

export class EquityPerpCrossVenueScanner implements Strategy {
  readonly id = 'equity_perp_cross_venue';
  readonly landscape = 'B_cex_cex' as const;

  constructor(private params: EquityPerpArbParams) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 5,
      maxSizeUsd: this.params.maxSizeUsd,
      maxConcurrent: 2,
      cooldownMs: 60_000,
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<EquityPerpArbAlert[]> {
    const alerts: EquityPerpArbAlert[] = [];

    // Get HL perp prices for equity assets
    const hlPrices = await this.getHlEquityPrices();

    // Get Backpack perp prices for equity assets
    const backpack = new BackpackClient();
    const bpPrices = await this.getBackpackEquityPrices(backpack);

    // Compare
    for (const asset of EQUITY_SYMBOLS) {
      const hlPrice = hlPrices.get(asset);
      const bpPrice = bpPrices.get(asset);

      if (!hlPrice || !bpPrice || hlPrice <= 0 || bpPrice <= 0) continue;

      const spreadPct = ((bpPrice - hlPrice) / hlPrice) * 100;

      if (Math.abs(spreadPct) < this.params.minSpreadPct) continue;

      const feePct = 0.10;  // ~10 bps round-trip (5 bps per venue)
      const netProfitPct = Math.abs(spreadPct) - feePct;
      if (netProfitPct <= 0) continue;

      const estimatedProfitUsd = (netProfitPct / 100) * this.params.maxSizeUsd;

      alerts.push({
        asset,
        backpackPrice: bpPrice,
        hlPrice,
        spreadPct,
        direction: spreadPct > 0 ? 'buy_hl_sell_backpack' : 'buy_backpack_sell_hl',
        estimatedProfitUsd,
        ts: Date.now(),
      });
    }

    alerts.sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd);
    return alerts;
  }

  /** Get HL perp prices for equity assets (AAPL, MSFT, etc.) */
  private async getHlEquityPrices(): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    try {
      const res = await fetch(HL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      });
      const data = await res.json() as any[];
      const universe = data[0].universe || [];
      const ctxs = data[1] || [];

      for (let i = 0; i < universe.length; i++) {
        const name = universe[i].name || '';
        const ctx = ctxs[i] || {};
        const markPx = parseFloat(ctx.markPx || '0');
        if (markPx <= 0) continue;

        // Check if this perp is an equity (AAPL, MSFT, etc.)
        for (const equity of EQUITY_SYMBOLS) {
          if (name.toUpperCase().includes(equity)) {
            prices.set(equity, markPx);
            break;
          }
        }
      }
    } catch (err) {
      console.warn('[equity_perp] failed to get HL prices:', err);
    }
    return prices;
  }

  /** Get Backpack perp prices for equity assets */
  private async getBackpackEquityPrices(client: BackpackClient): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    for (const asset of EQUITY_SYMBOLS) {
      try {
        const ticker = await client.getTicker(`${asset}.US_USDC_PERP`);
        const price = parseFloat(ticker.lastPrice || '0');
        if (price > 0) prices.set(asset, price);
      } catch {
        // Asset not listed on Backpack
      }
    }
    return prices;
  }
}
