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
 * EM-STRAT-014-E11-Cluster3-R1 — FAIL CLOSED on unverified scope roster:
 *   - The unscoped fallback is REMOVED. When no HIP-3 deployer scope is
 *     configured, the scanner issues NO HL query at all and reports an
 *     explicit degradation reason. An empty scope list can never silently
 *     execute the unscoped discovery this strategy was meant to correct.
 *   - Roster policy: the repository's `docs/hip3-alias-markets.md` census
 *     documents the VOOI-scanner alias discovery (298 alias: assets) but
 *     contains NO deployer addresses and no deployer→symbol mapping. No
 *     verified, source-backed deployer roster exists in this repository,
 *     and inventing or hardcoding an unverified address is prohibited.
 *     Independent on-chain roster verification belongs to EI and requires
 *     separate Principal authorization for chain reads. Until a verified
 *     roster is configured, this strategy produces NO candidates.
 *   - Any alerts that DO become possible (verified roster configured) are
 *     monitoring-only: the presenter must keep them 'info' with the
 *     basis-mismatch label until a separate economic-validity review
 *     approves stronger alert semantics (the mark-vs-last spread is not a
 *     proven net-profit signal).
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
   * EM-STRAT-014-E11 item 6 / Cluster3-R1: HIP-3 deployer addresses to
   * scope the HL `metaAndAssetCtxs` query. One scoped query per deployer.
   *
   * FAIL-CLOSED (Cluster3-R1): when absent/empty, NO HL query is issued and
   * the scan degrades visibly with reason 'hip3_scope_roster_unverified'.
   * The legacy unscoped fallback was REMOVED — an empty scope list can
   * never silently execute unscoped discovery.
   *
   * Roster policy: no verified, source-backed deployer roster exists in
   * this repository (docs/hip3-alias-markets.md documents asset discovery
   * but contains no deployer addresses). Addresses must come exclusively
   * from EI's independently verified on-chain census — never invented.
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

/**
 * EM-STRAT-014-E11-Cluster3-R1: degradation markers for the equity-perp
 * scan. Surfaced via scanWithDegradation() so the production runner can
 * log WHY no candidates were produced (verified-roster missing vs scoped
 * query failures) — an empty result must never be confusable with
 * "no opportunities".
 */
export interface EquityPerpDegradation {
  /**
   * Machine-readable reason HL candidate prices are missing/partial.
   * null when the scoped HL query path completed without issue.
   *   - 'hip3_scope_roster_unverified': no dexScopes configured (fail-closed;
   *     no HL query issued at all).
   *   - 'hip3_scope_invalid_format': one or more configured scopes are not
   *     plausible 0x addresses (fail-closed; those scopes are NOT sent).
   *   - 'hip3_scoped_queries_failed': all configured scoped queries failed
   *     (non-ok / network error).
   *   - 'hip3_scoped_queries_partial': some scoped queries failed.
   */
  reason: string | null;
  /** Count of configured scopes that were rejected or whose query failed. */
  failedScopes: number;
  /** Count of scoped queries actually issued (0 when fail-closed). */
  issuedQueries: number;
}

export interface EquityPerpScanResult {
  alerts: EquityPerpArbAlert[];
  degradation: EquityPerpDegradation;
}

/**
 * EM-STRAT-014-E11-Cluster3-R1: production-visible degradation summary
 * (pure, exported for offline deterministic testing of exactly what the
 * runner logs).
 */
export function formatEquityPerpDegradation(d: EquityPerpDegradation): string {
  const parts = `reason=${d.reason ?? 'none'} failedScopes=${d.failedScopes} issuedQueries=${d.issuedQueries}`;
  if (d.reason !== null) {
    return `[equity_perp] DEGRADED ${d.reason} | ${parts}`;
  }
  return `[equity_perp] ok | ${parts}`;
}

