/**
 * Config-wiring test — verifies that strategies.toml values flow through
 * loadConfig() into the strategy sections that all-runner.ts reads.
 *
 * This locks in the resolution of the config drift documented in
 * docs/CONFIG_DRIFT_REPORT.md (strategies.toml was parsed but not consumed).
 */
import { describe, it, expect } from 'vitest';
import { loadConfig } from '@edge/config';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

describe('config wiring: strategies.toml → all-runner.ts', () => {
  const cfg = loadConfig(REPO_ROOT);

  it('loadConfig returns a non-empty strategies record', () => {
    expect(cfg.strategies).toBeDefined();
    expect(Object.keys(cfg.strategies).length).toBeGreaterThanOrEqual(28);
  });

  it('perp_funding.min_spread_apr matches TOML (0.08)', () => {
    const s = cfg.strategies['perp_funding'];
    expect(s).toBeDefined();
    expect(s.min_spread_apr).toBe(0.08);
    expect(s.long_venues).toContain('pacifica');
    expect(s.short_venues).toContain('hyperliquid');
    expect(s.use_vooi_executor).toBe(true);
  });

  it('cex_hl_funding_arb thresholds are present', () => {
    const s = cfg.strategies['cex_hl_funding_arb'];
    expect(s.min_spread_apr).toBe(0.05);
    expect(s.max_position_usd).toBe(5000);
  });

  it('dex_cex_flashloan has 30 bps min edge and chains list', () => {
    const s = cfg.strategies['dex_cex_flashloan'];
    expect(s.min_edge_bps).toBe(30);
    expect(Array.isArray(s.chains_active)).toBe(true);
    expect(s.chains_active).toContain('arbitrum');
    // CORRECTION: use_balancer/use_aave_fallback replace the misused use_flashbots
    expect(s.use_balancer).toBe(true);
    expect(s.use_aave_fallback).toBe(true);
  });

  it('defillama_yield new-strategy section is present', () => {
    const s = cfg.strategies['defillama_yield'];
    expect(s).toBeDefined();
    expect(s.min_apy_pct).toBe(5.0);
    expect(s.min_tvl_usd).toBe(1_000_000);
    expect(s.stablecoin_only).toBe(true);
    expect(s.no_il_risk_only).toBe(true);
    expect(s.max_results).toBe(50);
  });

  it('orderbook_imbalance has 10-coin watchlist', () => {
    const s = cfg.strategies['orderbook_imbalance'];
    expect(Array.isArray(s.coins)).toBe(true);
    expect(s.coins.length).toBe(10);
    expect(s.imbalance_threshold).toBe(0.30);
  });

  it('cex_dex_bridge thresholds flow through', () => {
    const s = cfg.strategies['cex_dex_bridge'];
    expect(s.min_spread_pct).toBe(0.05);
    expect(Array.isArray(s.coins)).toBe(true);
  });

  it('pendle_boros uses renamed min_spread_apr_pct', () => {
    const s = cfg.strategies['pendle_boros'];
    expect(s.min_spread_apr_pct).toBe(5);
    // old key should NOT be present
    expect(s.min_yield_pct).toBeUndefined();
  });

  it('whale_signal thresholds are present', () => {
    const s = cfg.strategies['whale_signal'];
    expect(s.min_vol_oi_ratio).toBe(0.5);
    expect(s.min_tvl_change_pct).toBe(5.0);
    expect(s.min_protocol_tvl).toBe(5_000_000);
  });

  it('hlp_yield timeframe is "week"', () => {
    const s = cfg.strategies['hlp_yield'];
    expect(s.min_entry_apr_pct).toBe(15);
    expect(s.warning_apr_pct).toBe(-5);
    expect(s.timeframe).toBe('week');
  });

  it('lst_yield_comparison has separate min_tvl_usd (not max_position_usd)', () => {
    const s = cfg.strategies['lst_yield_comparison'];
    expect(s.min_tvl_usd).toBe(1_000_000);
    expect(s.min_yield_pct).toBe(3.0);
  });

  it('solana_memecoin_arb min_edge_bps is 80 (above 50 bps break-even)', () => {
    const s = cfg.strategies['solana_memecoin_arb'];
    expect(s.min_edge_bps).toBe(80);
  });

  it('all expected strategy sections are present in TOML', () => {
    const expected = [
      'perp_funding', 'cex_hl_funding_arb', 'dex_cex_flashloan', 'dex_dex',
      'prediction_arb', 'sports_arb', 'mev_backrun', 'hl_spot_basis',
      'hlp_yield', 'pendle_boros', 'pt_yield_arb', 'pt_khype_yield_arb',
      'lst_yield_comparison', 'euler_lending_arb', 'tokenized_equity',
      'equity_perp_cross_venue', 'hl_amm_arb', 'hl_lst_arb', 'gold_arb',
      'cross_dex_arb', 'precompile_flashloan_arb', 'cexlike_dex_price_arb',
      'solana_memecoin_arb',
      // New (migrated)
      'defillama_yield', 'rwa_treasury', 'stablecoin_depeg',
      'liquidation_backrun', 'orderbook_imbalance', 'funding_divergence',
      'airdrop_farming', 'leverage_loop', 'whale_signal', 'cex_dex_bridge',
    ];
    const missing = expected.filter(k => !cfg.strategies[k]);
    expect(missing, `missing strategy sections: ${missing.join(', ')}`).toEqual([]);
  });
});
