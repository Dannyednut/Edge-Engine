/**
 * @edge/backpack-client — TypeScript client for Backpack Exchange API.
 *
 * Backpack is a Solana-based CEX that lists:
 *   - Crypto spot + perp markets (SOL, PYTH, JTO, etc.)
 *   - Tokenized US equity markets (SPCX/SpaceX, SNDK/SanDisk, TSLA, NVDA, AAPL)
 *
 * Base URL: https://api.backpack.exchange/api/v1
 * Auth: API key + secret (HMAC-SHA256 signed requests) for private endpoints
 *       No auth for public endpoints (ticker, depth, markets)
 *
 * Tokenized equity markets (verified live Oct 1 2026):
 *   SPCX.US_USDC        — SpaceX spot
 *   SPCX.US_USDC_PERP   — SpaceX perp
 *   SNDK.US_USDC        — SanDisk spot
 *   SNDK.US_USDC_PERP   — SanDisk perp
 *   TSLA.US_USDC_PERP   — Tesla perp
 *   NVDA.US_USDC_PERP   — NVIDIA perp
 *   AAPL.US_USDC_PERP   — Apple perp
 *
 * Arb use case: spot-perp basis arbitrage on tokenized equities.
 *   Buy spot SPCX, short perp SPCX → capture basis + funding.
 *   Currently illiquid (49-53% spreads) but monitoring for Q4 DTCC launch.
 */

const BACKPACK_API = 'https://api.backpack.exchange/api/v1';

export interface BackpackClientOptions {
  apiKey?: string;
  apiSecret?: string;
  fetchImpl?: typeof fetch;
}

// ─── Public market data types ──────────────────────────────────────────

export interface BackpackTicker {
  symbol: string;
  firstPrice: string;
  lastPrice: string;
  markPrice?: string;
  indexPrice?: string;
  priceChange: string;
  priceChangePercent: string;
  high: string;
  low: string;
  volume: string;
  quoteVolume: string;
}

export interface BackpackDepth {
  symbol: string;
  asks: [string, string][];  // [price, quantity]
  bids: [string, string][];
  lastUpdateId: number;
}

export interface BackpackMarket {
  symbol: string;
  status: string;
  baseAsset?: string;
  quoteAsset?: string;
  marketType: string;        // 'SPOT' or 'FUTURES'
  pricePrecision: number;
  quantityPrecision: number;
  filters: Record<string, unknown>;
}

export interface BackpackOrder {
  id: string;
  clientId?: string;
  symbol: string;
  side: 'Bid' | 'Ask';
  orderType: 'Limit' | 'Market';
  quantity: string;
  executedQuantity: string;
  price?: string;
  timeInForce?: string;
  status: 'Open' | 'Filled' | 'Cancelled' | 'PartiallyFilled' | 'Rejected';
  createdAt: number;
  updatedAt?: number;
  fills?: Array<{ price: string; quantity: string; fee: string }>;
}

export interface BackpackBalance {
  asset: string;
  available: string;
  total: string;
  locked: string;
}

// ─── Client ────────────────────────────────────────────────────────────

