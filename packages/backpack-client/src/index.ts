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

  // ─── Private endpoints (require auth — TODO: implement HMAC signing) ─

  // async placeOrder(params: { ... }): Promise<Order> {
  //   // Requires HMAC-SHA256 signed request with API key + secret
  //   // TODO: implement when we have Backpack API credentials
  // }

  // async getBalances(): Promise<Balance[]> {
  //   // TODO: implement when we have Backpack API credentials
  // }

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
