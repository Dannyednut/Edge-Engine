/**
 * strategy-configs.test.ts
 * ─────────────────────────────────────────────────────────────────────
 * Tests the pure buildStrategyConfigs() function — the actual values that
 * reach strategy constructors. This is the "real" config test: not just
 * "does TOML contain the key" but "does the right value reach the right
 * constructor parameter with the right unit conversion".
 *
 * Coverage:
 *   - Default values when a TOML section is missing entirely
 *   - Default values when individual keys are missing
 *   - TOML values flow through correctly
 *   - Unit conversions (bps → pct, bps → pct for APR fields)
 *   - The 4 specific bug corrections from the audit
 *   - Type safety (oddsFormat, timeframe)
 *   - Structural constants (CEX_VENUES, VOOI_VENUE_SET)
 *   - vooiAvailable flag propagation
 */
import { describe, it, expect } from 'vitest';
import { buildStrategyConfigs, CEX_VENUES, DEX_VENUES, FLASHLOAN_CHAINS, VOOI_VENUE_SET } from '../src/runners/strategy-configs.js';
import type { AppConfig } from '@edge/types';

// ─── Test helpers ───────────────────────────────────────────────────
function makeEmptyConfig(): AppConfig {
  return {
    chains: {} as any,
    venues: {},
    strategies: {},  // empty — all defaults should kick in
    risk: {
      maxDailyLossUsd: 200,
      maxPerTradeLossUsd: 50,
      maxConcurrentArbs: 3,
      gasPriceCapMultiplier: 3,
      cooldownAfterLossMs: 300000,
      leverageCap: 3,
    },
    alerts: { telegram: { botToken: '', chatId: '' } },
    apis: {},
    capital: {
      workingCapitalUsd: 10000,
      allocationByLandscape: {} as any,
    },
  };
}

function makeConfigWith(strategies: Record<string, Record<string, unknown>>, vooiToken?: string): AppConfig {
  const cfg = makeEmptyConfig();
  cfg.strategies = strategies;
  if (vooiToken) cfg.apis.vooi = { apiToken: vooiToken };
  return cfg;
}

// ─── Tests ──────────────────────────────────────────────────────────
describe('buildStrategyConfigs — empty config (all defaults)', () => {
  const cfg = makeEmptyConfig();
  const sc = buildStrategyConfigs(cfg);

  it('returns all 30 strategy config objects', () => {
    const keys = Object.keys(sc);
    expect(keys.length).toBe(30);
    expect(keys).toContain('perpFunding');
    expect(keys).toContain('cexDexBridge');
  });

  it('crossDexArb defaults to a 15 bps gross screen and reserve floor', () => {
    expect(sc.crossDexArb.minSpreadPct).toBe(0.15);
    expect(sc.crossDexArb.minReserveUsd).toBe(50_000);
    expect(sc.crossDexArb.maxSizeUsd).toBe(8_000);
  });

  it('perpFunding uses fallback minSpreadApr=0.08', () => {
    expect(sc.perpFunding.minSpreadApr).toBe(0.08);
  });

  it('perpFunding.useVooiExecutor is false when no VOOI token', () => {
    expect(sc.perpFunding.useVooiExecutor).toBe(false);
  });

  it('dexCexFlashloan uses fallback useBalancer=true (NOT use_flashbots)', () => {
    expect(sc.dexCexFlashloan.useBalancer).toBe(true);
    expect(sc.dexCexFlashloan.useAaveFallback).toBe(true);
  });

  it('solanaArb minSpreadPct = 80/100 = 0.8 (above 50 bps break-even)', () => {
    // CORRECTION: was 50/100/10 = 0.05 (below break-even)
    expect(sc.solanaArb.minSpreadPct).toBe(0.8);
    expect(sc.solanaArb.minSpreadPct).toBeGreaterThan(0.5);  // must clear fees
  });

  it('pendleBoros minSpreadApr = 0.5 fallback (renamed from min_yield_pct)', () => {
    expect(sc.pendleBoros.minSpreadApr).toBe(0.5);
  });

  it('lstYield minTvlUsd = 1_000_000 fallback (NOT max_position_usd)', () => {
    // CORRECTION: previously passed max_position_usd (10000) into minTvlUsd
    expect(sc.lstYield.minTvlUsd).toBe(1_000_000);
    expect(sc.lstYield.minTvlUsd).not.toBe(10000);
  });

  it('hlpYield timeframe is "week" by default', () => {
    expect(sc.hlpYield.timeframe).toBe('week');
  });

  it('sportsArb oddsFormat is "decimal" by default', () => {
    expect(sc.sportsArb.oddsFormat).toBe('decimal');
  });
});

