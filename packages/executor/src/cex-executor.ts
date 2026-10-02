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
 */

import ccxt, { type Exchange, type Order } from 'ccxt';

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
  readonly exchange: Exchange;
  readonly exchangeId: string;

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
    this.exchange = new ExchangeClass(config);
  }

  /** Get ticker (last price, bid, ask, volume). */
  async getTicker(symbol: string): Promise<{
    last: number;
    bid: number;
    ask: number;
    volume: number;
    high: number;
    low: number;
  }> {
    const ticker = await this.exchange.fetchTicker(symbol);
    return {
      last: ticker.last ?? 0,
      bid: ticker.bid ?? 0,
      ask: ticker.ask ?? 0,
      volume: ticker.baseVolume ?? 0,
      high: ticker.high ?? 0,
      low: ticker.low ?? 0,
    };
  }

  /** Get order book depth. */
  async getOrderBook(symbol: string, limit?: number): Promise<{
    bids: [number, number][];
    asks: [number, number][];
    spread: number;
    midPrice: number;
  }> {
    const ob = await this.exchange.fetchOrderBook(symbol, limit);
    const bestBid = ob.bids.length > 0 ? Number(ob.bids[0][0]) : 0;
    const bestAsk = ob.asks.length > 0 ? Number(ob.asks[0][0]) : 0;
    const midPrice = (bestBid + bestAsk) / 2;
    const spread = midPrice > 0 ? (bestAsk - bestBid) / midPrice : 0;
    const bids = ob.bids.map(([p, q]) => [Number(p), Number(q)] as [number, number]);
    const asks = ob.asks.map(([p, q]) => [Number(p), Number(q)] as [number, number]);
    return { bids, asks, spread, midPrice };
  }

  /** Place a market order. */
  async marketOrder(params: CexOrderParams): Promise<Order> {
    return this.exchange.createOrder(
      params.symbol,
      'market',
      params.side,
      params.amount,
    );
  }

  /** Place a limit order. */
  async limitOrder(params: CexOrderParams): Promise<Order> {
    if (!params.price) throw new Error('limitOrder requires price');
    return this.exchange.createOrder(
      params.symbol,
      'limit',
      params.side,
      params.amount,
      params.price,
    );
  }

  /** Cancel an order. */
  async cancelOrder(orderId: string, symbol: string): Promise<unknown> {
    return this.exchange.cancelOrder(orderId, symbol);
  }

  /** Get account balance. */
  async getBalance(): Promise<Record<string, { free: number; used: number; total: number }>> {
    const balance = await this.exchange.fetchBalance();
    return balance.total as unknown as Record<string, { free: number; used: number; total: number }>;
  }

  /** Get open positions (for futures/perps). */
  async getPositions(): Promise<unknown[]> {
    if (!this.exchange.has['fetchPositions']) {
      throw new Error(`${this.exchangeId} does not support fetchPositions`);
    }
    return this.exchange.fetchPositions();
  }

  /** Get deposit address for a token (for transferring from DEX to CEX). */
  async getDepositAddress(currency: string): Promise<{ address: string; tag?: string }> {
    const addr = await this.exchange.fetchDepositAddress(currency);
    return { address: String(addr.address), tag: addr.tag ? String(addr.tag) : undefined };
  }

  /** Withdraw to a specific address. */
  async withdraw(currency: string, amount: number, address: string, tag?: string): Promise<unknown> {
    return this.exchange.withdraw(currency, amount, address, tag, {});
  }

  /** Check if the exchange is reachable + API keys valid. */
  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      await this.exchange.fetchBalance();
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, error: String(err).slice(0, 200) };
    }
  }
}
