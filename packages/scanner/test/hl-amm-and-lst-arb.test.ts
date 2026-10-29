import { describe, it, expect } from 'vitest';
import { HlAmmArbScanner } from '../src/strategies/hl-amm-arb-scanner.js';
import { HlLstArbScanner, type HlLstArbDeps } from '../src/strategies/hl-lst-arb-scanner.js';

// EM-STRAT-005 §3: tests MUST NOT trigger live RPC. We inject a mock rpcCall
// for HlLstArbScanner tests that returns '0x' (empty result) — the scanner
// fail-closes and returns []. HlAmmArbScanner does not yet have an
// injectable seam; we exercise only its non-RPC methods (interface and
// riskParams) here. The scan() method is exercised by other tests where
// a seam exists or by integration tests outside the unit suite.

// Mock deps for HlLstArbScanner: every RPC call returns '0x' → fail-closed.
const NO_RPC_DEPS: HlLstArbDeps = {
  rpcCall: async () => ({ result: '0x' }),
  now: () => 1_700_000_000_000,
};

describe('HlAmmArbScanner', () => {
  const params = {
    minSpreadPct: 0.1,
    minPoolLiquidityUsd: 100,
    maxSizeUsd: 5_000,
  };

  it('implements Strategy interface', () => {
    const scanner = new HlAmmArbScanner(params);
    expect(scanner.id).toBe('hl_amm_arb');
    expect(scanner.landscape).toBe('C_dex_dex');
  });

  it('riskParams flows maxSizeUsd', () => {
    const scanner = new HlAmmArbScanner(params);
    const rp = scanner.riskParams();
    expect(rp.maxSizeUsd).toBe(5_000);
    expect(rp.maxConcurrent).toBe(2);
  });

  // EM-STRAT-005 §3: 'scan returns array' test removed — it would call
  // live HyperEVM RPC. HlAmmArbScanner does not yet expose an injectable
  // test seam; adding one is out of scope for EM-STRAT-005 §3 (which
  // targets the strategy-labeling.test.ts Euler scan path).
});

describe('HlLstArbScanner', () => {
  const params = {
    minDiscountPct: 0.1,
    maxSizeUsd: 5_000,
    preferredFeeTier: 100,
    minNetDiscountPct: 0.30,
  };

  it('implements Strategy interface', () => {
    const scanner = new HlLstArbScanner(params, NO_RPC_DEPS);
    expect(scanner.id).toBe('hl_lst_arb');
    expect(scanner.landscape).toBe('C_dex_dex');
  });

  it('riskParams flows maxSizeUsd', () => {
    const scanner = new HlLstArbScanner(params, NO_RPC_DEPS);
    const rp = scanner.riskParams();
    expect(rp.maxSizeUsd).toBe(5_000);
    expect(rp.maxConcurrent).toBe(1);
  });

  it('scan returns array (fail-closed [] when RPC unavailable — no live RPC, EM-STRAT-005 §3)', async () => {
    // EM-STRAT-005 §3: NO live RPC. The mock rpcCall returns '0x' for every
    // call, so fetchRedemptionAnchor returns null and the scanner fail-closes.
    const scanner = new HlLstArbScanner(params, NO_RPC_DEPS);
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0); // fail-closed
  });
});