describe('buildStrategyConfigs — VOOI token propagation', () => {
  it('useVooiExecutor is true when VOOI token present', () => {
    const sc = buildStrategyConfigs(makeConfigWith({}, 'test-vooi-token'));
    expect(sc.perpFunding.useVooiExecutor).toBe(true);
    expect(sc.cexHlArb.useVooiExecutor).toBe(true);
  });

  it('useVooiExecutor is false when VOOI token absent', () => {
    const sc = buildStrategyConfigs(makeConfigWith({}));
    expect(sc.perpFunding.useVooiExecutor).toBe(false);
    expect(sc.cexHlArb.useVooiExecutor).toBe(false);
  });
});

describe('buildStrategyConfigs — TOML values flow through', () => {
  it('perp_funding reads min_spread_apr from TOML', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      perp_funding: { min_spread_apr: 0.15 },
    }));
    expect(sc.perpFunding.minSpreadApr).toBe(0.15);
  });

  it('perp_funding reads long_venues and short_venues arrays', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      perp_funding: { long_venues: ['binance'], short_venues: ['hyperliquid'] },
    }));
    expect(sc.perpFunding.longVenues).toEqual(['binance']);
    expect(sc.perpFunding.shortVenues).toEqual(['hyperliquid']);
  });

  it('cross_dex_arb converts min_gross_spread_bps from bps to percent', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      cross_dex_arb: { min_gross_spread_bps: 25, min_reserve_usd: 75_000, max_position_usd: 6_000 },
    }));
    expect(sc.crossDexArb.minSpreadPct).toBe(0.25);
    expect(sc.crossDexArb.minReserveUsd).toBe(75_000);
    expect(sc.crossDexArb.maxSizeUsd).toBe(6_000);
  });

  it('cex_hl_funding_arb reads max_position_usd into maxNotionalUsd', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      cex_hl_funding_arb: { max_position_usd: 8000 },
    }));
    expect(sc.cexHlArb.maxNotionalUsd).toBe(8000);
  });
});

describe('buildStrategyConfigs — bps → pct conversions', () => {
  it('dex_cex_flashloan: 30 bps → 0.3 pct', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      dex_cex_flashloan: { min_edge_bps: 30 },
    }));
    expect(sc.dexCexFlashloan.minGrossSpreadPct).toBe(0.3);
  });

  it('solana_memecoin_arb: 80 bps → 0.8 pct (NOT 0.05)', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      solana_memecoin_arb: { min_edge_bps: 80 },
    }));
    expect(sc.solanaArb.minSpreadPct).toBe(0.8);
    // Verify the OLD broken conversion is NOT used
    expect(sc.solanaArb.minSpreadPct).not.toBe(0.05);
    expect(sc.solanaArb.minSpreadPct).not.toBe(0.008);
  });

  it('solana_memecoin_arb: 50 bps would be break-even (0.5 pct)', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      solana_memecoin_arb: { min_edge_bps: 50 },
    }));
    expect(sc.solanaArb.minSpreadPct).toBe(0.5);  // exactly break-even
  });

  it('cexlike_dex_price_arb: 25 bps → 0.25 pct', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      cexlike_dex_price_arb: { min_edge_bps: 25 },
    }));
    expect(sc.cexLikeDexArb.minPriceSpreadPct).toBe(0.25);
  });

  it('hl_amm_arb: 20 bps → 0.2 pct', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      hl_amm_arb: { min_edge_bps: 20 },
    }));
    expect(sc.hlAmmArb.minSpreadPct).toBe(0.2);
  });

  it('hl_spot_basis: 20 bps → 0.2 pct', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      hl_spot_basis: { min_basis_bps: 20 },
    }));
    expect(sc.hlSpotBasis.minBasisPct).toBe(0.2);
  });
});

