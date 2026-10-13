/**
 * buildStrategyConfigs — pure configuration builder.
 *
 * Takes the loaded AppConfig (from @edge/config) and returns a typed object
 * containing the constructor parameters for every strategy instantiated by
 * all-runner.ts. This function is PURE: no side effects, no client creation,
 * no network access. Every strategy's thresholds flow through here so the
 * mapping can be unit-tested without starting the trading system.
 *
 * UNIT CONVENTIONS (enforced here, documented per strategy):
 *
 *   - "pct"   = percent value (e.g. 0.5 = 0.5%)
 *   - "apr"   = APR in percent (e.g. 5.0 = 5% APR)
 *   - "bps"   = basis points (1 bps = 0.01%, so 50 bps = 0.5%)
 *   - bps → pct conversion: divide by 100 (50 bps → 0.5 pct)
 *
 * CORRECTIONS vs. the baseline (commit 0545aaa):
 *
 *   1. lst_yield_comparison: previously passed max_position_usd into
 *      minTvlUsd. Now reads a dedicated min_tvl_usd key. The strategy
 *      has no maxSizeUsd param, so max_position_usd is documented as
 *      unused for this section.
 *
 *   2. dex_cex_flashloan: previously used use_flashbots to control
 *      useBalancer (unrelated concepts — Flashbots is MEV protection,
 *      Balancer is a flashloan provider). Now reads dedicated
 *      use_balancer and use_aave_fallback keys. flashloan_provider is
 *      informational only.
 *
 *   3. solana_memecoin_arb: previously used an unexplained /100/10
 *      factor that produced 0.05 pct (5 bps) — below the 50 bps
 *      round-trip fee burden. Now uses /100 (standard bps→pct) and
 *      the TOML default is raised to 80 bps (0.8 pct) to clear fees
 *      with a 0.3% profit margin.
 *
 *   4. pendle_boros: previously read min_yield_pct (ambiguous name).
 *      Now reads min_spread_apr_pct (clear: APR spread in percent).
 *
 * IGNORED CONFIG (documented, not fixed in this sprint):
 *
 *   - max_concurrent, cooldown_ms, gas_price_cap_mult: these are
 *     RiskParams fields, not strategy-constructor params. Each
 *     strategy hardcodes its own riskParams(). Wiring these through
 *     would require changing every strategy's riskParams() method.
 *     Tracked as engineering debt in docs/CONFIG_AUDIT.md.
 *
 *   - max_position_usd for strategies whose constructor has no
 *     maxSizeUsd param (lst_yield, hlp_yield, tokenized_equity): the
 *     value is parsed but not consumed. See docs/CONFIG_AUDIT.md.
 *
 *   - dex_dex, mev_backrun, cross_dex_arb, precompile_flashloan_arb:
 *     sections exist in TOML but no strategy is instantiated in
 *     all-runner.ts. Not in scope for this sprint.
 */

import type { AppConfig } from '@edge/types';

// ─── Helpers ────────────────────────────────────────────────────────
type Section = Record<string, unknown>;

function section(cfg: AppConfig, name: string): Section {
  return cfg.strategies[name] ?? {};
}
function num(s: Section, k: string, fallback: number): number {
  const v = s[k];
  return typeof v === 'number' && isFinite(v) ? v : fallback;
}
function str(s: Section, k: string, fallback: string): string {
  const v = s[k];
  return typeof v === 'string' ? v : fallback;
}
function bool(s: Section, k: string, fallback: boolean): boolean {
  const v = s[k];
  return typeof v === 'boolean' ? v : fallback;
}
function strArr(s: Section, k: string, fallback: string[]): string[] {
  return Array.isArray(s[k]) ? (s[k] as string[]) : fallback;
}

// ─── Structural constants (not in TOML) ─────────────────────────────
export const CEX_VENUES = ['binance', 'okx', 'bybit', 'mexc', 'gate'];
export const DEX_VENUES = ['uniswap-v3', 'aerodrome', 'camelot', 'sushiswap'];
export const FLASHLOAN_CHAINS = ['arbitrum', 'base', 'optimism', 'polygon', 'ethereum'];
export const VOOI_VENUE_SET = [
  'hyperliquid', 'lighter', 'aster', 'extended', 'trade.xyz',
  'kinetiq', 'robinhood', 'ondo', 'binance', 'bybit', 'mexc', 'gate',
];

