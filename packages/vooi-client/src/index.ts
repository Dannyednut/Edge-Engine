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
 *
 * EM-STRAT-012 Phase-0.5 (work order C/D):
 *   - The transport helper is now an ECMAScript HARD-PRIVATE method
 *     (`#request`). TypeScript `private` is compile-time only — the compiled
 *     JS exposed `request()` as a regular runtime property that untyped
 *     callers could invoke to bypass every wrapper guard. A `#` private
 *     method is a runtime slot that is NOT an own property of the instance
 *     and is unreachable from outside the class body (no cast, no
 *     reflection, no transpiled-JS caller can reach it).
 *   - Defense in depth: `#request` classifies every (method, path) pair at
 *     the LOWEST actual submission boundary. Risk-increasing mutations
 *     require their specific scope; safety-positive stop/cancel/delete and
 *     read-only GETs pass without authorization; any UNLISTED mutation
 *     (method + path combination that is not classified) is DENIED — a new
 *     VOOI mutation endpoint cannot be adopted silently.
 *   - The close-intent exemption is REMOVED (work order D): no authoritative
 *     VOOI documentation proves paired-leg reduce-only venue semantics.
 *     Closing requires the narrow 'vooi:close-arbitrage-order' scope AND a
 *     request body whose both legs carry reduceOnly === true. The close
 *     scope does NOT authorize opening orders (tested).
 */