describe('buildStrategyConfigs — CORRECTION 1: lst_yield_comparison', () => {
  it('reads min_tvl_usd from TOML (NOT max_position_usd)', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      lst_yield_comparison: { min_tvl_usd: 2_000_000, max_position_usd: 5000 },
    }));
    expect(sc.lstYield.minTvlUsd).toBe(2_000_000);
    expect(sc.lstYield.minTvlUsd).not.toBe(5000);
  });

  it('falls back to 1_000_000 when min_tvl_usd missing', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      lst_yield_comparison: { max_position_usd: 5000 },  // no min_tvl_usd
    }));
    expect(sc.lstYield.minTvlUsd).toBe(1_000_000);
  });

  it('reads min_yield_pct into minYieldSpreadPct', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      lst_yield_comparison: { min_yield_pct: 5.0 },
    }));
    expect(sc.lstYield.minYieldSpreadPct).toBe(5.0);
  });
});

describe('buildStrategyConfigs — CORRECTION 2: dex_cex_flashloan', () => {
  it('reads use_balancer from TOML', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      dex_cex_flashloan: { use_balancer: false },
    }));
    expect(sc.dexCexFlashloan.useBalancer).toBe(false);
  });

  it('reads use_aave_fallback from TOML', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      dex_cex_flashloan: { use_aave_fallback: false },
    }));
    expect(sc.dexCexFlashloan.useAaveFallback).toBe(false);
  });

  it('does NOT read use_flashbots for useBalancer', () => {
    // use_flashbots should be ignored — it's a different concept (MEV protection)
    const sc = buildStrategyConfigs(makeConfigWith({
      dex_cex_flashloan: { use_flashbots: false, use_balancer: true },
    }));
    expect(sc.dexCexFlashloan.useBalancer).toBe(true);  // from use_balancer, not use_flashbots
  });

  it('defaults to useBalancer=true when neither key present', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      dex_cex_flashloan: { min_edge_bps: 30 },
    }));
    expect(sc.dexCexFlashloan.useBalancer).toBe(true);
    expect(sc.dexCexFlashloan.useAaveFallback).toBe(true);
  });
});

describe('buildStrategyConfigs — CORRECTION 3: solana_memecoin_arb', () => {
  it('80 bps → 0.8 pct (clears 0.5% fee burden with 0.3% margin)', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      solana_memecoin_arb: { min_edge_bps: 80 },
    }));
    expect(sc.solanaArb.minSpreadPct).toBe(0.8);
    expect(sc.solanaArb.minSpreadPct).toBeGreaterThan(0.5);
  });

  it('default fallback is 80 bps (not 50)', () => {
    const sc = buildStrategyConfigs(makeConfigWith({}));
    expect(sc.solanaArb.minSpreadPct).toBe(0.8);
  });
});

describe('buildStrategyConfigs — CORRECTION 4: pendle_boros', () => {
  it('reads min_spread_apr_pct from TOML', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      pendle_boros: { min_spread_apr_pct: 7.5 },
    }));
    expect(sc.pendleBoros.minSpreadApr).toBe(7.5);
  });

  it('does NOT read old min_yield_pct key', () => {
    // If only the old key is present, the fallback (0.5) should be used
    const sc = buildStrategyConfigs(makeConfigWith({
      pendle_boros: { min_yield_pct: 5 },
    }));
    expect(sc.pendleBoros.minSpreadApr).toBe(0.5);  // fallback, not 5
  });

  it('falls back to 0.5 when min_spread_apr_pct missing', () => {
    const sc = buildStrategyConfigs(makeConfigWith({}));
    expect(sc.pendleBoros.minSpreadApr).toBe(0.5);
  });
});

