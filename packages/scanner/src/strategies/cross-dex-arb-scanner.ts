/**
 * CrossDexArbScanner compares reference prices for identical HyperEVM token
 * pairs across Ramses V3, HyperSwap V2 and HyperSwap V3.
 *
 * MONITORING ONLY: public pool prices and reserves are discovery data, not
 * trade-size execution quotes. Pool-specific fees, slippage, gas, routes and
 * atomicity are not modeled, so this scanner never claims net profit or an
 * executable arb.
 *
 * The public GeckoTerminal API is beta, caches responses for about a minute,
 * and documents an approximate 10-request/minute unauthenticated rate limit.
 * This scanner makes three calls per fresh scan and caches for at least 60s.
 * https://api.geckoterminal.com/docs/index.html
 * https://apiguide.geckoterminal.com/changelogs
 */
import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';

const GECKO_API = 'https://api.geckoterminal.com/api/v2';
const NETWORK = 'hyperevm';
const SCAN_CACHE_MS = 60_000;
const MAX_ALERTS = 25;
const DEXES = [
  { id: 'ramses-v3-hyperevm', name: 'Ramses V3' },
  { id: 'hyperswap-v2', name: 'HyperSwap V2' },
  { id: 'hyperswap-v3', name: 'HyperSwap V3' },
] as const;
const ECONOMICS_BLOCKER =
  'Monitoring only: public pool reference prices are not trade-size execution quotes. ' +
  'Pool-specific fees, slippage, gas, route availability and atomicity are not modeled.';

export interface CrossDexArbParams {
  /** Minimum gross reference-price divergence, in percent (15 bps = 0.15%). */
  minSpreadPct: number;
  /** Minimum GeckoTerminal pool reserve, in USD. */
  minReserveUsd: number;
  /** Informational risk bound; not used to estimate profit or execution. */
  maxSizeUsd: number;
}
export interface CrossDexArbAlert {
  pair: string;
  pairKey: string;
  token0Id: string;
  token1Id: string;
  priceBasis: string;
  dex1Name: string;
  dex1PoolId: string;
  dex1Price: number;
  dex2Name: string;
  dex2PoolId: string;
  dex2Price: number;
  spreadPct: number;
  direction: string;
  reserve1Usd: number;
  reserve2Usd: number;
  estimatedProfitUsd: null;
  netProfitUsd: null;
  executable: false;
  monitoringOnly: true;
  blocker: string;
  ts: number;
}
interface GeckoPoolQuote {
  pair: string; pairKey: string; token0Id: string; token1Id: string;
  dexId: string; dexName: string; poolId: string;
  priceToken1PerToken0: number; reserveUsd: number;
}
interface DexDefinition { id: string; name: string; }

