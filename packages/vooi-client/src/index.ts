/**
 * @edge/vooi-client — TypeScript client for VOOI Perps API.
 *
 * Base URL: https://perps-api.vooi.io
 * Auth:     Bearer token (Ed25519-signed; generate at ultra.vooi.io/api-tokens)
 *
 * Public arbitrage scanner endpoints need NO auth.
 * Trading endpoints (POST /arbitrage-orders, POST /bots) require Bearer.
 *
 * EM-STRAT-012 Phase-0: risk-increasing mutation methods (placeArbitrageOrder
 * with open intent, createBot, startBot) are gated by the shared fail-closed
 * execution guard from @edge/risk. Safety-positive methods (stopBot,
 * cancelArbitrageOrder, deleteBot) are deliberately ungated.
 */

import { assertExecutionAuthorized } from '@edge/risk';

const VOOI_BASE = 'https://perps-api.vooi.io';

export interface VooiClientOptions {
  apiToken?: string;
  fetchImpl?: typeof fetch;
}

// ─── Public arbitrage scanner types ─────────────────────────────────────

export interface VooiArbitragePair {
  asset: string;                 // populated from parent item.asset during flattening
  long: {
    exchange: string;
    fundingRate: string;          // decimal as string, e.g. "-0.003497"
    fundingRate8h?: number;       // computed: Number(fundingRate) × 3 (8h = 3 × 1h)
    price: string;                // string
    price24hPercent?: number;
    volume24h: number;
    openInterest: string;         // string
    openInterestUsd?: number;     // computed
    nextFundingTime?: string;     // ISO
    maxLeverage?: number;
    baseSymbol?: string;
    quoteSymbol?: string;
    marketId?: string;
    bestBid?: number | null;
    bestAsk?: number | null;
    depthImpact?: number | null;
    slippage?: number | null;
  };
  short: VooiArbitragePair['long'];
  avgFundingSpread24h?: number | null;
  fundingSpread1h: number;        // decimal
  fundingSpreadPositiveSince?: string;
  fundingSpread24h?: number | null;
  maxFundingSpread1h: number;
  maxFundingSpread24h: number;
  priceSpread: number | null;
  priceSpreadAtSize?: number | null;
  maxPriceSpread1h?: number | null;
  maxPriceSpread24h?: number | null;
  priceImpact?: number | null;
  category?: string;
  exchangeCount?: number;
}

export interface VooiArbitrageScanResponse {
  items: Array<{
    asset: string;
    pairs: VooiArbitragePair[];
  }>;
  total: number;
}

export interface VooiScanParams {
  exchanges?: string[];
  categories?: string[];   // 'commodities' | 'crypto' | 'etf-index' | 'forex' | 'pre-ipo' | 'stocks-asia' | 'stocks-us'
  excludeSymbols?: string[];
  minFundingSpread?: number;
  minPriceSpread?: number;
  minOpenInterest?: number;
  minVolume?: number;
  notionalUsd?: number;        // default 1000
  orderBy?: 'fundingSpread1h' | 'fundingSpread24h' | 'priceSpread' | 'openInterest' | 'volume24h';
  orderDirection?: 'asc' | 'desc';
  limit?: number;              // 1-100, default 15
  offset?: number;
  query?: string;              // symbol search
  symbol?: string;
}

// ─── Authenticated trading types ────────────────────────────────────────

export interface VooiArbitrageOrderLeg {
  asset: string;
  exchange: string;
  side: 'buy' | 'sell';
  size: number;                // in contracts
  type: 'limit' | 'market';
  price?: number;              // required for limit
  reduceOnly?: boolean;
  timeInForce?: 'gtc' | 'ioc' | 'fok' | 'alo';
}

export interface VooiArbitrageOrderRequest {
  primary: VooiArbitrageOrderLeg;
  hedge: VooiArbitrageOrderLeg;
  partialFillPolicy?: 'fullFill';       // only allowed value
  hedgeFailurePolicy?: 'alertAndHold'; // only allowed value
  clientOrderId?: string;
}

export interface VooiArbitrageOrder {
  id: string;
  status: 'pending' | 'primary-filled' | 'both-filled' | 'cancelled' | 'failed' | 'hedge-failed';
  primary: VooiArbitrageOrderLeg & { fillPrice?: number; fillSize?: number; ts?: number };
  hedge: VooiArbitrageOrderLeg & { fillPrice?: number; fillSize?: number; ts?: number };
  ts: number;
  error?: string;
}

export interface VooiBotRequest {
  exchanges: string[];             // min 2
  leverage: number;
  maxHoldHours?: number;           // default 24
  maxRoundTripCostBps?: number;    // default 12
  notionalUsd: number;
  requiredExchange?: string;
  categories?: string[];
  symbols?: string[];
}

export interface VooiBot {
  id: string;
  status: 'stopped' | 'running' | 'paused';
  exchanges: string[];
  leverage: number;
  maxHoldHours: number;
  maxRoundTripCostBps: number;
  notionalUsd: number;
  createdAt: number;
  lastError?: string;
  openPositions?: number;
}

// ─── Client ────────────────────────────────────────────────────────────