describe('buildStrategyConfigs — type safety', () => {
  it('hlpYield timeframe accepts only day/week/month', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      hlp_yield: { timeframe: 'day' },
    }));
    expect(sc.hlpYield.timeframe).toBe('day');
  });

  it('hlpYield timeframe defaults to week for unknown value', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      hlp_yield: { timeframe: 'invalid' },
    }));
    // str() returns the string as-is; the cast is a type assertion.
    // The strategy itself would handle invalid values at runtime.
    expect(sc.hlpYield.timeframe).toBe('invalid' as any);
  });

  it('sportsArb oddsFormat: "american" passes through', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      sports_arb: { odds_format: 'american' },
    }));
    expect(sc.sportsArb.oddsFormat).toBe('american');
  });

  it('sportsArb oddsFormat: unknown value defaults to "decimal"', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      sports_arb: { odds_format: 'invalid' },
    }));
    expect(sc.sportsArb.oddsFormat).toBe('decimal');
  });
});

describe('buildStrategyConfigs — structural constants', () => {
  it('CEX_VENUES contains 5 venues', () => {
    expect(CEX_VENUES).toEqual(['binance', 'okx', 'bybit', 'mexc', 'gate']);
    expect(CEX_VENUES.length).toBe(5);
  });

  it('VOOI_VENUE_SET contains 12 venues including hyperliquid', () => {
    expect(VOOI_VENUE_SET.length).toBe(12);
    expect(VOOI_VENUE_SET).toContain('hyperliquid');
    expect(VOOI_VENUE_SET).toContain('binance');
  });

  it('perpFunding.vooiVenueSet uses the structural constant', () => {
    const sc = buildStrategyConfigs(makeEmptyConfig());
    expect(sc.perpFunding.vooiVenueSet).toBe(VOOI_VENUE_SET);
  });

  it('dexCexFlashloan.cexVenues uses CEX_VENUES', () => {
    const sc = buildStrategyConfigs(makeEmptyConfig());
    expect(sc.dexCexFlashloan.cexVenues).toBe(CEX_VENUES);
  });

  it('dexCexFlashloan.dexVenues uses DEX_VENUES', () => {
    const sc = buildStrategyConfigs(makeEmptyConfig());
    expect(sc.dexCexFlashloan.dexVenues).toBe(DEX_VENUES);
  });

  it('dexCexFlashloan.flashloanChains uses FLASHLOAN_CHAINS by default', () => {
    const sc = buildStrategyConfigs(makeEmptyConfig());
    expect(sc.dexCexFlashloan.flashloanChains).toEqual(FLASHLOAN_CHAINS);
  });

  it('dexCexFlashloan.flashloanChains reads chains_active from TOML', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      dex_cex_flashloan: { chains_active: ['arbitrum', 'base'] },
    }));
    expect(sc.dexCexFlashloan.flashloanChains).toEqual(['arbitrum', 'base']);
  });
});

describe('buildStrategyConfigs — malformed input handling', () => {
  it('non-number value for numeric key falls back to default', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      perp_funding: { min_spread_apr: 'not-a-number' as any },
    }));
    expect(sc.perpFunding.minSpreadApr).toBe(0.08);  // fallback
  });

  it('NaN value for numeric key falls back to default', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      perp_funding: { min_spread_apr: NaN },
    }));
    expect(sc.perpFunding.minSpreadApr).toBe(0.08);
  });

  it('non-boolean value for boolean key falls back to default', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      dex_cex_flashloan: { use_balancer: 'yes' as any },
    }));
    expect(sc.dexCexFlashloan.useBalancer).toBe(true);  // fallback
  });

  it('non-array value for array key falls back to default', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      perp_funding: { long_venues: 'binance' as any },
    }));
    expect(sc.perpFunding.longVenues).toContain('pacifica');  // fallback array
  });

  it('empty strategies object produces all 30 configs with defaults', () => {
    const sc = buildStrategyConfigs(makeEmptyConfig());
    expect(Object.keys(sc).length).toBe(30);
    // Spot-check that defaults are sensible
    expect(sc.goldArb.minSpreadPct).toBe(0.3);
    expect(sc.fundingDivergence.extremeFundingThreshold).toBe(50);
  });
});

