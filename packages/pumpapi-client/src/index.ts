/**
 * @edge/pumpapi-client — TypeScript client for PumpApi.io
 *
 * Base URL: https://api.pumpapi.io  (POST for all trade/action/bundle ops)
 *           https://stream.pumpapi.io  (WebSocket — real-time event stream)
 *           https://replay.pumpapi.io  (Historical Replay archives — free)
 *           https://wallet.pumpapi.io  (apiKey generation)
 *
 * Auth:     Two equivalent paths:
 *           (a) privateKey (base58 Solana keypair secret) — Lightning mode
 *               (server signs + broadcasts, fastest)
 *           (b) apiKey (AES-256-encrypted form of privateKey) — Lightning
 *               mode, key not stored in raw form
 *           (c) publicKey only — Local mode (server returns unsigned tx,
 *               client signs and broadcasts)
 *
 * Pricing:  0.25% per trade volume (Lightning mode)
 *           10,000 lamports (0.00001 SOL) per non-trade action
 *           WebSocket stream: FREE
 *           Historical Replay: FREE
 *
 * Atomic execution primitives:
 *   - Actions: combine multiple buy/sell/transfer/create in ONE Solana tx
 *              (limited by 64-CPI cap → ~4-5 swaps/tx). All-or-nothing.
 *   - Jito Bundles: up to 5 transactions bundled atomically with ordered
 *                    execution and no front-run between legs. Min tip 0.0002 SOL.
 *
 * Critical for arb:
 *   - Absolute bounds (maxQuoteAmountIn / minBaseAmountOut) lock in arb
 *     profit regardless of pre-land price drift.
 *   - migrate action lets us initiate Pump.fun → PumpSwap migration and
 *     be first to trade post-migration (first-mover advantage).
 *
 * Risk flags:
 *   - 0.25% × 2 legs = 0.5% round-trip fee burden; only viable for cross-AMM
 *     spreads > 50 bps.
 *   - PumpApi is a 3rd-party wrapper (not affiliated with pump.fun);
 *     single point of failure if pump.fun changes its program.
 *   - Lightning mode requires sending privateKey to server. Use dedicated
 *     trading wallet with limited funds only.
 */

const PUMPAPI_BASE     = 'https://api.pumpapi.io';
const PUMPAPI_WALLET   = 'https://wallet.pumpapi.io';
const PUMPAPI_STREAM   = 'wss://stream.pumpapi.io/';
const PUMPAPI_REPLAY   = 'https://replay.pumpapi.io';

export interface PumpApiClientOptions {
  /** Base58 Solana private key (for Lightning mode). */
  privateKey?: string;
  /** AES-256-encrypted form of privateKey (alternative to privateKey). */
  apiKey?: string;
  /** Base58 Solana public key (for Local mode). */
  publicKey?: string;
  /** Optional fetch implementation (for tests). */
  fetchImpl?: typeof fetch;
  /** Optional partner fee configuration (for SaaS / white-label). */
  partnerAddress?: string;
  partnerFeeRatio?: number;     // 0..1, e.g. 0.001 = 0.1% of trade
  partnerFeeFixed?: number;     // SOL, fixed fee per trade
}

// ─── Trade request ─────────────────────────────────────────────────────

export type PumpAction =
  | 'buy'
  | 'sell'
  | 'transfer'
  | 'create'
  | 'migrate'
  | 'burn'
  | 'claimCashback'
  | 'wrapSol'
  | 'getBalances'
  | 'getTokenInfo';

export interface PumpTradeRequest {
  action: 'buy' | 'sell';
  mint: string;                 // base58 token mint
  quoteMint?: string;           // optional — restrict pool selection
  poolId?: string;              // optional — specific pool
  amount: number | string;      // number, or "55%", or "100%"
  denominatedInQuote?: boolean; // true: amount is in quote token; false: in base
  slippage?: number;            // bps, recommended 20 (=2%)
  priorityFee?: number;         // SOL, auto-split to Jito if >= 0.00023
  jitoTip?: number;             // SOL, min 0.0002
  cuLimit?: number;             // compute unit limit
  /** Atomic arb locks — absolute bounds, slippage-independent */
  maxQuoteAmountIn?: number;
  minBaseAmountOut?: number;
  maxBaseAmountIn?: number;
  minQuoteAmountOut?: number;
  /** Experimental: rebroadcast for up to 10s, returns confirmed:true/false */
  guaranteedDelivery?: boolean;
}

