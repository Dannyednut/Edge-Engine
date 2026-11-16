/**
 * defillama-production-path.test.ts
 * ─────────────────────────────────────────────────────────────────────
 * Tests that exercise the REAL production collection path for the
 * DefiLlama one-shot collector (khope-timeseries.ts). Unlike the
 * pre-existing DI tests which call the injected append callback directly,
 * these tests invoke the actual `collectOnce()` production function with:
 *
 *   - A controlled `setFetchFn` fixture returning a known pools list
 *     (or a simulated fetch failure) — NO live DefiLlama API calls.
 *   - An injected `setAppendFn` that either succeeds, returns false, or
 *     throws — to verify the production path's failure semantics.
 *
 * Verified properties:
 *   1. Successful fetch + successful append → returns true (durable save)
 *   2. Successful fetch + failing append   → returns false (no false durability)
 *   3. Successful fetch + throwing append  → returns false (throw caught)
 *   4. Failed fetch (simulated) + successful append → returns true
 *      (the failure observation itself is durably recorded)
 *   5. Failed fetch + failing append → returns false (failure NOT durably saved)
 *   6. collectOnce() does NOT call setInterval (one-shot path)
 *   7. The injected append function receives the production-built observation
 *      (not null), proving the real fetch → match → build pipeline ran
 *
 * The tests do NOT depend on the live DefiLlama API.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  collectOnce,
  setFetchFn,
  setAppendFn,
  type Observation,
  type DefiLlamaAppendFn,
  type FetchFn,
} from '../src/runners/khype-timeseries.js';

// ─── Fixtures ────────────────────────────────────────────────────────

/**
 * A minimal DefiLlama pools payload that exercises the production matcher.
 * Pool 1 matches `khype_staking` (symbol contains 'khype').
 * Pool 2 matches `whype_khope_nest` (pool ID contains 'whype-khope' AND
 *   neither symbol nor pool ID contains 'khype' — otherwise the greedy
 *   `khype_staking` selector matches first).
 * Pool 3 is unrelated (no match).
 */
const FIXTURE_POOLS = [
  {
    pool: '0xabc1-hyperevm',
    chain: 'hyperevm',
    project: 'kinetiq',
    symbol: 'kHYPE',
    apy: 4.21,
    apyBase: 4.21,
    apyReward: 0,
    tvlUsd: 50_000_000,
  },
  {
    pool: '0xabc2-hyperevm-whype-khope',
    chain: 'hyperevm',
    project: 'nest',
    // Avoid 'khype' in symbol — otherwise the greedy `khype_staking`
    // selector (pattern='khype') matches first and pool 2 gets the wrong label.
    symbol: 'wH-kHope',
    apy: 12.34,
    apyBase: 8.0,
    apyReward: 4.34,
    tvlUsd: 1_200_000,
  },
  {
    pool: '0xunrelated-ethereum',
    chain: 'ethereum',
    project: 'aave',
    symbol: 'USDC',
    apy: 3.5,
    apyBase: 3.5,
    apyReward: 0,
    tvlUsd: 500_000_000,
  },
];

const successFetch: FetchFn = async () => ({ pools: FIXTURE_POOLS, ok: true });
const emptyFetch: FetchFn = async () => ({ pools: [], ok: true });
const failedFetch: FetchFn = async () => ({
  pools: [],
  ok: false,
  error: 'simulated HTTP 503',
});

// ─── Tests ───────────────────────────────────────────────────────────