export class VooiClient {
  private readonly apiToken?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: VooiClientOptions = {}) {
    this.apiToken = opts.apiToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${VOOI_BASE}${path}`;
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (this.apiToken) headers['Authorization'] = `Bearer ${this.apiToken}`;

    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`VOOI ${method} ${path} ${res.status}: ${errText.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  // ─── Public arbitrage scanner (no auth needed) ───────────────────────

  async scanArbitrage(params: VooiScanParams = {}): Promise<VooiArbitrageScanResponse> {
    const query = new URLSearchParams();
    if (params.exchanges?.length)    query.set('exchanges', params.exchanges.join(','));
    if (params.categories?.length)   query.set('categories', params.categories.join(','));
    if (params.excludeSymbols?.length) query.set('excludeSymbols', params.excludeSymbols.join(','));
    if (params.minFundingSpread !== undefined) query.set('minFundingSpread', String(params.minFundingSpread));
    if (params.minPriceSpread !== undefined)   query.set('minPriceSpread', String(params.minPriceSpread));
    if (params.minOpenInterest !== undefined)  query.set('minOpenInterest', String(params.minOpenInterest));
    if (params.minVolume !== undefined)        query.set('minVolume', String(params.minVolume));
    if (params.notionalUsd !== undefined)      query.set('notionalUsd', String(params.notionalUsd));
    if (params.orderBy)        query.set('orderBy', params.orderBy);
    if (params.orderDirection) query.set('orderDirection', params.orderDirection);
    if (params.limit !== undefined)  query.set('limit', String(params.limit));
    if (params.offset !== undefined) query.set('offset', String(params.offset));
    if (params.query)    query.set('query', params.query);
    if (params.symbol)   query.set('symbol', params.symbol);

    return this.request<VooiArbitrageScanResponse>('GET', `/arbitrage-scanner?${query.toString()}`);
  }

  /** Per-minute funding rates for a pair. */
  async fundingCandles(params: { asset: string; longExchange: string; shortExchange: string; limit?: number }): Promise<unknown> {
    const q = new URLSearchParams({
      asset: params.asset,
      longExchange: params.longExchange,
      shortExchange: params.shortExchange,
      limit: String(params.limit ?? 60),
    });
    return this.request('GET', `/arbitrage-scanner/funding-candles?${q.toString()}`);
  }

  // ─── Authenticated trading endpoints ─────────────────────────────────
  //
  // EM-STRAT-012 Phase-0: risk-increasing mutation sinks are gated by the
  // shared fail-closed execution guard at this choke point, so direct method
  // calls cannot bypass containment. Safety-positive (risk-reducing) methods
  // — stopBot, cancelArbitrageOrder, deleteBot — are deliberately UNGATED so
  // emergency stop/cancel remains available without execution authorization.

  /**
   * Submit a paired-leg arbitrage order.
   *
   * Risk classification: RISK-INCREASING by default. The optional
   * `intent: 'close'` marks the call as a strictly risk-reducing exit
   * (used by VooiExecutor.closeArb whose legs carry reduceOnly: true —
   * the venue rejects reduce-only orders that would increase exposure).
   * Close-intent calls are permitted without execution authorization so
   * risk-reducing exits stay available; every other call requires the
   * 'vooi:place-arbitrage-order' scope. Default when intent is omitted:
   * 'open' (guarded — fail-closed).
   */
  async placeArbitrageOrder(
    req: VooiArbitrageOrderRequest,
    opts?: { intent?: 'open' | 'close' },
  ): Promise<VooiArbitrageOrder> {
    if (!this.apiToken) throw new Error('VooiClient.placeArbitrageOrder: apiToken required');
    if ((opts?.intent ?? 'open') !== 'close') {
      assertExecutionAuthorized('vooi:place-arbitrage-order');
    }
    return this.request<VooiArbitrageOrder>('POST', '/arbitrage-orders', req);
  }

  async listArbitrageOrders(status?: 'open' | 'history'): Promise<{ cursor: string | null; items: VooiArbitrageOrder[] }> {
    const q = status ? `?status=${status}` : '';
    return this.request<{ cursor: string | null; items: VooiArbitrageOrder[] }>('GET', `/arbitrage-orders${q}`);
  }

  async cancelArbitrageOrder(id: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/arbitrage-orders/${id}`);
  }

  /**
   * Create an autonomous arb bot. Risk classification: RISK-INCREASING —
   * once started, the bot trades 24/7 outside this engine's process.
   * Requires the 'vooi:create-bot' scope.
   */
  async createBot(req: VooiBotRequest): Promise<VooiBot> {
    if (!this.apiToken) throw new Error('VooiClient.createBot: apiToken required');
    assertExecutionAuthorized('vooi:create-bot');
    return this.request<VooiBot>('POST', '/bots', req);
  }

  async listBots(): Promise<VooiBot[]> {
    return this.request<VooiBot[]>('GET', '/bots');
  }

  /**
   * Start a created bot. Risk classification: RISK-INCREASING — the bot
   * begins trading autonomously. Requires the 'vooi:start-bot' scope.
   */
  async startBot(id: string): Promise<VooiBot> {
    assertExecutionAuthorized('vooi:start-bot');
    return this.request<VooiBot>('POST', `/bots/${id}/start`);
  }

  // SAFETY-POSITIVE (risk-reducing): stopBot halts an autonomous bot and
  // deliberately carries NO execution guard so emergency stops remain
  // available without execution authorization (EM-STRAT-012 Phase-0).
  async stopBot(id: string): Promise<VooiBot> {
    return this.request<VooiBot>('POST', `/bots/${id}/stop`);
  }

  // SAFETY-POSITIVE (risk-reducing/cleanup): deleteBot removes a (necessarily
  // stopped) bot configuration. It cannot open or increase exposure and is
  // deliberately ungated so cleanup remains available (EM-STRAT-012 Phase-0).
  async deleteBot(id: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/bots/${id}`);
  }
}
