/**
 * @edge/types — Core domain types shared across all edge-engine packages.
 *
 * Everything that crosses package boundaries is defined here.  Keep this
 * file dependency-free so it can be imported by both browser and node code.
 */

// ─── Chains & venues ────────────────────────────────────────────────────

export type ChainId =
  | 'ethereum'
  | 'arbitrum'
  | 'base'
  | 'optimism'
  | 'polygon'
  | 'bsc'
  | 'zksync'
  | 'solana';

export type VenueType = 'cex' | 'dex' | 'perp-dex' | 'prediction' | 'sportsbook';

export interface Venue {
  id: string;                  // 'hyperliquid' | 'binance' | 'uniswap-v3' | ...
  name: string;
  type: VenueType;
  chains: ChainId[];           // ['arbitrum', 'ethereum'] for multi-chain DEXs
  url: string;
  apiDocs?: string;
  feeBps?: number;             // taker fee in bps, if known
  settlement?: 'on-chain' | 'custodial' | 'usdc' | 'usdt';
}

// ─── Data sources ───────────────────────────────────────────────────────

export type DataSourceKind =
  | 'evm-block'
  | 'evm-mempool'
  | 'solana-laserstream'
  | 'cex-ws-book'
  | 'cex-rest-ticker'
  | 'funding-rate-rest'
  | 'prediction-rest'
  | 'sportsbook-rest'
  | 'sharpe-rest'
  | 'vooi-rest';

export interface DataSource {
  id: string;                  // 'helius-laserstream' | 'hyperliquid-ws' | ...
  kind: DataSourceKind;
  venue?: string;
  chain?: ChainId;
  subscribe(): Promise<void>;
  unsubscribe(): Promise<void>;
  readonly isLive: boolean;
}

export interface DataPoint {
  source: string;              // data source id
  ts: number;                  // epoch ms
  kind: 'price' | 'funding' | 'book' | 'pool-state' | 'listing' | 'line' | 'resolution-rule' | 'large-swap';
  venue?: string;
  chain?: ChainId;
  symbol?: string;             // 'BTC/USDT' | 'ETH' | 'wstETH' | ...
  payload: unknown;
}

// ─── Strategies & opportunities ─────────────────────────────────────────

export type LandscapeId =
  | 'A_dex_cex'
  | 'B_cex_cex'
  | 'C_dex_dex'
  | 'D_prediction'
  | 'E_sports'
  | 'F_perps_funding'
  | 'G_mev';

export type OpportunityStatus =
  | 'live'        // firing right now
  | 'building'    // system under construction
  | 'research';   // edge confirmed, execution path being designed

export interface Opportunity {
  id: string;                  // stable hash of (strategy, legs, ts)
  strategyId: string;
  landscape: LandscapeId;
  ts: number;
  legs: TradeLeg[];
  expectedEdgePct: number;     // gross edge %
  expectedNetUsd: number;      // after fees, gas, slippage
  capitalRequiredUsd: number;
  capitalLockHours: number;    // 0 for atomic
  status: OpportunityStatus;
  expiresAt?: number;          // when opportunity stops being valid
  notes?: string;
}

export interface TradeLeg {
  venue: string;
  chain?: ChainId;
  symbol: string;
  side: 'buy' | 'sell' | 'long' | 'short';
  sizeUsd: number;
  sizeNative?: number;
  priceRef?: number;
  type: 'spot' | 'perp' | 'prediction-yes' | 'prediction-no' | 'sports-bet' | 'amm-swap' | 'flashloan-borrow' | 'flashloan-repay';
  params?: Record<string, unknown>;
}

export interface TradeOrder extends Opportunity {
  sizedLegs: SizedLeg[];
  simulatorResult: SimulatorResult;
  riskApproved: boolean;
}

export interface SizedLeg extends TradeLeg {
  quoteOutNative: number;       // expected output from venue quote
  quoteOutUsd: number;
  minOutNative: number;         // minOut for slippage tolerance
  gasEstimateUsd?: number;
  flashloanFeeUsd?: number;
}

export interface SimulatorResult {
  grossUsd: number;
  gasUsd: number;
  flashloanFeeUsd: number;
  slippageUsd: number;
  netProfitUsd: number;
  netProfitPct: number;
  apr: number;                  // annualised return on capital
  confidence: number;           // 0..1, simulator confidence in numbers
}

// ─── Strategy interface ─────────────────────────────────────────────────

export interface Strategy {
  id: string;
  landscape: LandscapeId;
  subscribesTo(): string[];              // data source ids
  evaluate(data: DataPoint): TradeOrder[] | null;
  riskParams(): RiskParams;
}

export interface RiskParams {
  minProfitUsd: number;
  maxSizeUsd: number;
  maxConcurrent: number;
  cooldownMs: number;
  gasPriceCapMultiplier: number;         // × chain median
}

// ─── Risk & PnL ─────────────────────────────────────────────────────────

export interface RiskEnvelope {
  maxDailyLossUsd: number;
  maxPerTradeLossUsd: number;
  maxConcurrentArbs: number;
  gasPriceCapMultiplier: number;
  cooldownAfterLossMs: number;
  leverageCap: number;
}

export interface PnlEntry {
  id: string;
  ts: number;
  strategyId: string;
  opportunityId: string;
  legs: TradeLeg[];
  realizedUsd: number;          // negative for loss
  gasUsd: number;
  feesUsd: number;
  status: 'open' | 'filled' | 'reverted' | 'closed' | 'failed';
  txHashes?: string[];
  notes?: string;
}

export type AlertSeverity = 'info' | 'opportunity' | 'warning' | 'critical' | 'kill-switch';

export interface Alert {
  id: string;
  ts: number;
  severity: AlertSeverity;
  strategyId?: string;
  opportunityId?: string;
  title: string;
  body: string;
  channels: ('telegram' | 'email' | 'sms')[];
}

// ─── Config shape ───────────────────────────────────────────────────────

export interface ChainConfig {
  chainId: ChainId;
  rpcHttp: string;
  rpcWs?: string;
  explorer: string;
  flashloanProvider?: 'aave-v3' | 'spark' | 'morpho';
  nativeTokenSymbol: string;     // 'ETH' | 'BNB' | 'MATIC' | 'SOL'
  gasEstimateUsd?: number;
}

export interface AppConfig {
  chains: Record<ChainId, ChainConfig>;
  venues: Record<string, Venue>;
  strategies: Record<string, Record<string, unknown>>;
  risk: RiskEnvelope;
  alerts: {
    telegram: {
      botToken: string;
      chatId: string;
    };
    email?: { smtpUrl: string; toAddr: string };
  };
  apis: {
    helius?: { apiKey: string };
    alchemy?: { apiKey: string };
    sharpe?: { apiKey?: string };
    vooi?: { apiToken?: string };
    coinglass?: { apiKey?: string };
    oddsshopper?: { apiKey?: string };
    polymarket?: { walletPrivateKey?: string };
  };
  capital: {
    workingCapitalUsd: number;
    allocationByLandscape: Record<LandscapeId, number>;
  };
}