// ─── Per-strategy param types ───────────────────────────────────────
// These mirror the constructor param interfaces of each strategy class.
// Duplicated here so the config builder can be tested without importing
// the strategy classes (which pull in heavy SDK dependencies).

export interface PerpFundingConfig {
  minSpreadApr: number;
  longVenues: string[];
  shortVenues: string[];
  useVooiExecutor: boolean;
  vooiVenueSet: string[];
}
export interface CexHlFundingConfig {
  minNetApr: number;
  cexVenues: string[];
  hlVenueName: string;
  useVooiExecutor: boolean;
  vooiVenueSet: string[];
  autoExecute: boolean;
  maxNotionalUsd: number;
  minHlFundingApr: number;
}
export interface DexCexFlashloanConfig {
  minGrossSpreadPct: number;
  maxSizeUsd: number;
  cexVenues: string[];
  dexVenues: string[];
  flashloanChains: string[];
  useBalancer: boolean;
  useAaveFallback: boolean;
}
export interface SolanaArbConfig {
  minSpreadPct: number;
  maxSizeUsd: number;
  minBurnedLiquidity: number;
  minBondingCurveDepthSol: number;
  watchlistMints: string[];
}
export interface PredictionArbConfig {
  minDivergencePct: number;
  maxSizeUsd: number;
  maxCapitalLockDays: number;
  platforms: string[];
}
export interface SportsArbConfig {
  minArbPct: number;
  maxSizeUsd: number;
  sports: string[];
  regions: string[];
  oddsFormat: 'decimal' | 'american';
  bookmakers: string[];
}
export interface PendleBorosConfig {
  minSpreadApr: number;
  maxSizeUsd: number;
  minNotionalOI: number;
  platforms: string[];
  minVolume24h: number;
  minDaysToMaturity: number;
  minSpreadPersistence: number;
}
export interface TokenizedEquityConfig {
  minActionableSpreadPct: number;
  minActionableDepthUsd: number;
  markets: string[];
}
export interface CexLikeDexConfig {
  minPriceSpreadPct: number;
  maxSizeUsd: number;
  minOpenInterest: number;
  minVolume24h: number;
  venues: string[];
  minSpreadPersistence: number;
}
export interface HlAmmConfig {
  minSpreadPct: number;
  minPoolLiquidityUsd: number;
  maxSizeUsd: number;
}
export interface HlLstConfig {
  minDiscountPct: number;
  maxSizeUsd: number;
  preferredFeeTier: number;
}
export interface GoldArbConfig {
  minSpreadPct: number;
  maxSizeUsd: number;
}
export interface EquityPerpConfig {
  minSpreadPct: number;
  maxSizeUsd: number;
}
export interface LstYieldConfig {
  minYieldSpreadPct: number;
  minTvlUsd: number;
}
export interface PtKhypeConfig {
  minYieldSpreadPct: number;
  khypeFloatingYieldApr: number;
  maxSizeUsd: number;
}
export interface PtYieldConfig {
  minYieldSpreadPct: number;
  minTvlUsd: number;
  maxImpliedApyPct: number;
  khypeFloatingYieldApr: number;
}
export interface EulerLendingConfig {
  minSpreadPct: number;
  minLiquidityUsd: number;
  maxSizeUsd: number;
}
export interface HlSpotBasisConfig {
  minBasisPct: number;
  minVolume24h: number;
  perpNameMapping: Record<string, string>;
}
export interface HlpYieldConfig {
  minEntryAprPct: number;
  warningAprPct: number;
  timeframe: 'day' | 'week' | 'month';
}
export interface DefiLlamaConfig {
  minApyPct: number;
  minTvlUsd: number;
  stablecoinOnly: boolean;
  noIlRiskOnly: boolean;
  maxResults: number;
}
export interface RwaTreasuryConfig {
  minTvlUsd: number;
  includeInstitutionalCredit: boolean;
}
export interface StablecoinDepegConfig {
  minDepegPct: number;
  majorDepegPct: number;
}
export interface LiquidationBackrunConfig {
  cascadeFundingThreshold: number;
  squeezeFundingThreshold: number;
  minOiUsd: number;
}
export interface OrderbookImbalanceConfig {
  coins: string[];
  imbalanceThreshold: number;
  wallThresholdUsd: number;
  liquidityRangePct: number;
}
export interface FundingDivergenceConfig {
  minDivergencePct: number;
  minExtremeOiUsd: number;
  extremeFundingThreshold: number;
}
export interface AirdropFarmingConfig {
  minTotalReturnPct: number;
}
export interface LeverageLoopConfig {
  minSpreadPct: number;
  maxLeverage: number;
}
export interface WhaleSignalConfig {
  minVolOiRatio: number;
  minTvlChangePct: number;
  minProtocolTvl: number;
}
export interface CexDexBridgeConfig {
  minSpreadPct: number;
  coins: string[];
}

