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
export interface BackpackClientOptions {
    apiKey?: string;
    apiSecret?: string;
    fetchImpl?: typeof fetch;
}
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
    asks: [string, string][];
    bids: [string, string][];
    lastUpdateId: number;
}
export interface BackpackMarket {
    symbol: string;
    status: string;
    baseAsset?: string;
    quoteAsset?: string;
    marketType: string;
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
    fills?: Array<{
        price: string;
        quantity: string;
        fee: string;
    }>;
}
export interface BackpackBalance {
    asset: string;
    available: string;
    total: string;
    locked: string;
}
export declare class BackpackClient {
    /** @internal — will be used when private endpoints are implemented */
    private readonly _apiKey?;
    /** @internal — will be used when private endpoints are implemented */
    private readonly _apiSecret?;
    private readonly fetchImpl;
    constructor(opts?: BackpackClientOptions);
    /** Get all markets. */
    getMarkets(): Promise<BackpackMarket[]>;
    /** Get ticker for a symbol. */
    getTicker(symbol: string): Promise<BackpackTicker>;
    /** Get order book depth. */
    getDepth(symbol: string, limit?: number): Promise<BackpackDepth>;
    /** Get all tokenized equity markets (spot + perp). */
    getTokenizedEquityMarkets(): Promise<BackpackMarket[]>;
    /** Get spot-perp basis for a tokenized equity. */
    getBasis(symbol: string): Promise<{
        symbol: string;
        spotPrice?: number;
        perpPrice?: number;
        basisPct: number;
    }>;
    /** Get basis for all tokenized equities at once. */
    getAllBases(): Promise<Array<{
        symbol: string;
        spotPrice?: number;
        perpPrice?: number;
        basisPct: number;
    }>>;
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
    placeOrder(params: {
        symbol: string;
        side: 'Bid' | 'Ask';
        orderType: 'Limit' | 'Market';
        quantity: string;
        price?: string;
        timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'PO';
        postOnly?: boolean;
        reduceOnly?: boolean;
    }): Promise<BackpackOrder>;
    /** Cancel an order. */
    cancelOrder(orderId: string, symbol: string): Promise<unknown>;
    /** Get account balances. */
    getBalances(): Promise<BackpackBalance[]>;
    /** Get open orders. */
    getOpenOrders(symbol?: string): Promise<BackpackOrder[]>;
    /** Get order history. */
    getOrderHistory(symbol?: string, limit?: number): Promise<BackpackOrder[]>;
    private privateGet;
    private privatePost;
    private privateDelete;
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
    private signedRequest;
    private publicGet;
}
//# sourceMappingURL=index.d.ts.map