import {
  assertExecutionAuthorized,
  isExecutionAuthorized,
  ExecutionNotAuthorizedError,
} from '@edge/risk';

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

  // ─── Transport-level action classification (Phase-0.5, work order C) ───
  //
  // This is the LOWEST submission boundary: every HTTP request this client
  // can ever make flows through #request, and #request classifies the
  // (method, path, body) triple BEFORE any fetch happens. Public wrappers
  // add their own (earlier, better-erroring) guards; this layer guarantees
  // that no code path — current or future, inside or outside the class —
  // can reach the network with an unclassified risk-increasing mutation.
  //
  // Classification table (fail-closed — unlisted mutations are DENIED):
  //   POST /arbitrage-orders        → 'vooi:place-arbitrage-order'
  //                                   OR 'vooi:close-arbitrage-order' when
  //                                   BOTH legs carry reduceOnly === true
  //                                   (body-validated at this layer)
  //   POST /bots                    → 'vooi:create-bot'
  //   POST /bots/{id}/start         → 'vooi:start-bot'
  //   POST /bots/{id}/stop          → SAFETY-POSITIVE (ungated)
  //   DELETE /arbitrage-orders/{id} → SAFETY-POSITIVE (ungated)
  //   DELETE /bots/{id}             → SAFETY-POSITIVE (ungated)
  //   GET *                         → read-only (ungated)
  //   anything else                 → DENIED (unclassified mutation)
  #assertTransportAuthorization(method: string, path: string, body?: unknown): void {
    const pathOnly = path.split('?')[0];

    if (method === 'GET') return; // read-only

    if (method === 'POST' && pathOnly === '/arbitrage-orders') {
      if (isExecutionAuthorized('vooi:place-arbitrage-order')) return;
      // Close path: body-validated reduce-only + narrow close scope. The
      // venue semantics are NOT proven (work order D) — the reduceOnly flags
      // alone never authorize; the close scope is additionally required.
      const req = body as VooiArbitrageOrderRequest | undefined;
      const bothLegsReduceOnly =
        !!req &&
        req.primary?.reduceOnly === true &&
        req.hedge?.reduceOnly === true;
      if (bothLegsReduceOnly && isExecutionAuthorized('vooi:close-arbitrage-order')) return;
      throw new ExecutionNotAuthorizedError(
        bothLegsReduceOnly ? 'vooi:close-arbitrage-order' : 'vooi:place-arbitrage-order',
        'transport-level classification: order submission requires vooi:place-arbitrage-order' +
        (bothLegsReduceOnly
          ? ' (close-shaped body detected; vooi:close-arbitrage-order with both legs reduceOnly:true is the alternative)'
          : ' (body is not a two-leg reduce-only close)'),
      );
    }

    if (method === 'POST' && pathOnly === '/bots') {
      assertExecutionAuthorized('vooi:create-bot');
      return;
    }

    const startMatch = /^\/bots\/[^/]+\/start$/.exec(pathOnly);
    if (method === 'POST' && startMatch) {
      assertExecutionAuthorized('vooi:start-bot');
      return;
    }

    // Safety-positive (risk-reducing) operations — deliberately ungated so
    // emergency stop/cancel and cleanup remain available (Phase-0).
    const stopMatch = /^\/bots\/[^/]+\/stop$/.exec(pathOnly);
    if (method === 'POST' && stopMatch) return;
    if (method === 'DELETE' && /^\/arbitrage-orders\/[^/]+$/.test(pathOnly)) return;
    if (method === 'DELETE' && /^\/bots\/[^/]+$/.test(pathOnly)) return;

    // FAIL-CLOSED: any other method/path combination is an UNCLASSIFIED
    // mutation. Deny it — a new VOOI mutation endpoint must be added to this
    // classifier (with a scope) before it can be used.
    throw new ExecutionNotAuthorizedError(
      'vooi:place-arbitrage-order',
      `transport-level classification: unclassified mutation ${method} ${pathOnly} is denied by default`,
    );
  }

  /**
   * HARD-PRIVATE transport helper (ECMAScript `#` method).
   *
   * Phase-0.5 (work order C): this replaces the old TypeScript-private
   * `request()`. A TS `private` method survives compilation as a normal
   * runtime property — untyped/JS callers could invoke it directly and
   * bypass every wrapper guard. An `#` method is NOT an own property of the
   * instance: `(client as any).request` is undefined, and no cast,
   * reflection API, or external caller can reach it.
   */
  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // Transport-level classification FIRST — before headers, before fetch.
    this.#assertTransportAuthorization(method, path, body);

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

    return this.#request<VooiArbitrageScanResponse>('GET', `/arbitrage-scanner?${query.toString()}`);
  }

  /** Per-minute funding rates for a pair. */
  async fundingCandles(params: { asset: string; longExchange: string; shortExchange: string; limit?: number }): Promise<unknown> {
    const q = new URLSearchParams({
      asset: params.asset,
      longExchange: params.longExchange,
      shortExchange: params.shortExchange,
      limit: String(params.limit ?? 60),
    });
    return this.#request('GET', `/arbitrage-scanner/funding-candles?${q.toString()}`);
  }

  // ─── Authenticated trading endpoints ─────────────────────────────────
  //
  // EM-STRAT-012 Phase-0: risk-increasing mutation sinks are gated by the
  // shared fail-closed execution guard at this choke point, so direct method
  // calls cannot bypass containment. Safety-positive (risk-reducing) methods
  // — stopBot, cancelArbitrageOrder, deleteBot — are deliberately UNGATED so
  // emergency stop/cancel remains available without execution authorization.
  // Phase-0.5: #request additionally classifies every (method, path) pair at
  // the lowest submission boundary (see #assertTransportAuthorization).

  /**
   * Submit a paired-leg arbitrage order.
   *
   * Risk classification: RISK-INCREASING for opening orders
   * ('vooi:place-arbitrage-order' scope). Close-intent orders
   * (`intent: 'close'`) require the narrow 'vooi:close-arbitrage-order'
   * scope — that scope is distinct from the open scope and CANNOT authorize
   * opening orders.
   *
   * EM-STRAT-012 Phase-0.5 (work order D): the R1 UNGATED close exemption is
   * REMOVED. Reason: the exemption relied on the claim that VOOI honours
   * `reduceOnly` on paired-leg orders, and no authoritative VOOI API
   * documentation proves that semantics (checked docs.vooi.io — the
   * Arbitrage Desk and Perps API overview pages do not document the
   * /arbitrage-orders reduceOnly parameter). Setting a flag in a request
   * body is not proof the venue honours it, so reduce-only validation alone
   * no longer authorizes anything.
   *
   * Close-intent requirements (all enforced, fail-closed):
   *   1. `intent: 'close'` is supplied.
   *   2. BOTH legs carry `reduceOnly === true` (body-validated — a
   *      close-intent call with missing/false flags throws a plain
   *      validation error BEFORE the guard, because such a request is not a
   *      close at all).
   *   3. The 'vooi:close-arbitrage-order' scope is authorized.
   * The transport layer (#request) independently re-validates conditions
   * 2 and 3 against the actual body at the lowest submission boundary.
   *
   * Scope isolation (tested): 'vooi:close-arbitrage-order' does NOT
   * authorize opening orders; 'vooi:place-arbitrage-order' does NOT
   * authorize close-intent submissions.
   *
   * Default when intent is omitted: 'open' (open scope required).
   */
  async placeArbitrageOrder(
    req: VooiArbitrageOrderRequest,
    opts?: { intent?: 'open' | 'close' },
  ): Promise<VooiArbitrageOrder> {
    if (!this.apiToken) throw new Error('VooiClient.placeArbitrageOrder: apiToken required');
    const intent = opts?.intent ?? 'open';
    if (intent === 'close') {
      // A close-intent order that is not a two-leg reduce-only close is not
      // a close at all — reject it as a malformed close BEFORE any guard
      // evaluation (it must never be submitted under either scope).
      if (!(req.primary.reduceOnly === true && req.hedge.reduceOnly === true)) {
        throw new Error(
          'VooiClient.placeArbitrageOrder: intent "close" requires reduceOnly:true on BOTH legs ' +
          '(primary and hedge). Refusing to submit — a close with non-reduce-only legs could ' +
          'increase exposure.',
        );
      }
      assertExecutionAuthorized('vooi:close-arbitrage-order');
    } else {
      assertExecutionAuthorized('vooi:place-arbitrage-order');
    }
    return this.#request<VooiArbitrageOrder>('POST', '/arbitrage-orders', req);
  }

  async listArbitrageOrders(status?: 'open' | 'history'): Promise<{ cursor: string | null; items: VooiArbitrageOrder[] }> {
    const q = status ? `?status=${status}` : '';
    return this.#request<{ cursor: string | null; items: VooiArbitrageOrder[] }>('GET', `/arbitrage-orders${q}`);
  }

  async cancelArbitrageOrder(id: string): Promise<{ ok: boolean }> {
    return this.#request('DELETE', `/arbitrage-orders/${id}`);
  }

  /**
   * Create an autonomous arb bot. Risk classification: RISK-INCREASING —
   * once started, the bot trades 24/7 outside this engine's process.
   * Requires the 'vooi:create-bot' scope.
   */
  async createBot(req: VooiBotRequest): Promise<VooiBot> {
    if (!this.apiToken) throw new Error('VooiClient.createBot: apiToken required');
    assertExecutionAuthorized('vooi:create-bot');
    return this.#request<VooiBot>('POST', '/bots', req);
  }

  async listBots(): Promise<VooiBot[]> {
    return this.#request<VooiBot[]>('GET', '/bots');
  }

  /**
   * Start a created bot. Risk classification: RISK-INCREASING — the bot
   * begins trading autonomously. Requires the 'vooi:start-bot' scope.
   */
  async startBot(id: string): Promise<VooiBot> {
    assertExecutionAuthorized('vooi:start-bot');
    return this.#request<VooiBot>('POST', `/bots/${id}/start`);
  }

  // SAFETY-POSITIVE (risk-reducing): stopBot halts an autonomous bot and
  // deliberately carries NO execution guard so emergency stops remain
  // available without execution authorization (EM-STRAT-012 Phase-0).
  async stopBot(id: string): Promise<VooiBot> {
    return this.#request<VooiBot>('POST', `/bots/${id}/stop`);
  }

  // SAFETY-POSITIVE (risk-reducing/cleanup): deleteBot removes a (necessarily
  // stopped) bot configuration. It cannot open or increase exposure and is
  // deliberately ungated so cleanup remains available (EM-STRAT-012 Phase-0).
  async deleteBot(id: string): Promise<{ ok: boolean }> {
    return this.#request('DELETE', `/bots/${id}`);
  }
}