/** Plausible EVM address shape for a HIP-3 deployer scope. */
const SCOPE_FORMAT_RE = /^0x[0-9a-fA-F]{40}$/;

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
    return (await this.scanWithDegradation()).alerts;
  }

  /**
   * EM-STRAT-014-E11-Cluster3-R1: scan with explicit degradation. The
   * production runner MUST use this variant and log the marker on every
   * scan — especially when the result is empty because the HIP-3 scope
   * roster is unverified (fail-closed), so that "no candidates because the
   * market universe is unverified" is visible and not confusable with
   * "no spread right now".
   */
  async scanWithDegradation(): Promise<EquityPerpScanResult> {
    const alerts: EquityPerpArbAlert[] = [];

    // Get HL perp prices for equity assets (fail-closed, scoped only)
    const hl = await this.getHlEquityPrices();

    // Get Backpack perp prices for equity assets
    const backpack = this.deps.backpackClient ?? new BackpackClient();
    const bpPrices = await this.getBackpackEquityPrices(backpack);

    // Compare
    for (const asset of EQUITY_SYMBOLS) {
      const hlPrice = hl.prices.get(asset);
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
    return { alerts, degradation: hl.degradation };
  }

  /**
   * Get HL perp prices for equity assets (AAPL, MSFT, etc.)
   *
   * EM-STRAT-014-E11 item 6 + Cluster3-R1:
   *   - FAIL-CLOSED: no configured scopes → NO query issued, empty prices,
   *     degradation reason 'hip3_scope_roster_unverified'. The legacy
   *     unscoped `metaAndAssetCtxs` fallback is REMOVED — an empty scope
   *     list can never silently execute unscoped discovery.
   *   - Format-invalid scopes are rejected fail-closed (not sent, counted).
   *   - One scoped query per deployer (`dex: <address>`); results merged.
   *   - Exact symbol match (===) — 'AAPLx'/'MyAAPL' never match 'AAPL'.
   *   - `res.ok` checked; failures counted in degradation.
   *   - Price labeled as mark price (`ctx.markPx`).
   */
  private async getHlEquityPrices(): Promise<{ prices: Map<string, number>; degradation: EquityPerpDegradation }> {
    const prices = new Map<string, number>();
    const fetchFn = this.deps.fetchImpl ?? fetch;
    const rawScopes = this.params.dexScopes ?? [];

    // Fail-closed: no verified roster configured → no HL query at all.
    if (rawScopes.length === 0) {
      return {
        prices,
        degradation: {
          reason: 'hip3_scope_roster_unverified',
          failedScopes: 0,
          issuedQueries: 0,
        },
      };
    }

    // Fail-closed on malformed scopes: a typo'd or non-address scope must
    // not be sent as a query body. Rejected scopes are counted.
    const validScopes = rawScopes.filter(s => typeof s === 'string' && SCOPE_FORMAT_RE.test(s.trim()));
    const invalidCount = rawScopes.length - validScopes.length;
    if (validScopes.length === 0) {
      return {
        prices,
        degradation: {
          reason: 'hip3_scope_invalid_format',
          failedScopes: invalidCount,
          issuedQueries: 0,
        },
      };
    }

    let failedScopes = invalidCount;
    let issuedQueries = 0;
    for (const dex of validScopes) {
      issuedQueries++;
      try {
        const res = await fetchFn(HL_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'metaAndAssetCtxs', dex }),
        });
        if (!res.ok) {
          failedScopes++;
          console.warn(`[equity_perp] HL scoped API non-ok (dex=${dex.slice(0, 10)}…): ${res.status}`);
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
        failedScopes++;
        console.warn('[equity_perp] failed to get HL prices:', err);
      }
    }

    let reason: EquityPerpDegradation['reason'] = null;
    if (failedScopes > 0 && issuedQueries > 0 && failedScopes >= issuedQueries) {
      reason = 'hip3_scoped_queries_failed';
    } else if (failedScopes > 0) {
      reason = 'hip3_scoped_queries_partial';
    }
    return { prices, degradation: { reason, failedScopes, issuedQueries } };
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