export interface PumpActionRequest {
  action: Exclude<PumpAction, 'buy' | 'sell'>;
  // Common fields per action type — see PumpApi docs for specifics
  mint?: string;
  amount?: number | string;
  toAddress?: string;           // for transfer
  // ... action-specific fields
  [key: string]: unknown;
}

export interface PumpActionsRequest {
  actions: Array<PumpTradeRequest | PumpActionRequest>;
  priorityFee?: number;
  jitoTip?: number;
}

export interface PumpJitoBundleRequest {
  transactions: Array<{
    action: PumpAction;
    [key: string]: unknown;
  }>;
  jitoTip: number;              // SOL, min 0.0002
}

// ─── Response types ────────────────────────────────────────────────────

export interface PumpTxResponse {
  signature: string;            // Solana tx signature
  confirmed?: boolean;          // for guaranteedDelivery
  slot?: number;
  error?: string;
  // Lightning mode extras
  migratedPool?: string;        // for migrate action
  poolName?: string;
}

export interface PumpBundleResponse {
  signatures: string[];         // one per tx in the bundle
  confirmed?: boolean;
  slot?: number;
  error?: string;
}

export interface PumpTokenInfo {
  mint: string;
  price: number;                // SOL per token
  priceUsd?: number;
  supply: number;
  poolName: string;
  decimals: number;
  burnedLiquidity: number;      // 0..1
  vTokensInBondingCurve?: number;
  vQuoteInBondingCurve?: number;
  reserves?: { base: number; quote: number };
}

export interface PumpBalanceEntry {
  mint: string;
  amount: number;
  decimals: number;
  uiAmount: number;
  symbol?: string;
}

export interface PumpBalancesResponse {
  sol: number;                  // lamports
  tokens: PumpBalanceEntry[];
}

// ─── Stream event types (WebSocket) ────────────────────────────────────

export type PumpStreamEventType =
  | 'trade'
  | 'transfer'
  | 'create'
  | 'migrate'
  | 'lpChange'
  | 'creatorFeeClaim'
  | 'poolCreation';

export interface PumpStreamEvent {
  type: PumpStreamEventType;
  ts: number;                   // epoch ms
  signature: string;
  pool?: string;
  poolName?: string;
  amm?: 'pump.fun' | 'pumpswap' | 'raydium-cpmm' | 'raydium-launchpad' | 'meteora-damm-v1' | 'meteora-damm-v2' | 'meteora-dlmm' | 'meteora-launchpad';
  mint?: string;
  // ... type-specific fields
  [key: string]: unknown;
}

// ─── Client ────────────────────────────────────────────────────────────

export class PumpApiClient {
  private readonly privateKey?: string;
  private readonly apiKey?: string;
  private readonly publicKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly partnerAddress?: string;
  private readonly partnerFeeRatio?: number;
  private readonly partnerFeeFixed?: number;

  constructor(opts: PumpApiClientOptions = {}) {
    this.privateKey = opts.privateKey;
    this.apiKey     = opts.apiKey;
    this.publicKey  = opts.publicKey;
    this.fetchImpl  = opts.fetchImpl ?? fetch;
    this.partnerAddress   = opts.partnerAddress;
    this.partnerFeeRatio  = opts.partnerFeeRatio;
    this.partnerFeeFixed  = opts.partnerFeeFixed;

    if (!this.privateKey && !this.apiKey && !this.publicKey) {
      throw new Error('PumpApiClient: at least one of privateKey / apiKey / publicKey required');
    }
  }

  /** Returns true if Lightning mode (server signs) is available. */
  get isLightning(): boolean {
    return !!(this.privateKey || this.apiKey);
  }

