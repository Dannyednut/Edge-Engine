/**
 * EquityPerpCrossVenueScanner — compare tokenized equity perp prices
 * across trade.xyz (via HL HIP-3) and Backpack Exchange.
 *
 * EM-STRAT-014-E11 item 6:
 *   - HL query scoped by `dex` (HIP-3 deployer address) over a documented
 *     deployer census, instead of the unscoped `metaAndAssetCtxs` that
 *     returns ALL HL perps and relies on substring matching.
 *   - Exact symbol matching replaces substring `name.includes(equity)` —
 *     a substring match could falsely match `AAPLx` or `MyAAPL`.
 *   - Mark-vs-last price basis labeled explicitly: HL uses `ctx.markPx`
 *     (mark price); Backpack uses `ticker.lastPrice` (last traded price).
 *     The spread is mark-vs-last, not mark-vs-mark — this basis mismatch
 *     must be visible to the consumer.
 *
 * DISCOVERY (Task 31 research):
 *   trade.xyz lists equity perps on Hyperliquid (AAPL, MSFT, NVDA, TSLA).
 *   Backpack lists equity perps (AAPL, MSFT, NVDA, TSLA, SPCX, SNDK, AMD, HOOD, INTC).
 *   Same underlying assets, two venues = potential price spread arb.
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';
import { BackpackClient } from '@edge/backpack-client';

export interface EquityPerpArbParams {
  /** Min spread % to fire alert (default 0.5%) */
  minSpreadPct: number;
  /** Max position size (default $2000 — equity perps are illiquid) */
  maxSizeUsd: number;
  /**
   * EM-STRAT-014-E11 item 6: HIP-3 deployer addresses to scope the HL
   * `metaAndAssetCtxs` query. When non-empty, the query includes
   * `dex: <address>` for each deployer. When empty, the query is unscoped
   * (legacy behavior — NOT recommended; relies on exact-match filtering).
   *
   * The documented trade.xyz deployer census should be injected here.
   * The address is not hardcoded in this file because it must be verified
   * against the on-chain HIP-3 deployer registry before production use.
   */
  dexScopes?: string[];
}

export interface EquityPerpArbAlert {
  asset: string;
  backpackPrice: number;
  /** EM-STRAT-014-E11 item 6: price basis label. */
  backpackPriceBasis: 'last';
  hlPrice: number;
  /** EM-STRAT-014-E11 item 6: price basis label. */
  hlPriceBasis: 'mark';
  /**
   * EM-STRAT-014-E11 item 6: explicit basis-mismatch warning. The spread
   * compares HL mark price vs Backpack last traded price — these are NOT
   * the same price type. The consumer must not treat this as a mark-vs-mark
   * or last-vs-last spread.
   */
  priceBasisMismatch: true;
  spreadPct: number;
  direction: 'buy_backpack_sell_hl' | 'buy_hl_sell_backpack';
  estimatedProfitUsd: number;
  ts: number;
}

const HL_API = 'https://api.hyperliquid.xyz/info';
const EQUITY_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD', 'HOOD', 'INTC'];

/** Injectable dependencies for deterministic offline testing. */
export interface EquityPerpDeps {
  fetchImpl?: typeof fetch;
  backpackClient?: BackpackClient;
}

export class EquityPerpCrossVenueScanner implements Strategy {
  readonly id = 'equity_perp_cross_venue';
  readonly landscape = 'B_cex_cex' as const;

  constructor(private params: EquityPerpArbParams, private deps: EquityPerpDeps = {}) {}

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
    const backpack = this.deps.backpackClient ?? new BackpackClient();
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
        backpackPriceBasis: 'last',
        hlPrice,
        hlPriceBasis: 'mark',
        priceBasisMismatch: true,
        spreadPct,
        direction: spreadPct > 0 ? 'buy_hl_sell_backpack' : 'buy_backpack_sell_hl',
        estimatedProfitUsd,
        ts: Date.now(),
      });
    }

    alerts.sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd);
    return alerts;
  }

  /**
   * Get HL perp prices for equity assets (AAPL, MSFT, etc.)
   *
   * EM-STRAT-014-E11 item 6:
   *   - Query scoped by `dex` (HIP-3 deployer) when `params.dexScopes` is
   *     non-empty. One query per deployer address; results merged.
   *   - Exact symbol match (===) replaces substring `includes()`.
   *   - `res.ok` checked.
   *   - Price labeled as mark price (`ctx.markPx`).
   */
  private async getHlEquityPrices(): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    const fetchFn = this.deps.fetchImpl ?? fetch;
    const dexScopes = this.params.dexScopes ?? [];

    // Build the list of query bodies. When dexScopes is non-empty, issue
    // one scoped query per deployer. When empty, issue one unscoped query
    // (legacy behavior — relies on exact-match filtering to avoid false
    // positives among non-equity perps).
    const queryBodies: any[] = dexScopes.length > 0
      ? dexScopes.map(dex => ({ type: 'metaAndAssetCtxs', dex }))
      : [{ type: 'metaAndAssetCtxs' }];

    for (const body of queryBodies) {
      try {
        const res = await fetchFn(HL_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          console.warn(`[equity_perp] HL API non-ok: ${res.status}`);
          continue;
        }
        const data = await res.json() as any[];
        const universe = data[0]?.universe || [];
        const ctxs = data[1] || [];

        for (let i = 0; i < universe.length; i++) {
          const name = (universe[i]?.name || '').toUpperCase();
          const ctx = ctxs[i] || {};
          const markPx = parseFloat(ctx.markPx || '0');
          if (!isFinite(markPx) || markPx <= 0) continue;

          // EM-STRAT-014-E11 item 6: EXACT symbol match (was: name.includes(equity)).
          // A substring match could falsely match 'AAPLx' or 'MyAAPL'.
          if (EQUITY_SYMBOLS.includes(name)) {
            prices.set(name, markPx);
          }
        }
      } catch (err) {
        console.warn('[equity_perp] failed to get HL prices:', err);
      }
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
        if (isFinite(price) && price > 0) prices.set(asset, price);
      } catch {
        // Asset not listed on Backpack
      }
    }
    return prices;
  }
}
