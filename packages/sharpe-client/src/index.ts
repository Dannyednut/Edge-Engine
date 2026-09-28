/**
 * @edge/sharpe-client — TypeScript client for Sharpe.ai public + authenticated API.
 *
 * Base URL: https://www.sharpe.ai/api/v1
 * Auth:     Bearer sk_live_...  (free tier — generate at sharpe.ai/docs/authentication)
 *
 * Free tier limits: 30 RPM / 10k req per month.
 * For dev we use the public no-auth mirror at https://www.sharpe.ai/api/*
 * (1-min to 1-hr edge cache, no envelope).
 */

const SHARPE_BASE_V1    = 'https://www.sharpe.ai/api/v1';
const SHARPE_BASE_PUBLIC = 'https://www.sharpe.ai/api';

export interface SharpeClientOptions {
  apiKey?: string;
  /** Use the public no-auth mirror (default true if no apiKey). */
  usePublicMirror?: boolean;
  /** Optional fetch implementation (for tests). */
  fetchImpl?: typeof fetch;
}

// ─── Response types (subset, focused on arbitrage endpoints) ───────────

export interface ArbitrageRow {
  coin?: string;
  asset?: string;
  symbol?: string;
  exchange?: string;
  exchanges?: string[];
  longExchange?: string;
  shortExchange?: string;
  netApr?: number;
  grossApr?: number;
  netFundingRate?: number;
  spreadRate?: number;
  spreadSource?: 'book' | 'reference';
  intervalHours?: number;
  executionStatus?: 'executable' | 'stale' | 'insufficient-depth';
  longOiUsd?: number;
  shortOiUsd?: number;
  longVolUsd?: number;
  shortVolUsd?: number;
  nextSettlement?: number;
  minDepthUsd?: number;
  spreadLifetimeSeconds?: number;
  notes?: string;
}

export interface ArbitrageResponse {
  data: ArbitrageRow[];
  cursor?: string;
  meta?: {
    asOf?: number;
    freshnessSlaSeconds?: number;
    dataSource?: string;
  };
}

export interface FundingRateRow {
  coin: string;
  exchange: string;
  rate: number;            // 8h funding rate, decimal
  annualized: number;      // APR
  nextFundingTime?: number;
  oiUsd?: number;
  volUsd?: number;
}

export interface FundingRateResponse {
  data: FundingRateRow[];
  meta?: {
    asOf?: number;
    dataSource?: string;
  };
}

// ─── Client ────────────────────────────────────────────────────────────

