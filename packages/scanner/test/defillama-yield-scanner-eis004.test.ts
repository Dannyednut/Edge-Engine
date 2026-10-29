/**
 * defillama-yield-scanner-eis004.test.ts
 * ─────────────────────────────────────────────────────────────────────
 * Tests the EI-S004 data-quality filters on the DefiLlamaYieldScanner:
 *   1. growihf "Hyperliquid Vault" pool is excluded
 *   2. outlier=true pools are excluded
 *   3. pools with apyBase=null are excluded
 *   4. kinetiq-khype (legitimate) pool still passes
 *
 * Evidence: EIS004_RESEARCH_REPORT.md §6.3, table T5
 *
 * EM-STRAT-007 §2: refactored to use the `mockFetch` API instead of
 * overwriting `globalThis.fetch` directly. This keeps the offline guard
 * in place and prevents any risk of leaving the guard in a broken state.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DefiLlamaYieldScanner } from '../src/strategies/defillama-yield-scanner.js';
import { mockFetch } from './_setup/offline-mocks.js';

// ─── Fixtures ───────────────────────────────────────────────────────

/** The growihf Hyperliquid Vault pool (EI-S004 table T5).
 *  pool 90c0b5b5…: TVL $13.76M, stablecoin=true, APY 50.8%,
 *  poolMeta="Hyperliquid Vault", apyBase=null, outlier=true.
 *  This is a trading vault, NOT a deposit yield. */
const GROWIHF_POOL = {
  pool: '90c0b5b5-test-test-test',
  symbol: 'USDC',
  project: 'growihf',
  chain: 'Hyperliquid L1',
  apy: 50.8,
  apyBase: null,
  apyReward: null,
  apyPct1D: -32.45,
  apyMean30d: 62.4,
  tvlUsd: 13_756_040,
  stablecoin: true,
  ilRisk: 'no',
  exposure: 'single',
  outlier: true,
  poolMeta: 'Hyperliquid Vault',
  prediction: { direction: 'Down', confidence: 0.73 },
};

/** The kinetiq-khype staking pool (legitimate, verified by EI-S004).
 *  pool 9f25a954…: TVL $843.3M, APY 1.92%, outlier=false, no poolMeta.
 *  This is a real LST staking yield and should pass the filters. */
const KHYPE_POOL = {
  pool: '9f25a954-db87-4bb2-a8b2-4be0b843a44c',
  symbol: 'KHYPE',
  project: 'kinetiq-khype',
  chain: 'Hyperliquid L1',
  apy: 1.92,
  apyBase: 1.92,
  apyReward: null,
  tvlUsd: 843_300_000,
  stablecoin: false,
  ilRisk: 'no',
  exposure: 'single',
  outlier: false,
  poolMeta: null,
};

/** A legitimate lending pool with apyBase > 0. */
const LENDING_POOL = {
  pool: 'lending-pool-test',
  symbol: 'USDC',
  project: 'aave-v3',
  chain: 'Ethereum',
  apy: 5.5,
  apyBase: 5.5,
  apyReward: 0,
  tvlUsd: 500_000_000,
  stablecoin: true,
  ilRisk: 'no',
  exposure: 'single',
  outlier: false,
  poolMeta: null,
};

/** A reward-token farm with apyBase=null but apyReward>0.
 *  This is excluded by the apyBase filter — documented trade-off. */
const REWARD_FARM_POOL = {
  pool: 'reward-farm-test',
  symbol: 'USDC',
  project: 'some-farm',
  chain: 'Arbitrum',
  apy: 120.0,
  apyBase: null,
  apyReward: 120.0,
  tvlUsd: 5_000_000,
  stablecoin: true,
  ilRisk: 'yes',
  exposure: 'multi',
  outlier: false,
  poolMeta: null,
};

/** Helper: register a mock response for the DeFiLlama yields API returning
 *  the given fixture pools. Uses the mockFetch API so the offline guard
 *  remains in place. */