export interface StrategyConfigs {
  perpFunding: PerpFundingConfig;
  cexHlArb: CexHlFundingConfig;
  dexCexFlashloan: DexCexFlashloanConfig;
  solanaArb: SolanaArbConfig;
  predictionArb: PredictionArbConfig;
  sportsArb: SportsArbConfig;
  pendleBoros: PendleBorosConfig;
  tokenizedEquity: TokenizedEquityConfig;
  cexLikeDexArb: CexLikeDexConfig;
  hlAmmArb: HlAmmConfig;
  hlLstArb: HlLstConfig;
  goldArb: GoldArbConfig;
  equityPerpCrossVenue: EquityPerpConfig;
  lstYield: LstYieldConfig;
  ptKhypeArb: PtKhypeConfig;
  ptYieldArb: PtYieldConfig;
  eulerLendingArb: EulerLendingConfig;
  hlSpotBasis: HlSpotBasisConfig;
  hlpYield: HlpYieldConfig;
  defiLlamaYield: DefiLlamaConfig;
  rwaTreasury: RwaTreasuryConfig;
  stablecoinDepeg: StablecoinDepegConfig;
  liquidationBackrun: LiquidationBackrunConfig;
  orderbookImbalance: OrderbookImbalanceConfig;
  fundingDivergence: FundingDivergenceConfig;
  airdropFarming: AirdropFarmingConfig;
  leverageLoop: LeverageLoopConfig;
  whaleSignal: WhaleSignalConfig;
  cexDexBridge: CexDexBridgeConfig;
}

// ─── The builder ────────────────────────────────────────────────────
/**
 * Build all strategy constructor params from the loaded AppConfig.
 *
 * Every call to `num()`, `str()`, `bool()`, `strArr()` includes a fallback
 * that matches the pre-refactor hardcoded value, so behavior is preserved
 * when a TOML key is missing. Deliberate corrections (see module docstring)
 * are called out in inline comments.
 */