  private authBody(): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (this.privateKey) body.privateKey = this.privateKey;
    if (this.apiKey)     body.apiKey     = this.apiKey;
    if (this.publicKey)  body.publicKey  = this.publicKey;
    if (this.partnerAddress) {
      body.partnerAddress    = this.partnerAddress;
      body.partnerFeeRatio   = this.partnerFeeRatio;
      body.partnerFeeFixed   = this.partnerFeeFixed;
    }
    return body;
  }

  private async post<T>(body: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(PUMPAPI_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...this.authBody(), ...body }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`PumpApi ${body.action ?? 'unknown'} ${res.status}: ${errText.slice(0, 300)}`);
    }
    return res.json() as Promise<T>;
  }

  // ─── Trade API ───────────────────────────────────────────────────────

  async buy(req: PumpTradeRequest): Promise<PumpTxResponse> {
    const { action: _omit, ...rest } = req;
    return this.post<PumpTxResponse>({ action: 'buy' as const, ...rest });
  }

  async sell(req: PumpTradeRequest): Promise<PumpTxResponse> {
    const { action: _omit, ...rest } = req;
    return this.post<PumpTxResponse>({ action: 'sell' as const, ...rest });
  }

  /** Atomic multi-leg: pack buy+sell+transfer in one Solana tx (≤4-5 swaps). */
  async actions(req: PumpActionsRequest): Promise<PumpTxResponse> {
    return this.post<PumpTxResponse>({ actions: req.actions, priorityFee: req.priorityFee, jitoTip: req.jitoTip });
  }

  /** Atomic 5-tx bundle via Jito (ordered, no front-run between legs). */
  async jitoBundle(req: PumpJitoBundleRequest): Promise<PumpBundleResponse> {
    return this.post<PumpBundleResponse>({ transactions: req.transactions, jitoTip: req.jitoTip });
  }

  // ─── Non-trade actions ───────────────────────────────────────────────

  async migrate(mint: string): Promise<PumpTxResponse> {
    return this.post<PumpTxResponse>({ action: 'migrate', mint });
  }

  async burn(mint: string): Promise<PumpTxResponse> {
    return this.post<PumpTxResponse>({ action: 'burn', mint });
  }

  async claimCashback(): Promise<PumpTxResponse> {
    return this.post<PumpTxResponse>({ action: 'claimCashback' });
  }

  async wrapSol(amount: number): Promise<PumpTxResponse> {
    return this.post<PumpTxResponse>({ action: 'wrapSol', amount });
  }

  async transfer(mint: string, toAddress: string, amount: number | string): Promise<PumpTxResponse> {
    return this.post<PumpTxResponse>({ action: 'transfer', mint, toAddress, amount });
  }

  // ─── Read-only (no signing, can be called with publicKey only) ───────

  async getBalances(): Promise<PumpBalancesResponse> {
    return this.post<PumpBalancesResponse>({ action: 'getBalances' });
  }

  async getTokenInfo(mint: string): Promise<PumpTokenInfo> {
    return this.post<PumpTokenInfo>({ action: 'getTokenInfo', mint });
  }

  // ─── 2-leg atomic arb helper ─────────────────────────────────────────

  /**
   * Atomic 2-leg arbitrage: buy on one AMM, sell on another, in a single
   * Solana transaction. All-or-nothing.
   *
   * @param mint          Token mint
   * @param buyPool       Pool to buy from (e.g. { amm: 'pump.fun', poolId: '...' })
   * @param sellPool      Pool to sell to (e.g. { amm: 'meteora-dlmm', poolId: '...' })
   * @param quoteAmountIn SOL to spend
   * @param minBaseOut    Min tokens to receive from buy leg
   * @param minQuoteOut   Min SOL to receive from sell leg (locks in profit)
   */
  async atomicTwoLegArb(params: {
    mint: string;
    buyPool: { amm?: string; poolId?: string };
    sellPool: { amm?: string; poolId?: string };
    quoteAmountIn: number;
    minBaseOut: number;
    minQuoteOut: number;
    priorityFee?: number;
    jitoTip?: number;
  }): Promise<PumpTxResponse> {
    if (!this.isLightning) {
      throw new Error('atomicTwoLegArb requires Lightning mode (privateKey or apiKey)');
    }
    return this.actions({
      actions: [
        {
          action: 'buy' as const,
          mint: params.mint,
          amount: params.quoteAmountIn,
          denominatedInQuote: true,
          poolId: params.buyPool.poolId,
          minBaseAmountOut: params.minBaseOut,
          slippage: 50,                  // 5% — high because absolute bound is the real lock
          priorityFee: params.priorityFee ?? 0.00023,
        },
        {
          action: 'sell' as const,
          mint: params.mint,
          amount: '100%',                // sell everything bought
          poolId: params.sellPool.poolId,
          minQuoteAmountOut: params.minQuoteOut,   // LOCKS IN PROFIT
          slippage: 50,
          priorityFee: params.priorityFee ?? 0.00023,
        },
      ],
      priorityFee: params.priorityFee,
      jitoTip: params.jitoTip ?? 0.0002,
    });
  }
}

// ─── WebSocket stream client ───────────────────────────────────────────