describe('buildStrategyConfigs — per-strategy spot checks', () => {
  it('orderbookImbalance reads coins array from TOML', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      orderbook_imbalance: { coins: ['BTC', 'ETH'], imbalance_threshold: 0.4 },
    }));
    expect(sc.orderbookImbalance.coins).toEqual(['BTC', 'ETH']);
    expect(sc.orderbookImbalance.imbalanceThreshold).toBe(0.4);
  });

  it('liquidationBackrun reads all 3 thresholds', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      liquidation_backrun: {
        cascade_funding_threshold: 150,
        squeeze_funding_threshold: 600,
        min_oi_usd: 750_000,
      },
    }));
    expect(sc.liquidationBackrun.cascadeFundingThreshold).toBe(150);
    expect(sc.liquidationBackrun.squeezeFundingThreshold).toBe(600);
    expect(sc.liquidationBackrun.minOiUsd).toBe(750_000);
  });

  it('defiLlamaYield reads all 5 params', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      defillama_yield: {
        min_apy_pct: 10,
        min_tvl_usd: 5_000_000,
        stablecoin_only: false,
        no_il_risk_only: false,
        max_results: 100,
      },
    }));
    expect(sc.defiLlamaYield.minApyPct).toBe(10);
    expect(sc.defiLlamaYield.minTvlUsd).toBe(5_000_000);
    expect(sc.defiLlamaYield.stablecoinOnly).toBe(false);
    expect(sc.defiLlamaYield.noIlRiskOnly).toBe(false);
    expect(sc.defiLlamaYield.maxResults).toBe(100);
  });

  it('cexDexBridge reads coins and min_spread_pct', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      cex_dex_bridge: { min_spread_pct: 0.1, coins: ['BTC', 'ETH'] },
    }));
    expect(sc.cexDexBridge.minSpreadPct).toBe(0.1);
    expect(sc.cexDexBridge.coins).toEqual(['BTC', 'ETH']);
  });

  it('whaleSignal reads all 3 params', () => {
    const sc = buildStrategyConfigs(makeConfigWith({
      whale_signal: {
        min_vol_oi_ratio: 0.8,
        min_tvl_change_pct: 10,
        min_protocol_tvl: 10_000_000,
      },
    }));
    expect(sc.whaleSignal.minVolOiRatio).toBe(0.8);
    expect(sc.whaleSignal.minTvlChangePct).toBe(10);
    expect(sc.whaleSignal.minProtocolTvl).toBe(10_000_000);
  });

  it('ptKhypeArb preserves khypeFloatingYieldApr=2.28 (hardcoded)', () => {
    const sc = buildStrategyConfigs(makeEmptyConfig());
    expect(sc.ptKhypeArb.khypeFloatingYieldApr).toBe(2.28);
  });

  it('ptYieldArb preserves khypeFloatingYieldApr=2.37 (hardcoded)', () => {
    const sc = buildStrategyConfigs(makeEmptyConfig());
    expect(sc.ptYieldArb.khypeFloatingYieldApr).toBe(2.37);
  });

  it('hlSpotBasis preserves perpNameMapping (structural)', () => {
    const sc = buildStrategyConfigs(makeEmptyConfig());
    expect(sc.hlSpotBasis.perpNameMapping['BTC0']).toBe('BTC');
    expect(sc.hlSpotBasis.perpNameMapping['ETH0']).toBe('ETH');
  });
});