export function buildStrategyConfigs(cfg: AppConfig): StrategyConfigs {
  const vooiAvailable = !!cfg.apis.vooi?.apiToken;

  return {
    // ── 1. Perp funding ────────────────────────────────────────────
    perpFunding: (() => {
      const s = section(cfg, 'perp_funding');
      return {
        minSpreadApr: num(s, 'min_spread_apr', 0.08),
        longVenues: strArr(s, 'long_venues', ['pacifica', 'paradex', ...CEX_VENUES, 'hyperliquid']),
        shortVenues: strArr(s, 'short_venues', ['hyperliquid', 'dydx', ...CEX_VENUES]),
        useVooiExecutor: bool(s, 'use_vooi_executor', vooiAvailable),
        vooiVenueSet: VOOI_VENUE_SET,
      };
    })(),

    // ── 2. CEX-HL funding arb ──────────────────────────────────────
    cexHlArb: (() => {
      const s = section(cfg, 'cex_hl_funding_arb');
      return {
        minNetApr: num(s, 'min_spread_apr', 0.05),
        cexVenues: CEX_VENUES,
        hlVenueName: 'Hyperliquid',
        useVooiExecutor: vooiAvailable,
        vooiVenueSet: VOOI_VENUE_SET,
        autoExecute: false,
        maxNotionalUsd: num(s, 'max_position_usd', 5000),
        minHlFundingApr: 0.02,
      };
    })(),

    // ── 3. DEX-CEX flashloan ───────────────────────────────────────
    // CORRECTION: use_flashbots no longer controls useBalancer.
    // flashloan_provider is informational (the booleans drive behavior).
    dexCexFlashloan: (() => {
      const s = section(cfg, 'dex_cex_flashloan');
      return {
        minGrossSpreadPct: num(s, 'min_edge_bps', 30) / 100,  // bps → pct
        maxSizeUsd: num(s, 'max_position_usd', 50_000),
        cexVenues: CEX_VENUES,
        dexVenues: DEX_VENUES,
        flashloanChains: strArr(s, 'chains_active', FLASHLOAN_CHAINS),
        useBalancer: bool(s, 'use_balancer', true),
        useAaveFallback: bool(s, 'use_aave_fallback', true),
      };
    })(),

    // ── 4. Solana memecoin arb ────────────────────────────────────
    // CORRECTION: minSpreadPct is in PERCENT units (the strategy computes
    // spreadPct = (sell-buy)/buy × 100). The round-trip fee burden is
    // 0.5% (50 bps: 0.25% × 2 legs). The TOML default is 80 bps = 0.8%,
    // giving a 0.3% profit margin above fees. The old /100/10 factor
    // produced 0.05 pct (5 bps) — below break-even — and is removed.
    solanaArb: (() => {
      const s = section(cfg, 'solana_memecoin_arb');
      return {
        minSpreadPct: num(s, 'min_edge_bps', 80) / 100,  // bps → pct (80 bps = 0.8%)
        maxSizeUsd: num(s, 'max_position_usd', 200),
        minBurnedLiquidity: 0.5,
        minBondingCurveDepthSol: 10,
        watchlistMints: [],
      };
    })(),

    // ── 5. Prediction market arb ──────────────────────────────────
    predictionArb: (() => {
      const s = section(cfg, 'prediction_arb');
      return {
        minDivergencePct: num(s, 'min_divergence_pct', 3.0),
        maxSizeUsd: num(s, 'max_position_usd', 2000),
        maxCapitalLockDays: num(s, 'capital_lock_days_max', 30),
        platforms: ['polymarket'],
      };
    })(),

    // ── 6. Sportsbook arb ─────────────────────────────────────────
    sportsArb: (() => {
      const s = section(cfg, 'sports_arb');
      const fmt = str(s, 'odds_format', 'decimal');
      return {
        minArbPct: num(s, 'min_edge_pct', 1.0),
        maxSizeUsd: num(s, 'max_position_usd', 500),
        sports: ['americanfootball_nfl', 'basketball_nba', 'soccer_epl'],
        regions: ['us', 'uk', 'eu'],
        oddsFormat: (fmt === 'american' ? 'american' : 'decimal') as 'decimal' | 'american',
        bookmakers: [],
      };
    })(),

    // ── 7. Pendle Boros ───────────────────────────────────────────
    // CORRECTION: renamed from min_yield_pct to min_spread_apr_pct.
    // Unit: percent APR (5 = 5% APR spread). The strategy's minSpreadApr
    // is documented as "APR difference" in percent.
    pendleBoros: (() => {
      const s = section(cfg, 'pendle_boros');
      return {
        minSpreadApr: num(s, 'min_spread_apr_pct', 0.5),
        maxSizeUsd: num(s, 'max_position_usd', 5000),
        minNotionalOI: 50_000,
        platforms: [],
        minVolume24h: 100_000,
        minDaysToMaturity: 7,
        minSpreadPersistence: 2,
      };
    })(),

    // ── 8. Tokenized equity ───────────────────────────────────────
    tokenizedEquity: (() => {
      const s = section(cfg, 'tokenized_equity');
      return {
        minActionableSpreadPct: num(s, 'min_spread_pct', 2.0),
        minActionableDepthUsd: 500,
        markets: ['SPCX.US_USDC', 'SNDK.US_USDC'],
      };
    })(),

    // ── 9. CEX-like DEX price arb ─────────────────────────────────
    cexLikeDexArb: (() => {
      const s = section(cfg, 'cexlike_dex_price_arb');
      return {
        minPriceSpreadPct: num(s, 'min_edge_bps', 25) / 100,
        maxSizeUsd: num(s, 'max_position_usd', 5000),
        minOpenInterest: 10_000,
        minVolume24h: 100_000,
        venues: [],
        minSpreadPersistence: 2,
      };
    })(),

    // ── 10. HL AMM arb ────────────────────────────────────────────
    hlAmmArb: (() => {
      const s = section(cfg, 'hl_amm_arb');
      return {
        minSpreadPct: num(s, 'min_edge_bps', 20) / 100,
        minPoolLiquidityUsd: 100,
        maxSizeUsd: num(s, 'max_position_usd', 5000),
      };
    })(),

    // ── 11. HL LST arb ────────────────────────────────────────────
    hlLstArb: (() => {
      const s = section(cfg, 'hl_lst_arb');
      return {
        minDiscountPct: num(s, 'min_spread_pct', 0.1),
        maxSizeUsd: num(s, 'max_position_usd', 5000),
        preferredFeeTier: 100,
      };
    })(),

    // ── 12. Gold arb ──────────────────────────────────────────────
    goldArb: (() => {
      const s = section(cfg, 'gold_arb');
      return {
        minSpreadPct: num(s, 'min_spread_pct', 0.3),
        maxSizeUsd: num(s, 'max_position_usd', 10_000),
      };
    })(),

    // ── 13. Equity perp cross-venue ───────────────────────────────
    equityPerpCrossVenue: (() => {
      const s = section(cfg, 'equity_perp_cross_venue');
      return {
        minSpreadPct: num(s, 'min_spread_pct', 0.5),
        maxSizeUsd: num(s, 'max_position_usd', 2_000),
      };
    })(),

    // ── 14. LST yield comparison ──────────────────────────────────
    // CORRECTION: previously passed max_position_usd into minTvlUsd.
    // Now reads a dedicated min_tvl_usd key. The strategy has no
    // maxSizeUsd param, so max_position_usd is not consumed here.
    lstYield: (() => {
      const s = section(cfg, 'lst_yield_comparison');
      return {
        minYieldSpreadPct: num(s, 'min_yield_pct', 1.0),
        minTvlUsd: num(s, 'min_tvl_usd', 1_000_000),
      };
    })(),

    // ── 15. PT-kHYPE yield arb ────────────────────────────────────
    ptKhypeArb: (() => {
      const s = section(cfg, 'pt_khype_yield_arb');
      return {
        minYieldSpreadPct: num(s, 'min_spread_pct', 1.0),
        khypeFloatingYieldApr: 2.28,
        maxSizeUsd: num(s, 'max_position_usd', 5_000),
      };
    })(),

    // ── 16. PT yield arb ──────────────────────────────────────────
    ptYieldArb: (() => {
      const s = section(cfg, 'pt_yield_arb');
      return {
        minYieldSpreadPct: num(s, 'min_spread_pct', 3.0),
        minTvlUsd: 500_000,
        maxImpliedApyPct: 50,
        khypeFloatingYieldApr: 2.37,
      };
    })(),

    // ── 17. Euler lending arb ─────────────────────────────────────
    eulerLendingArb: (() => {
      const s = section(cfg, 'euler_lending_arb');
      return {
        minSpreadPct: num(s, 'min_spread_pct', 1.0),
        minLiquidityUsd: 50_000,
        maxSizeUsd: num(s, 'max_position_usd', 5_000),
      };
    })(),

    // ── 18. HL spot basis ─────────────────────────────────────────
    hlSpotBasis: (() => {
      const s = section(cfg, 'hl_spot_basis');
      return {
        minBasisPct: num(s, 'min_basis_bps', 20) / 100,
        minVolume24h: 100_000,
        perpNameMapping: {
          'AVAX0': 'AVAX', 'BTC0': 'BTC', 'ETH0': 'ETH', 'SOL0': 'SOL',
          'DOGE0': 'DOGE', 'XRP0': 'XRP', 'LINK0': 'LINK', 'MATIC0': 'MATIC',
        },
      };
    })(),

    // ── 19. HLP yield ─────────────────────────────────────────────
    hlpYield: (() => {
      const s = section(cfg, 'hlp_yield');
      return {
        minEntryAprPct: num(s, 'min_entry_apr_pct', 15.0),
        warningAprPct: num(s, 'warning_apr_pct', -5.0),
        timeframe: str(s, 'timeframe', 'week') as 'day' | 'week' | 'month',
      };
    })(),

    // ── 20. DefiLlama yield ───────────────────────────────────────
    defiLlamaYield: (() => {
      const s = section(cfg, 'defillama_yield');
      return {
        minApyPct: num(s, 'min_apy_pct', 5.0),
        minTvlUsd: num(s, 'min_tvl_usd', 1_000_000),
        stablecoinOnly: bool(s, 'stablecoin_only', true),
        noIlRiskOnly: bool(s, 'no_il_risk_only', true),
        maxResults: num(s, 'max_results', 50),
      };
    })(),

    // ── 21. RWA treasury ──────────────────────────────────────────
    rwaTreasury: (() => {
      const s = section(cfg, 'rwa_treasury');
      return {
        minTvlUsd: num(s, 'min_tvl_usd', 1_000_000),
        includeInstitutionalCredit: bool(s, 'include_institutional_credit', true),
      };
    })(),

    // ── 22. Stablecoin depeg ──────────────────────────────────────
    stablecoinDepeg: (() => {
      const s = section(cfg, 'stablecoin_depeg');
      return {
        minDepegPct: num(s, 'min_depeg_pct', 0.3),
        majorDepegPct: num(s, 'major_depeg_pct', 2.0),
      };
    })(),

    // ── 23. Liquidation backrun ───────────────────────────────────
    liquidationBackrun: (() => {
      const s = section(cfg, 'liquidation_backrun');
      return {
        cascadeFundingThreshold: num(s, 'cascade_funding_threshold', 100),
        squeezeFundingThreshold: num(s, 'squeeze_funding_threshold', 500),
        minOiUsd: num(s, 'min_oi_usd', 500_000),
      };
    })(),

    // ── 24. Orderbook imbalance ───────────────────────────────────
    orderbookImbalance: (() => {
      const s = section(cfg, 'orderbook_imbalance');
      return {
        coins: strArr(s, 'coins', ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'AVAX', 'LINK', 'UNI', 'AAVE', 'CRV']),
        imbalanceThreshold: num(s, 'imbalance_threshold', 0.30),
        wallThresholdUsd: num(s, 'wall_threshold_usd', 500_000),
        liquidityRangePct: num(s, 'liquidity_range_pct', 1.0),
      };
    })(),

    // ── 25. Funding divergence ────────────────────────────────────
    fundingDivergence: (() => {
      const s = section(cfg, 'funding_divergence');
      return {
        minDivergencePct: num(s, 'min_divergence_pct', 20),
        minExtremeOiUsd: num(s, 'min_extreme_oi_usd', 1_000_000),
        extremeFundingThreshold: num(s, 'extreme_funding_threshold', 50),
      };
    })(),

    // ── 26. Airdrop farming ───────────────────────────────────────
    airdropFarming: (() => {
      const s = section(cfg, 'airdrop_farming');
      return {
        minTotalReturnPct: num(s, 'min_total_return_pct', 10),
      };
    })(),

    // ── 27. Leverage loop ─────────────────────────────────────────
    leverageLoop: (() => {
      const s = section(cfg, 'leverage_loop');
      return {
        minSpreadPct: num(s, 'min_spread_pct', 0.5),
        maxLeverage: num(s, 'max_leverage', 5),
      };
    })(),

    // ── 28. Whale signal ──────────────────────────────────────────
    whaleSignal: (() => {
      const s = section(cfg, 'whale_signal');
      return {
        minVolOiRatio: num(s, 'min_vol_oi_ratio', 0.5),
        minTvlChangePct: num(s, 'min_tvl_change_pct', 5.0),
        minProtocolTvl: num(s, 'min_protocol_tvl', 5_000_000),
      };
    })(),

    // ── 29. CEX-DEX bridge ────────────────────────────────────────
    cexDexBridge: (() => {
      const s = section(cfg, 'cex_dex_bridge');
      return {
        minSpreadPct: num(s, 'min_spread_pct', 0.05),
        coins: strArr(s, 'coins', ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'AVAX', 'LINK', 'UNI', 'AAVE', 'CRV']),
      };
    })(),
  };
}