export class SharpeClient {
  private readonly apiKey?: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SharpeClientOptions = {}) {
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    const usePublic = opts.usePublicMirror ?? !this.apiKey;
    this.base = usePublic ? SHARPE_BASE_PUBLIC : SHARPE_BASE_V1;
  }

  private async request<T>(path: string, params?: Record<string, string | number | boolean | string[] | undefined>): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) {
          url.searchParams.set(k, v.join(','));
        } else {
          url.searchParams.set(k, String(v));
        }
      }
    }
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const res = await this.fetchImpl(url.toString(), { headers });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Sharpe ${path} ${res.status}: ${errText.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  // ─── Arbitrage endpoints ─────────────────────────────────────────────

  /** Cross-exchange funding-rate differential across all 32 venues. */
  async crossExchangeFunding(params: {
    assetClass?: 'all' | 'crypto' | 'rwa';
    minApr?: number;
    minOiUsd?: number;
    minVolUsd?: number;
    exchanges?: string[];
    cursor?: string;
  } = {}): Promise<ArbitrageResponse> {
    const url = new URL(`${this.base}/arbitrage/cross-exchange`);
    if (params.assetClass)   url.searchParams.set('assetClass', params.assetClass ?? 'crypto');
    if (params.minApr)       url.searchParams.set('minApr', String(params.minApr));
    if (params.minOiUsd)     url.searchParams.set('minOiUsd', String(params.minOiUsd));
    if (params.minVolUsd)    url.searchParams.set('minVolUsd', String(params.minVolUsd));
    if (params.exchanges?.length) url.searchParams.set('exchanges', params.exchanges.join(','));
    if (params.cursor)       url.searchParams.set('cursor', params.cursor);

    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    const res = await this.fetchImpl(url.toString(), { headers });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Sharpe /arbitrage/cross-exchange ${res.status}: ${errText.slice(0, 200)}`);
    }
    const json: unknown = await res.json();
    // Public mirror returns array directly; authenticated v1 returns {data: [...]}
    const rows = Array.isArray(json) ? json : ((json as { data?: ArbitrageRow[] }).data ?? []);
    return { data: rows as ArbitrageRow[], meta: { asOf: Date.now() } };
  }

  /** Spot-perp funding capture. direction=short captures positive funding. */
  async spotPerp(params: {
    exchange?: string;
    direction?: 'long' | 'short';
    minApr?: number;
  } = {}): Promise<ArbitrageResponse> {
    return this.request<ArbitrageResponse>('/arbitrage/spot-perp', {
      exchange: params.exchange,
      direction: params.direction ?? 'short',
      minApr: params.minApr ?? 5,
    });
  }

  /** Cash-and-carry basis trade (spot ask × dated-futures bid). */
  async datedFuturesBasis(params: {
    coin?: string;
    exchanges?: string[];
    minApr?: number;
    minDepthUsd?: number;
    marginType?: 'cross' | 'isolated';
    notional?: number;
  } = {}): Promise<ArbitrageResponse> {
    return this.request<ArbitrageResponse>('/arbitrage/dated-futures-basis', {
      coin: params.coin,
      exchanges: params.exchanges?.join(','),
      minApr: params.minApr ?? 3,
      minDepthUsd: params.minDepthUsd ?? 100_000,
      marginType: params.marginType,
      notional: params.notional ?? 10_000,
    });
  }

  /** CEX-CEX spot transfer after withdrawal/deposit fees. */
  async cexSpotTransfer(params: {
    coin?: string;
    exchanges?: string[];
    minApr?: number;
    minDepthUsd?: number;
    notional?: number;
    format?: 'json' | 'csv';
  } = {}): Promise<ArbitrageResponse> {
    const url = new URL(`${this.base}/arbitrage/cex-spot-transfer`);
    if (params.coin)            url.searchParams.set('coin', params.coin);
    if (params.exchanges?.length) url.searchParams.set('exchanges', params.exchanges.join(','));
    if (params.minApr)          url.searchParams.set('minApr', String(params.minApr));
    if (params.minDepthUsd)     url.searchParams.set('minDepthUsd', String(params.minDepthUsd));
    if (params.notional)        url.searchParams.set('notional', String(params.notional));
    if (params.format)          url.searchParams.set('format', params.format);

    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    const res = await this.fetchImpl(url.toString(), { headers });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Sharpe /arbitrage/cex-spot-transfer ${res.status}: ${errText.slice(0, 200)}`);
    }
    const json: unknown = await res.json();
    // Response shape: {data: {rows: [...], scannerMeta: {...}}}
    // Or legacy: {data: [...]}
    // Or public mirror: [...]
    let rows: ArbitrageRow[] = [];
    if (Array.isArray(json)) {
      rows = json as ArbitrageRow[];
    } else if (Array.isArray((json as { data?: ArbitrageRow[] }).data)) {
      rows = (json as { data: ArbitrageRow[] }).data;
    } else if ((json as { data?: { rows?: ArbitrageRow[] } }).data?.rows) {
      rows = (json as { data: { rows: ArbitrageRow[] } }).data.rows;
    }
    return { data: rows, meta: { asOf: Date.now() } };
  }

  /** DEX-vs-CEX or DEX-vs-DEX gross spread. Returns GROSS (not net). */
  async dexScannerPreview(params: {
    poolUrl: string;
    mode?: 'cex_dex' | 'dex_dex';
    secondPoolUrl?: string;
    exchanges?: string[];
    minProfitPct?: number;
    includeFundingLeg?: boolean;
  }): Promise<ArbitrageResponse> {
    return this.request<ArbitrageResponse>('/arbitrage/dex-scanner/preview', {
      poolUrl: params.poolUrl,
      mode: params.mode ?? 'cex_dex',
      secondPoolUrl: params.secondPoolUrl,
      exchanges: params.exchanges?.join(','),
      minProfitPct: params.minProfitPct ?? 1.0,
      includeFundingLeg: params.includeFundingLeg ?? false,
    });
  }

  // ─── Funding rate endpoints ──────────────────────────────────────────

  /** Live funding rates across 32 venues. */
  async fundingRates(params: {
    coin?: string;
    exchange?: string;
    assetClass?: 'crypto' | 'rwa';
  } = {}): Promise<FundingRateResponse> {
    return this.request<FundingRateResponse>('/funding/rates', {
      coin: params.coin,
      exchange: params.exchange,
      assetClass: params.assetClass ?? 'crypto',
    });
  }

  // ─── Risk overlay endpoints ──────────────────────────────────────────

  /** Persistent-negative-funding score (manipulation signal). */
  async insiderSelling(): Promise<unknown> {
    return this.request('/insider-selling/data');
  }

  /** Pump-and-dump flag. */
  async pumpDump(): Promise<unknown> {
    return this.request('/pump-dump/data');
  }
}