describe('DefiLlama collectOnce — production path with injected fetch + append', () => {
  let callCount: number;
  let lastObs: Observation | null;

  beforeEach(() => {
    callCount = 0;
    lastObs = null;
    // Default: success append that records what it received
    setAppendFn(((obs: Observation) => {
      callCount++;
      lastObs = obs;
      return true;
    }) as DefiLlamaAppendFn);
  });

  afterEach(() => {
    // Reset both injectable seams to defaults
    setFetchFn(null);
    setAppendFn((() => true) as DefiLlamaAppendFn);
  });

  it('successful fetch + successful append → returns true (durable save)', async () => {
    setFetchFn(successFetch);
    const result = await collectOnce();
    expect(result).toBe(true);
    expect(callCount).toBe(1);
    expect(lastObs).not.toBeNull();
    expect(lastObs!.apiStatus).toBe('ok');
    expect(lastObs!.matchedPools).toBe(2); // FIXTURE_POOLS has 2 matches
    expect(lastObs!.totalPoolsScanned).toBe(3);
  });

  it('append failure propagates failure through the one-shot path', async () => {
    setFetchFn(successFetch);
    setAppendFn((() => false) as DefiLlamaAppendFn);
    const result = await collectOnce();
    expect(result).toBe(false);
  });

  it('a failed append does NOT report the sample as durably saved', async () => {
    setFetchFn(successFetch);
    setAppendFn((() => false) as DefiLlamaAppendFn);
    const result = await collectOnce();
    expect(result).toBe(false);
    // Critical: the production path MUST NOT report success when append failed.
    // A one-shot process would exit non-zero based on this return value.
  });

  it('throwing append is caught by production code and returns false', async () => {
    setFetchFn(successFetch);
    setAppendFn((() => { throw new Error('EIO'); }) as DefiLlamaAppendFn);
    // The production appendObservation wraps appendFn in try/catch —
    // a throw must NOT propagate out of collectOnce.
    const result = await collectOnce();
    expect(result).toBe(false);
  });

  it('failed fetch (simulated) + successful append → returns true (failure obs durably recorded)', async () => {
    setFetchFn(failedFetch);
    const result = await collectOnce();
    expect(result).toBe(true);
    expect(callCount).toBe(1);
    expect(lastObs).not.toBeNull();
    expect(lastObs!.apiStatus).toBe('error');
    expect(lastObs!.matchedPools).toBe(0);
    expect(lastObs!.totalPoolsScanned).toBe(0);
    expect(lastObs!.note).toContain('simulated HTTP 503');
  });

  it('failed fetch + failing append → returns false (failure NOT durably saved)', async () => {
    setFetchFn(failedFetch);
    setAppendFn((() => false) as DefiLlamaAppendFn);
    const result = await collectOnce();
    expect(result).toBe(false);
  });

  it('empty fetch (ok=true, 0 pools) + successful append → returns true', async () => {
    setFetchFn(emptyFetch);
    const result = await collectOnce();
    expect(result).toBe(true);
    expect(lastObs!.apiStatus).toBe('empty');
    expect(lastObs!.matchedPools).toBe(0);
  });

  it('production-built observation has expected structure (real matcher ran)', async () => {
    setFetchFn(successFetch);
    await collectOnce();
    expect(lastObs).not.toBeNull();
    expect(lastObs!.source).toBe('defillama');
    expect(lastObs!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(lastObs!.fetchMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(lastObs!.pools)).toBe(true);
    // Verify the matcher picked the right pools
    const labels = lastObs!.pools.map(p => p.label).sort();
    expect(labels).toEqual(['khype_staking', 'whype_khope_nest']);
  });

  it('collectOnce does NOT call setInterval (one-shot path safety)', async () => {
    setFetchFn(successFetch);
    // Spy on setInterval — collectOnce must not invoke it. Only main() does,
    // and only when not in --once mode.
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    try {
      await collectOnce();
      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it('collectOnce returns false on overlap (previous cycle still running)', async () => {
    // Force the overlap-guard by triggering a long-running fetch.
    // The first call's fetch hasn't resolved when we issue the second call.
    let resolveFetch!: () => void;
    const blockingFetch: FetchFn = () => new Promise((resolve) => {
      resolveFetch = () => resolve({ pools: FIXTURE_POOLS, ok: true });
    });
    setFetchFn(blockingFetch);

    const first = collectOnce();          // starts, holds the lock
    const second = collectOnce();         // hits the overlap guard
    const secondResult = await second;
    expect(secondResult).toBe(false);     // overlap → false

    // Release the first call
    resolveFetch();
    const firstResult = await first;
    expect(firstResult).toBe(true);
  });

  it('failed then successful collectOnce — recovery path', async () => {
    // First: failing append → false
    setFetchFn(successFetch);
    setAppendFn((() => false) as DefiLlamaAppendFn);
    const r1 = await collectOnce();
    expect(r1).toBe(false);

    // Second: successful append → true (collectOnce is stateless across calls
    // except for the overlap guard, which the finally block releases)
    setAppendFn(((obs: Observation) => {
      callCount++;
      lastObs = obs;
      return true;
    }) as DefiLlamaAppendFn);
    const r2 = await collectOnce();
    expect(r2).toBe(true);
  });
});
