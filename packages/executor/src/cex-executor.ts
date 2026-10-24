/**
 * CexExecutor — CEX spot/perp execution via ccxt.
 *
 * Used for:
 *   - DEX-CEX flashloan arb: the CEX sell leg (sell token on Binance/OKX/Bybit)
 *   - CEX-HL funding arb: the CEX perp leg (long perp on Binance/OKX/Bybit)
 *   - CEX-CEX spot transfer arb: buy on cheap CEX, transfer, sell on expensive CEX
 *
 * Supports: Binance, OKX, Bybit, Kraken, Coinbase, MEXC, Gate
 *
 * Auth: API key + secret per exchange (read-only initially, trade-enabled when ready)
 *
 * ─── EM-STRAT-014-B1 EXECUTION CONTAINMENT ───────────────────────────────
 *
 * Reachability (audited at main da138021): this class has ZERO import or
 * call sites in the repository and is deliberately NOT re-exported from
 * packages/executor/src/index.ts (the @edge/executor exports map exposes
 * only the package root). It remains importable by direct file path — the
 * same path the containment test suite uses — so the capability is
 * contained at its sinks rather than assumed away by the empty call-site
 * search:
 *
 *   1. The raw CCXT Exchange instance lives in the ECMAScript hard-private
 *      field #exchange. It was previously exposed as a PUBLIC readonly
 *      property, so any holder of an instance could call
 *      executor.exchange.createOrder(...) / .withdraw(...) directly and
 *      bypass every wrapper-level check. A TypeScript-only `private`
 *      modifier would NOT fix this (compile-time only; the compiled JS
 *      keeps a normal runtime own property reachable via reflection). #
 *      fields are genuinely private at runtime: they are not own properties
 *      of the instance (invisible to Object.getOwnPropertyNames, Reflect,
 *      and JSON serialization) and are lexically unreachable outside this
 *      class body. The ONLY way to reach the CCXT sink is through the
 *      guarded methods below.
 *   2. marketOrder/limitOrder assert 'cex-executor:place-order' immediately
 *      before the CCXT createOrder submission, re-checked on EVERY call —
 *      an instance created under a valid descriptor cannot submit once the
 *      descriptor expires.
 *   3. withdraw asserts the SEPARATE 'cex-executor:withdraw' scope, re-checked
 *      per call. Order authority NEVER implies withdrawal authority and vice
 *      versa; there is deliberately no broad shared scope for both.
 *   4. cancelOrder is deliberately UNGATED — SAFETY-POSITIVE (see its JSDoc
 *      for the documented rationale and accepted tradeoff).
 *   5. getTicker/getOrderBook/getBalance/getPositions/getDepositAddress/
 *      healthCheck are read-only (fetch-style market and account data) and
 *      remain available WITHOUT execution authorization — the legitimate
 *      market-monitoring capability this class must preserve. None of them
 *      can open, increase, or move exposure.
 *
 * Construction is deliberately UNGATED (unlike EvmExecutor): the
 * constructor derives no signer, transmits no credential, and performs no
 * network I/O — it only wraps caller-supplied configuration in the client
 * object. Every risk-increasing path is individually fail-closed at its
 * sink, which is the invariant the execution guard requires.
 *
 * .env: this module (and the whole @edge/executor package) loads NO .env
 * file — EDGE_EXECUTION_AUTH can only reach the guard through the
 * parent-process environment, never from a persisted .env file (the shared
 * loader in packages/risk/src/dotenv-safety.ts also excludes the key
 * repo-wide; both properties are enforced by tests).
 */

import ccxt, { type Exchange, type Order } from 'ccxt';
import { assertExecutionAuthorized } from '@edge/risk';

export interface CexExecutorOptions {
  exchangeId: string;          // 'binance', 'okx', 'bybit', etc.
  apiKey: string;
  apiSecret: string;
  /** Optional passphrase (OKX requires this) */
  passphrase?: string;
  /** Sandbox/testnet mode */
  sandbox?: boolean;
}

export interface CexOrderParams {
  symbol: string;              // 'BTC/USDT'
  side: 'buy' | 'sell';
  amount: number;              // in base currency (BTC, ETH, etc.)
  price?: number;              // for limit orders
  type?: 'market' | 'limit';
}

export class CexExecutor {
  /** Public metadata only — the exchange instance itself is #exchange below. */
  readonly exchangeId: string;

  // ─── HARD-PRIVATE CCXT exchange (EM-STRAT-014-B1) ─────────────────────
  //
  // This was previously exposed as a public readonly property (typed
  // Exchange), so any caller holding the instance could submit
  // `executor.exchange.createOrder(...)` or `.withdraw(...)` directly,
  // bypassing every wrapper-level check. ECMAScript `#` private fields are
  // runtime-private: not own properties of the instance, invisible to
  // property enumeration / reflection / JSON, and lexically unreachable
  // from outside this class body. The sink census additionally flags any
  // future re-exposure via the exposedExchangeProperty pattern.
  #exchange: Exchange;

  constructor(opts: CexExecutorOptions) {
    this.exchangeId = opts.exchangeId;
    const config: Record<string, unknown> = {
      apiKey: opts.apiKey,
      secret: opts.apiSecret,
      enableRateLimit: true,
    };
    if (opts.passphrase) config.password = opts.passphrase;
    if (opts.sandbox) config.sandbox = true;

    const ExchangeClass = (ccxt as any)[opts.exchangeId];
    if (!ExchangeClass) throw new Error(`Unknown exchange: ${opts.exchangeId}`);
    this.#exchange = new ExchangeClass(config);
  }