export class BackpackClient {
  /** @internal — will be used when private endpoints are implemented */
  private readonly _apiKey?: string;
  /** @internal — will be used when private endpoints are implemented */
  private readonly _apiSecret?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: BackpackClientOptions = {}) {
    this._apiKey = opts.apiKey;
    this._apiSecret = opts.apiSecret;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // ─── Public endpoints (no auth) ─────────────────────────────────────

  /** Get all markets. */
  async getMarkets(): Promise<BackpackMarket[]> {
    return this.publicGet<BackpackMarket[]>('/markets');
  }

  /** Get ticker for a symbol. */
  async getTicker(symbol: string): Promise<BackpackTicker> {
    return this.publicGet<BackpackTicker>(`/ticker?symbol=${symbol}`);
  }

  /** Get order book depth. */
  async getDepth(symbol: string, limit?: number): Promise<BackpackDepth> {
    const params = limit ? `?symbol=${symbol}&limit=${limit}` : `?symbol=${symbol}`;
    return this.publicGet<BackpackDepth>(`/depth${params}`);
  }

  /** Get all tokenized equity markets (spot + perp). */
  async getTokenizedEquityMarkets(): Promise<BackpackMarket[]> {
    const markets = await this.getMarkets();
    return markets.filter(m => m.symbol.includes('.US_'));
  }

  /** Get spot-perp basis for a tokenized equity. */
  async getBasis(symbol: string): Promise<{
    symbol: string;
    spotPrice?: number;
    perpPrice?: number;
    basisPct: number;
  }> {
    const spotSymbol = symbol.includes('_PERP') ? symbol.replace('_PERP', '') : symbol;
    const perpSymbol = symbol.includes('_PERP') ? symbol : `${symbol}_PERP`;

    const [spotTicker, perpTicker] = await Promise.all([
      this.getTicker(spotSymbol).catch(() => null),
      this.getTicker(perpSymbol).catch(() => null),
    ]);

    const spotPrice = spotTicker ? Number(spotTicker.lastPrice) : undefined;
    const perpPrice = perpTicker ? Number(perpTicker.lastPrice) : undefined;

    let basisPct = 0;
    if (spotPrice && perpPrice) {
      basisPct = ((perpPrice - spotPrice) / spotPrice) * 100;
    }

    return { symbol: spotSymbol, spotPrice, perpPrice, basisPct };
  }

  /** Get basis for all tokenized equities at once. */
  async getAllBases(): Promise<Array<{ symbol: string; spotPrice?: number; perpPrice?: number; basisPct: number }>> {
    const equityMarkets = await this.getTokenizedEquityMarkets();
    const spotSymbols = equityMarkets
      .filter(m => !m.symbol.includes('_PERP'))
      .map(m => m.symbol);

    const bases = await Promise.all(
      spotSymbols.map(s => this.getBasis(s).catch(() => ({ symbol: s, basisPct: 0 })))
    );
    return bases;
  }

  // ─── Private endpoints (require HMAC-SHA256 auth) ──────────────────

  /**
   * Sign a private request with HMAC-SHA256.
   * Backpack uses Ed25519 or API key signing. The API key signing works as:
   *   1. Build a signing message: timestamp + instruction + params
   *   2. HMAC-SHA256 the message with the API secret (base64-decoded)
   *   3. Send as Base58-encoded signature in X-TBX-SIGNATURE header
   *
   * NOTE: Backpack actually uses Ed25519 signing for private endpoints, not
   * HMAC-SHA256. The API key/secret pair is used to derive an Ed25519 keypair.
   * For now, this is a placeholder — we need Backpack API credentials to test.
   */

  /** Place an order (spot or perp). Requires API credentials. */
  async placeOrder(params: {
    symbol: string;
    side: 'Bid' | 'Ask';        // Backpack uses Bid/Ask not buy/sell
    orderType: 'Limit' | 'Market';
    quantity: string;
    price?: string;              // required for Limit
    timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'PO';
    postOnly?: boolean;
    reduceOnly?: boolean;
  }): Promise<BackpackOrder> {
    return this.privatePost<BackpackOrder>('/order', {
      symbol: params.symbol,
      side: params.side,
      orderType: params.orderType,
      quantity: params.quantity,
      ...(params.price ? { price: params.price } : {}),
      ...(params.timeInForce ? { timeInForce: params.timeInForce } : {}),
      ...(params.postOnly !== undefined ? { postOnly: params.postOnly } : {}),
      ...(params.reduceOnly !== undefined ? { reduceOnly: params.reduceOnly } : {}),
    });
  }

  /** Cancel an order. */
  async cancelOrder(orderId: string, symbol: string): Promise<unknown> {
    return this.privateDelete(`/order?orderId=${orderId}&symbol=${symbol}`);
  }

  /** Get account balances. */
  async getBalances(): Promise<BackpackBalance[]> {
    return this.privateGet<BackpackBalance[]>('/capital');
  }

  /** Get open orders. */
  async getOpenOrders(symbol?: string): Promise<BackpackOrder[]> {
    const params = symbol ? `?symbol=${symbol}` : '';
    return this.privateGet<BackpackOrder[]>(`/orders${params}`);
  }

  /** Get order history. */
  async getOrderHistory(symbol?: string, limit?: number): Promise<BackpackOrder[]> {
    const params = new URLSearchParams();
    if (symbol) params.set('symbol', symbol);
    if (limit) params.set('limit', String(limit));
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.privateGet<BackpackOrder[]>(`/orderHistory${query}`);
  }

  // ─── Internal: signed request helpers ──────────────────────────────

  private async privateGet<T>(path: string): Promise<T> {
    return this.signedRequest<T>('GET', path, undefined);
  }

  private async privatePost<T>(path: string, body: unknown): Promise<T> {
    return this.signedRequest<T>('POST', path, body);
  }

  private async privateDelete<T>(path: string): Promise<T> {
    return this.signedRequest<T>('DELETE', path, undefined);
  }

  /**
   * Make a signed request to Backpack's private API.
   * Uses Ed25519 signing with the API key/secret pair.
   *
   * NOTE: This is a placeholder implementation. Backpack's actual signing
   * scheme requires:
   *   1. Base58-decode the API secret to get the Ed25519 private key
   *   2. Build the signing message: timestamp + instruction + base64(params)
   *   3. Sign with Ed25519
   *   4. Send headers: X-TBX-APIKEY, X-TBX-TIMESTAMP, X-TBX-SIGNATURE, X-TBX-RECV-WINDOW
   *
   * We need @noble/ed25519 or tweetnacl for the signing. Will implement
   * when we have Backpack API credentials to test with.
   */
  private async signedRequest<T>(_method: string, _path: string, _body: unknown): Promise<T> {
    if (!this._apiKey || !this._apiSecret) {
      throw new Error('BackpackClient: private endpoints require apiKey + apiSecret');
    }

    // TODO: implement Ed25519 signing when we have credentials
    // For now, throw with a clear message
    throw new Error(
      'BackpackClient: signed requests not yet implemented — needs Ed25519 signing library + API credentials. ' +
      'Get credentials from backpack.exchange/api-keys'
    );
  }

  // ─── Internal helpers ───────────────────────────────────────────────

  private async publicGet<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${BACKPACK_API}${path}`);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Backpack ${path} ${res.status}: ${errText.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }
}
