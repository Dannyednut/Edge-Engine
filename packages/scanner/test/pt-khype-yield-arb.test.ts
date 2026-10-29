/**
 * EM-STRAT-014-B2 — PtKhypeYieldArbScanner signal-integrity quarantine tests.
 *
 * Deterministic, offline, mock-only. Proves:
 *   - The fabricated 0.98 price can never produce an alert.
 *   - Every expired maturity is rejected (no Math.max(1,...) clamp).
 *   - Missing / malformed / non-positive / > 2 PT price ⇒ no opportunity.
 *   - With the stale instrument list and no price source, scan() returns []
 *     and makes ZERO external requests.
 *   - No synthetic estimatedProfitUsd / spread / direction reaches an
 *     operational (opportunity-severity) alert.
 *   - Emitted alerts carry researchOnly: true.
 *
 * No live RPC / market API / signing / trading. $0.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import './_setup/offline-mocks.js';
import { mockFetch } from './_setup/offline-mocks.js';
import {
  PtKhypeYieldArbScanner,
  PT_KHYPE_TOKENS,
  type PtKhypeParams,
  type PtKhypeInstrument,
  type PtKhypePriceSource,
} from '../src/strategies/pt-khype-yield-arb.js';

const STRATEGY_SRC = readFileSync(
  resolve(__dirname, '..', 'src', 'strategies', 'pt-khype-yield-arb.ts'),
  'utf8',
);

const PARAMS: PtKhypeParams = {
  minYieldSpreadPct: 1.0,
  khypeFloatingYieldApr: 2.28,
  maxSizeUsd: 5_000,
};

// A fixed "now" AFTER every discovered PT-kHYPE maturity (2026-09-24).
// All three real instruments are expired at this clock.
const NOW_AFTER_ALL_EXPIRED = Date.UTC(2026, 9, 26); // 2026-10-26T00:00:00Z

// A fixed "now" BEFORE a synthetic future instrument — used to exercise the
// price-validation + alert-emission path without touching the real (expired)
// instrument list.
const NOW_BEFORE_FUTURE = Date.UTC(2026, 9, 26); // 2026-10-26T00:00:00Z
const FUTURE_INSTRUMENT: PtKhypeInstrument = {
  name: 'PT-kHYPE-TEST-2027',
  address: '0x' + 'ab'.repeat(20),
  maturity: '2027-09-24',
};

function mockSupplyResponse(totalSupplyHuman: number): { json: () => Promise<unknown> } {
  // totalSupply = totalSupplyHuman * 1e18, hex-encoded as a 32-byte int.
  const supply = BigInt(Math.round(totalSupplyHuman * 1e18));
  const hex = '0x' + supply.toString(16).padStart(64, '0');
  return { json: async () => ({ result: hex }) };
}

function makePriceSource(price: number | null): PtKhypePriceSource {
  return {
    getPtPrice: vi.fn(async () => price),
  };
}

beforeEach(() => {
  mockFetch.clear();
  // Register the HyperEVM RPC pattern so that ANY accidental fetch is
  // observable via callCount. Tests that prove "no fetch" assert callCount 0.
  mockFetch.register('rpc.hyperliquid.xyz/evm', mockSupplyResponse(10_000));
});

describe('PtKhypeYieldArbScanner — EM-STRAT-014-B2 signal-integrity quarantine', () => {

  // ── Acceptance: fabricated default price can never result in an alert ──
  it('returns [] with NO price source wired (production default) and makes zero RPC calls', async () => {
    const scanner = new PtKhypeYieldArbScanner(PARAMS); // no deps = production
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
    expect(mockFetch.callCount('rpc.hyperliquid.xyz/evm')).toBe(0);
  });

  it('strategy source contains NO hard-coded 0.98 placeholder price', () => {
    // The fabricated price constant is gone. A literal 0.98 may still appear
    // inside a comment/doc string explaining the old defect, so we assert
    // against the assignment form specifically.
    expect(STRATEGY_SRC).not.toMatch(/ptPriceEstimate\s*=\s*0\.98/);
    expect(STRATEGY_SRC).not.toMatch(/=\s*0\.98\s*;\s*\/\/\s*TODO/);
    // No other hard-coded price fallback either.
    expect(STRATEGY_SRC).not.toMatch(/ptPrice\s*=\s*0\.\d/);
  });

  // ── Acceptance: every expired maturity rejected without clamp ──────────
  it('rejects all expired instruments and makes zero RPC calls even when a price source IS provided', async () => {
    const scanner = new PtKhypeYieldArbScanner(PARAMS, {
      now: () => NOW_AFTER_ALL_EXPIRED,
      priceSource: makePriceSource(0.98),
    });
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
    expect(mockFetch.callCount('rpc.hyperliquid.xyz/evm')).toBe(0);
  });

  it('strategy source does NOT re-introduce the Math.max(1, ...) days-to-maturity clamp', () => {
    expect(STRATEGY_SRC).not.toMatch(/Math\.max\(\s*1\s*,/);
  });

  it('PT_KHYPE_TOKENS lists only expired instruments as of 2026-10-26', () => {
    // Documents the research state: all three discoveries are in the past,
    // so production scan() necessarily returns [].
    const cutoff = NOW_AFTER_ALL_EXPIRED;
    for (const pt of PT_KHYPE_TOKENS) {
      const ms = new Date(pt.maturity + 'T00:00:00Z').getTime();
      expect(ms).toBeLessThan(cutoff);
    }
  });

  // ── Acceptance: missing/malformed/non-positive/stale/mismatched price ⇒ no opportunity ──
  it('rejects a null PT price (source reports unavailable)', async () => {
    const scanner = new PtKhypeYieldArbScanner(PARAMS, {
      now: () => NOW_BEFORE_FUTURE,
      instruments: [FUTURE_INSTRUMENT],
      priceSource: makePriceSource(null),
      fetch: (async () => mockSupplyResponse(10_000)) as unknown as typeof fetch,
    });
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  it('rejects a NaN PT price', async () => {
    const scanner = new PtKhypeYieldArbScanner(PARAMS, {
      now: () => NOW_BEFORE_FUTURE,
      instruments: [FUTURE_INSTRUMENT],
      priceSource: makePriceSource(NaN),
      fetch: (async () => mockSupplyResponse(10_000)) as unknown as typeof fetch,
    });
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  it('rejects a non-positive PT price (0 and negative)', async () => {
    for (const bad of [0, -0.5, -1]) {
      const scanner = new PtKhypeYieldArbScanner(PARAMS, {
        now: () => NOW_BEFORE_FUTURE,
        instruments: [FUTURE_INSTRUMENT],
        priceSource: makePriceSource(bad),
        fetch: (async () => mockSupplyResponse(10_000)) as unknown as typeof fetch,
      });
      const alerts = await scanner.scan();
      expect(alerts).toEqual([]);
    }
  });

  it('rejects an implausible PT price (> 2 × kHYPE — mismatched market data)', async () => {
    const scanner = new PtKhypeYieldArbScanner(PARAMS, {
      now: () => NOW_BEFORE_FUTURE,
      instruments: [FUTURE_INSTRUMENT],
      priceSource: makePriceSource(3),
      fetch: (async () => mockSupplyResponse(10_000)) as unknown as typeof fetch,
    });
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  it('skips instruments with total supply < 1 (empty / malformed market)', async () => {
    const scanner = new PtKhypeYieldArbScanner(PARAMS, {
      now: () => NOW_BEFORE_FUTURE,
      instruments: [FUTURE_INSTRUMENT],
      priceSource: makePriceSource(0.98),
      fetch: (async () => mockSupplyResponse(0.5)) as unknown as typeof fetch,
    });
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  // ── Acceptance: emitted alerts are research-only, never operational ─────
  it('emits an alert with researchOnly=true and a real (non-fabricated) ptPrice when a validated source is injected', async () => {
    // Price 0.95 with ~333-day maturity ⇒ implied ≈ 5.77% APR, spread ≈ 3.49%
    // (above the 1% threshold), so an alert is emitted.
    const scanner = new PtKhypeYieldArbScanner(PARAMS, {
      now: () => NOW_BEFORE_FUTURE,
      instruments: [FUTURE_INSTRUMENT],
      priceSource: makePriceSource(0.95),
      fetch: (async () => mockSupplyResponse(10_000)) as unknown as typeof fetch,
    });
    const alerts = await scanner.scan();
    expect(alerts).toHaveLength(1);
    const a = alerts[0];
    expect(a.researchOnly).toBe(true);
    expect(a.ptPrice).toBe(0.95);          // from the injected source, not fabricated
    expect(a.daysToMaturity).toBeGreaterThan(0); // no clamp
    // daysToMaturity ≈ (2027-09-24 - 2026-10-26) ≈ 333 days
    expect(a.daysToMaturity).toBeCloseTo(333, 0);
    expect(a.estimatedProfitUsd).toBeGreaterThan(0);
    expect(typeof a.direction).toBe('string');
  });

  it('skips when the yield spread is below minYieldSpreadPct', async () => {
    // Price 0.985 with ~333-day maturity ⇒ implied ≈ 1.67% APR, spread ≈ -0.61%
    // (|spread| < 1% threshold), so no alert is emitted.
    const scanner = new PtKhypeYieldArbScanner(PARAMS, {
      now: () => NOW_BEFORE_FUTURE,
      instruments: [FUTURE_INSTRUMENT],
      priceSource: makePriceSource(0.985),
      fetch: (async () => mockSupplyResponse(10_000)) as unknown as typeof fetch,
    });
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  // ── Acceptance: no unnecessary external requests when no valid instruments ──
  it('makes zero RPC calls when the instrument list is empty', async () => {
    const scanner = new PtKhypeYieldArbScanner(PARAMS, {
      now: () => NOW_BEFORE_FUTURE,
      instruments: [],
      priceSource: makePriceSource(0.98),
    });
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
    expect(mockFetch.callCount('rpc.hyperliquid.xyz/evm')).toBe(0);
  });

  it('makes zero RPC calls when a price source is wired but every instrument is expired', async () => {
    const scanner = new PtKhypeYieldArbScanner(PARAMS, {
      now: () => NOW_AFTER_ALL_EXPIRED,
      priceSource: makePriceSource(0.98),
    });
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
    expect(mockFetch.callCount('rpc.hyperliquid.xyz/evm')).toBe(0);
  });

  // ── Interface / Strategy contract ──────────────────────────────────────
  it('implements Strategy interface', () => {
    const scanner = new PtKhypeYieldArbScanner(PARAMS);
    expect(scanner.id).toBe('pt_khype_yield_arb');
    expect(scanner.landscape).toBe('F_perps_funding');
  });

  it('riskParams returns valid params', () => {
    const scanner = new PtKhypeYieldArbScanner(PARAMS);
    const rp = scanner.riskParams();
    expect(rp.maxSizeUsd).toBe(5_000);
    expect(rp.maxConcurrent).toBe(1);
  });

  it('scan returns an array (fail-closed [])', async () => {
    const scanner = new PtKhypeYieldArbScanner(PARAMS);
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
    expect(results).toEqual([]);
  });
});