  /**
   * Get ticker (last price, bid, ask, volume).
   * READ-ONLY (fetchTicker) — ungated by design; no submission path.
   */
  async getTicker(symbol: string): Promise<{
    last: number;
    bid: number;
    ask: number;
    volume: number;
    high: number;
    low: number;
  }> {
    const ticker = await this.#exchange.fetchTicker(symbol);
    return {
      last: ticker.last ?? 0,
      bid: ticker.bid ?? 0,
      ask: ticker.ask ?? 0,
      volume: ticker.baseVolume ?? 0,
      high: ticker.high ?? 0,
      low: ticker.low ?? 0,
    };
  }

  /**
   * Get order book depth.
   * READ-ONLY (fetchOrderBook) — ungated by design; no submission path.
   */
  async getOrderBook(symbol: string, limit?: number): Promise<{
    bids: [number, number][];
    asks: [number, number][];
    spread: number;
    midPrice: number;
  }> {
    const ob = await this.#exchange.fetchOrderBook(symbol, limit);
    const bestBid = ob.bids.length > 0 ? Number(ob.bids[0][0]) : 0;
    const bestAsk = ob.asks.length > 0 ? Number(ob.asks[0][0]) : 0;
    const midPrice = (bestBid + bestAsk) / 2;
    const spread = midPrice > 0 ? (bestAsk - bestBid) / midPrice : 0;
    const bids = ob.bids.map(([p, q]) => [Number(p), Number(q)] as [number, number]);
    const asks = ob.asks.map(([p, q]) => [Number(p), Number(q)] as [number, number]);
    return { bids, asks, spread, midPrice };
  }

  /**
   * Place a market order.
   *
   * Fail-closed: requires 'cex-executor:place-order' on EVERY call,
   * asserted immediately before the CCXT submission (before any other
   * work) so an instance created under a valid descriptor cannot submit
   * once the descriptor expires. Withdrawal authority does NOT authorize
   * this method and this scope does NOT authorize withdrawal.
   */
  async marketOrder(params: CexOrderParams): Promise<Order> {
    assertExecutionAuthorized('cex-executor:place-order');
    return this.#exchange.createOrder(
      params.symbol,
      'market',
      params.side,
      params.amount,
    );
  }

  /**
   * Place a limit order.
   *
   * Fail-closed: same scope and per-call re-check as marketOrder. The guard
   * fires BEFORE the price validation so denial precedes any work.
   */
  async limitOrder(params: CexOrderParams): Promise<Order> {
    assertExecutionAuthorized('cex-executor:place-order');
    if (!params.price) throw new Error('limitOrder requires price');
    return this.#exchange.createOrder(
      params.symbol,
      'limit',
      params.side,
      params.amount,
      params.price,
    );
  }

  /**
   * Cancel an order.
   *
   * SAFETY-POSITIVE (EM-STRAT-014-B1) — deliberately ungated. Cancelling a
   * resting order cannot open, increase, or move exposure; it only prevents
   * further fills. Emergency unwind must remain available without execution
   * authorization (same rationale as VooiClient.cancelArbitrageOrder in the
   * sink census). ACCEPTED TRADEOFF: cancelling one leg of a paired
   * position can leave the other leg unhedged — the cancel itself only
   * removes future fill risk on this leg; residual exposure must be
   * flattened manually by the operator. Tests prove cancellation can never
   * place orders or move funds.
   */
  async cancelOrder(orderId: string, symbol: string): Promise<unknown> {
    return this.#exchange.cancelOrder(orderId, symbol);
  }

  /**
   * Get account balance.
   * READ-ONLY (fetchBalance) — ungated by design; no submission path.
   */
  async getBalance(): Promise<Record<string, { free: number; used: number; total: number }>> {
    const balance = await this.#exchange.fetchBalance();
    return balance.total as unknown as Record<string, { free: number; used: number; total: number }>;
  }

  /**
   * Get open positions (for futures/perps).
   * READ-ONLY (fetchPositions) — ungated by design; no submission path.
   */
  async getPositions(): Promise<unknown[]> {
    if (!this.#exchange.has['fetchPositions']) {
      throw new Error(`${this.exchangeId} does not support fetchPositions`);
    }
    return this.#exchange.fetchPositions();
  }

  /**
   * Get deposit address for a token (for transferring from DEX to CEX).
   * READ-ONLY (fetchDepositAddress) — ungated by design; no submission path.
   */
  async getDepositAddress(currency: string): Promise<{ address: string; tag?: string }> {
    const addr = await this.#exchange.fetchDepositAddress(currency);
    return { address: String(addr.address), tag: addr.tag ? String(addr.tag) : undefined };
  }

  /**
   * Withdraw to a specific address.
   *
   * Fail-closed: requires the SEPARATE 'cex-executor:withdraw' scope on
   * every call, asserted immediately before the CCXT submission.
   * Order-placement authority ('cex-executor:place-order') NEVER authorizes
   * withdrawal and vice versa — the two scopes are independent and both are
   * re-checked per submission.
   */
  async withdraw(currency: string, amount: number, address: string, tag?: string): Promise<unknown> {
    assertExecutionAuthorized('cex-executor:withdraw');
    return this.#exchange.withdraw(currency, amount, address, tag, {});
  }

  /**
   * Check if the exchange is reachable + API keys valid.
   * READ-ONLY (fetchBalance) — ungated by design; no submission path.
   */
  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      await this.#exchange.fetchBalance();
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, error: String(err).slice(0, 200) };
    }
  }
}