function positiveNumber(value: unknown): number | null {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
function relationshipTokenId(relationships: Record<string, unknown>, key: 'base_token' | 'quote_token'): string {
  const relationship = relationships[key];
  if (!relationship || typeof relationship !== 'object') return '';
  const data = (relationship as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return '';
  const id = (data as { id?: unknown }).id;
  return typeof id === 'string' ? id.trim().toLowerCase() : '';
}
function toPoolQuote(entry: unknown, dex: DexDefinition): GeckoPoolQuote | null {
  if (!entry || typeof entry !== 'object') return null;
  const pool = entry as Record<string, unknown>;
  const attrs = pool.attributes && typeof pool.attributes === 'object'
    ? pool.attributes as Record<string, unknown> : {};
  const relationships = pool.relationships && typeof pool.relationships === 'object'
    ? pool.relationships as Record<string, unknown> : {};
  const baseTokenId = relationshipTokenId(relationships, 'base_token');
  const quoteTokenId = relationshipTokenId(relationships, 'quote_token');
  if (!baseTokenId || !quoteTokenId || baseTokenId === quoteTokenId) return null;

  // Canonicalize by exact token relationship IDs, not symbols or pool names.
  const token0Id = baseTokenId < quoteTokenId ? baseTokenId : quoteTokenId;
  const token1Id = baseTokenId < quoteTokenId ? quoteTokenId : baseTokenId;
  const baseIsToken0 = baseTokenId === token0Id;
  let price = positiveNumber(baseIsToken0
    ? attrs.base_token_price_quote_token
    : attrs.quote_token_price_base_token);

  // Defensive fallback for incomplete payloads, if both USD prices are valid.
  if (price === null) {
    const baseUsd = positiveNumber(attrs.base_token_price_usd);
    const quoteUsd = positiveNumber(attrs.quote_token_price_usd);
    if (baseUsd !== null && quoteUsd !== null) {
      price = baseIsToken0 ? baseUsd / quoteUsd : quoteUsd / baseUsd;
      if (!Number.isFinite(price) || price <= 0) price = null;
    }
  }
  const reserveUsd = positiveNumber(attrs.reserve_in_usd);
  if (price === null || reserveUsd === null) return null;
  const pair = typeof attrs.name === 'string' && attrs.name.trim()
    ? attrs.name.trim() : token0Id.slice(-10) + '/' + token1Id.slice(-10);
  const poolId = typeof pool.id === 'string' && pool.id
    ? pool.id : dex.id + ':' + token0Id + ':' + token1Id;
  return {
    pair, pairKey: token0Id + '|' + token1Id, token0Id, token1Id,
    dexId: dex.id, dexName: dex.name, poolId,
    priceToken1PerToken0: price, reserveUsd,
  };
}

export class CrossDexArbScanner implements Strategy {
  readonly id = 'cross_dex_arb';
  readonly landscape = 'C_dex_dex' as const;
  private lastAttemptAt = 0;
  private cachedAlerts: CrossDexArbAlert[] = [];
  private inFlightScan: Promise<CrossDexArbAlert[]> | null = null;

  constructor(private params: CrossDexArbParams) {}
  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 10,
      maxSizeUsd: this.params.maxSizeUsd,
      maxConcurrent: 1,
      cooldownMs: SCAN_CACHE_MS,
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<CrossDexArbAlert[]> {
    if (this.inFlightScan) return this.inFlightScan;
    const now = Date.now();
    if (this.lastAttemptAt > 0 && now - this.lastAttemptAt < SCAN_CACHE_MS) {
      return this.cachedAlerts.map(alert => ({ ...alert }));
    }
    this.lastAttemptAt = now;
    this.inFlightScan = this.scanFresh()
      .then(alerts => {
        this.cachedAlerts = alerts;
        return alerts.map(alert => ({ ...alert }));
      })
      .catch(error => {
        // Fail closed: never keep displaying stale divergence after a failed refresh.
        this.cachedAlerts = [];
        throw error;
      })
      .finally(() => { this.inFlightScan = null; });
    return this.inFlightScan;
  }

  private async scanFresh(): Promise<CrossDexArbAlert[]> {
    const poolsByDex = await Promise.all(DEXES.map(dex => this.fetchDexPools(dex)));
    const byPair = new Map<string, GeckoPoolQuote[]>();
    for (const pools of poolsByDex) {
      for (const pool of pools) {
        if (pool.reserveUsd < this.params.minReserveUsd) continue;
        const candidates = byPair.get(pool.pairKey) ?? [];
        candidates.push(pool);
        byPair.set(pool.pairKey, candidates);
      }
    }

    const alerts: CrossDexArbAlert[] = [];
    for (const pools of byPair.values()) {
      if (pools.length < 2) continue;
      for (let i = 0; i < pools.length; i++) {
        for (let j = i + 1; j < pools.length; j++) {
          const first = pools[i], second = pools[j];
          if (first.dexId === second.dexId) continue;
          const lower = Math.min(first.priceToken1PerToken0, second.priceToken1PerToken0);
          const higher = Math.max(first.priceToken1PerToken0, second.priceToken1PerToken0);
          if (lower <= 0) continue;
          const spreadPct = ((higher - lower) / lower) * 100;
          if (!Number.isFinite(spreadPct) || spreadPct < this.params.minSpreadPct) continue;
          alerts.push({
            pair: first.pair, pairKey: first.pairKey, token0Id: first.token0Id, token1Id: first.token1Id,
            priceBasis: 'token1 per one token0',
            dex1Name: first.dexName, dex1PoolId: first.poolId, dex1Price: first.priceToken1PerToken0,
            dex2Name: second.dexName, dex2PoolId: second.poolId, dex2Price: second.priceToken1PerToken0,
            spreadPct,
            direction: first.priceToken1PerToken0 <= second.priceToken1PerToken0
              ? first.dexName + ' lower reference price; ' + second.dexName + ' higher reference price'
              : second.dexName + ' lower reference price; ' + first.dexName + ' higher reference price',
            reserve1Usd: first.reserveUsd, reserve2Usd: second.reserveUsd,
            estimatedProfitUsd: null, netProfitUsd: null, executable: false, monitoringOnly: true,
            blocker: ECONOMICS_BLOCKER, ts: Date.now(),
          });
        }
      }
    }
    alerts.sort((a, b) => b.spreadPct - a.spreadPct);
    return alerts.slice(0, MAX_ALERTS);
  }

  private async fetchDexPools(dex: DexDefinition): Promise<GeckoPoolQuote[]> {
    const url = GECKO_API + '/networks/' + NETWORK + '/dexes/' + dex.id +
      '/pools?page=1&include=base_token,quote_token';
    const response = await fetch(url, { headers: { Accept: 'application/json;version=20230203' } });
    if (!response.ok) throw new Error('GeckoTerminal ' + dex.id + ' returned HTTP ' + response.status);
    const payload = await response.json() as unknown;
    if (!payload || typeof payload !== 'object' ||
        !Array.isArray((payload as { data?: unknown }).data)) {
      throw new Error('GeckoTerminal ' + dex.id + ' returned an invalid pools response');
    }
    return ((payload as { data: unknown[] }).data)
      .map(entry => toPoolQuote(entry, dex))
      .filter((quote): quote is GeckoPoolQuote => quote !== null);
  }
}