export interface PumpStreamClientOptions {
  /** Called for each event. */
  onEvent: (event: PumpStreamEvent) => void;
  /** Called when the stream connects. */
  onConnect?: () => void;
  /** Called when the stream disconnects. */
  onDisconnect?: (err?: Error) => void;
  /** Auto-reconnect on disconnect (default: true). */
  autoReconnect?: boolean;
  /** Reconnect backoff base (default: 1000ms). */
  reconnectBaseMs?: number;
  /** Reconnect backoff cap (default: 30000ms). */
  reconnectCapMs?: number;
}

/**
 * Real-time WebSocket stream of all events across all PumpApi-supported pools
 * + native SOL/SPL transfers. ~300-400 events/sec.
 *
 * NOTE: PumpApi limits to 1 connection per IP. For multi-process fanout,
 * use a ZeroMQ PUB/SUB relay pattern (see PumpApi FAQ).
 */
export class PumpStreamClient {
  private ws?: WebSocket;
  private reconnectAttempt = 0;
  private closed = false;

  constructor(private opts: PumpStreamClientOptions) {}

  async connect(): Promise<void> {
    this.closed = false;
    this.ws = new WebSocket(PUMPAPI_STREAM);
    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.opts.onConnect?.();
    };
    this.ws.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data as string) as PumpStreamEvent;
        this.opts.onEvent(event);
      } catch (err) {
        console.warn('PumpStreamClient: failed to parse event:', err);
      }
    };
    this.ws.onclose = () => {
      this.opts.onDisconnect?.();
      if (!this.closed && (this.opts.autoReconnect ?? true)) {
        this.scheduleReconnect();
      }
    };
    this.ws.onerror = (err) => {
      this.opts.onDisconnect?.(new Error(String(err)));
    };
  }

  private scheduleReconnect(): void {
    const base = this.opts.reconnectBaseMs ?? 1000;
    const cap  = this.opts.reconnectCapMs  ?? 30_000;
    const delay = Math.min(cap, base * 2 ** this.reconnectAttempt);
    this.reconnectAttempt++;
    setTimeout(() => { if (!this.closed) this.connect(); }, delay);
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}

// ─── Historical Replay archives ─────────────────────────────────────────

/**
 * Fetch the URL for a PumpApi Historical Replay archive.
 * Archives are organized as YYYY/MM/DD/HH.jsonl.zst and are FREE.
 * Data starts April 18, 2026.
 *
 * Example: getReplayUrl(new Date('2026-09-25T13:00:00Z'))
 *          → https://replay.pumpapi.io/2026/09/25/13.jsonl.zst
 *
 * The .zst file is ~400MB compressed, ~2GB decompressed.
 * Decompress with `zstd -d file.jsonl.zst` or @redis/bloom.
 */
export function getReplayUrl(timestamp: Date): string {
  const yyyy = timestamp.getUTCFullYear();
  const mm   = String(timestamp.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(timestamp.getUTCDate()).padStart(2, '0');
  const hh   = String(timestamp.getUTCHours()).padStart(2, '0');
  return `${PUMPAPI_REPLAY}/${yyyy}/${mm}/${dd}/${hh}.jsonl.zst`;
}

/** Fetch the list of available replay hours (browseable directory). */
export async function listReplayArchives(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(PUMPAPI_REPLAY);
  if (!res.ok) throw new Error(`listReplayArchives ${res.status}`);
  const html = await res.text();
  // Parse directory listing — extract all .jsonl.zst links
  const urls: string[] = [];
  const regex = /href="([^"]+\.jsonl\.zst)"/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    urls.push(new URL(match[1], PUMPAPI_REPLAY).toString());
  }
  return urls;
}

// ─── Wallet API — generate new wallet or apiKey from privateKey ─────────

export interface PumpWalletGenerateResponse {
  publicKey: string;
  apiKey?: string;              // only returned if generateApiKey=true
  privateKey?: string;          // only returned for new wallet generation
}

export async function generatePumpWallet(opts: {
  generateApiKey?: boolean;
  existingPrivateKey?: string;  // if set, derive apiKey from existing key
  fetchImpl?: typeof fetch;
} = {}): Promise<PumpWalletGenerateResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    generateApiKey: opts.generateApiKey ?? false,
  };
  if (opts.existingPrivateKey) body.privateKey = opts.existingPrivateKey;

  const res = await fetchImpl(PUMPAPI_WALLET, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`PumpApi wallet ${res.status}: ${errText.slice(0, 200)}`);
  }
  return res.json() as Promise<PumpWalletGenerateResponse>;
}