function mockDefiLlamaPools(pools: any[]) {
  mockFetch.clear();
  mockFetch.register('yields.llama.fi', {
    status: 200,
    json: async () => ({ data: pools }),
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('DefiLlamaYieldScanner — EI-S004 data-quality filters', () => {
  // EM-STRAT-007 §2: use mockFetch.clear() in afterEach to ensure mocks
  // don't leak across test boundaries. The offline-mocks helper already
  // registers default mocks in beforeEach, but we override them per-test
  // via mockDefiLlamaPools().
  afterEach(() => {
    mockFetch.clear();
  });

  it('growihf "Hyperliquid Vault" pool is excluded', async () => {
    mockDefiLlamaPools([GROWIHF_POOL]);
    const scanner = new DefiLlamaYieldScanner({
      minApyPct: 1.0,
      minTvlUsd: 1_000_000,
      stablecoinOnly: false,
      noIlRiskOnly: false,
      maxResults: 50,
    });
    const results = await scanner.scan();
    expect(results.length).toBe(0);
  });

  it('kinetiq-khype (legitimate) pool passes all filters', async () => {
    mockDefiLlamaPools([KHYPE_POOL]);
    const scanner = new DefiLlamaYieldScanner({
      minApyPct: 1.0,
      minTvlUsd: 100_000,
      stablecoinOnly: false,
      noIlRiskOnly: false,
      maxResults: 50,
    });
    const results = await scanner.scan();
    expect(results.length).toBe(1);
    expect(results[0].project).toBe('kinetiq-khype');
    expect(results[0].symbol).toBe('KHYPE');
    expect(results[0].apy).toBeCloseTo(1.92, 2);
  });

  it('outlier=true pool is excluded even without poolMeta="Vault"', async () => {
    const outlierPool = { ...KHYPE_POOL, outlier: true, pool: 'outlier-test' };
    mockDefiLlamaPools([outlierPool]);
    const scanner = new DefiLlamaYieldScanner({
      minApyPct: 1.0,
      minTvlUsd: 100_000,
      stablecoinOnly: false,
      noIlRiskOnly: false,
      maxResults: 50,
    });
    const results = await scanner.scan();
    expect(results.length).toBe(0);
  });

  it('apyBase=null pool is excluded (even if not a vault/outlier)', async () => {
    const noBasePool = { ...KHYPE_POOL, apyBase: null, pool: 'no-base-test' };
    mockDefiLlamaPools([noBasePool]);
    const scanner = new DefiLlamaYieldScanner({
      minApyPct: 1.0,
      minTvlUsd: 100_000,
      stablecoinOnly: false,
      noIlRiskOnly: false,
      maxResults: 50,
    });
    const results = await scanner.scan();
    expect(results.length).toBe(0);
  });

  it('legitimate lending pool with apyBase>0 passes', async () => {
    mockDefiLlamaPools([LENDING_POOL]);
    const scanner = new DefiLlamaYieldScanner({
      minApyPct: 1.0,
      minTvlUsd: 100_000,
      stablecoinOnly: true,
      noIlRiskOnly: true,
      maxResults: 50,
    });
    const results = await scanner.scan();
    expect(results.length).toBe(1);
    expect(results[0].project).toBe('aave-v3');
  });

  it('reward-token farm with apyBase=null is excluded (documented trade-off)', async () => {
    mockDefiLlamaPools([REWARD_FARM_POOL]);
    const scanner = new DefiLlamaYieldScanner({
      minApyPct: 1.0,
      minTvlUsd: 100_000,
      stablecoinOnly: false,
      noIlRiskOnly: false,
      maxResults: 50,
    });
    const results = await scanner.scan();
    // Excluded because apyBase=null — documented in the scanner source
    expect(results.length).toBe(0);
  });

  it('mixed fixture: growihf excluded, khype and lending pass', async () => {
    mockDefiLlamaPools([GROWIHF_POOL, KHYPE_POOL, LENDING_POOL]);
    const scanner = new DefiLlamaYieldScanner({
      minApyPct: 1.0,
      minTvlUsd: 100_000,
      stablecoinOnly: false,
      noIlRiskOnly: false,
      maxResults: 50,
    });
    const results = await scanner.scan();
    // growihf excluded (vault+outlier+apyBase=null), khype and lending pass
    expect(results.length).toBe(2);
    const projects = results.map(r => r.project);
    expect(projects).toContain('kinetiq-khype');
    expect(projects).toContain('aave-v3');
    expect(projects).not.toContain('growihf');
  });
});
