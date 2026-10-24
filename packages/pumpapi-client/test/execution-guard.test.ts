import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PumpApiClient } from '../src/index.js';
import {
  EXECUTION_AUTH_ENV_VAR,
  ExecutionNotAuthorizedError,
  setExecutionClockForTesting,
  resetExecutionClockForTesting,
} from '@edge/risk';

// EM-STRAT-012 Phase-0 R1 sink tests for the PumpApiClient. Every
// transaction-producing public method is guarded with its own narrow scope.
// atomicTwoLegArb does NOT delegate through actions() — it calls this.post()
// directly so neither guard bypasses the other. claimCashback is SAFETY-
// POSITIVE (recovers owed cashback; cannot increase exposure) and ungated.
// Read-only methods (getBalances, getTokenInfo) are ungated.
//
// All HTTP is intercepted via the injected fetchImpl (offline, deterministic).
// The fixture apiKey is a fake in-memory test value — never a real credential,
// never written to any file.

const FIXED_NOW = 1_700_000_000_000;

const ARB_PARAMS = {
  mint: 'TestMint1111111111111111111111111111111111',
  buyPool: { poolId: 'pool-a' },
  sellPool: { poolId: 'pool-b' },
  quoteAmountIn: 1,
  minBaseOut: 0.5,
  minQuoteOut: 1.1,
};

function makeRecordingFetch() {
  const calls: Array<{ url: string; init: any }> = [];
  const impl = (async (url: string | URL | Request, init?: any) => {
    calls.push({ url: typeof url === 'string' ? url : url.toString(), init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ signature: 'test-sig', success: true }),
      text: async () => JSON.stringify({ signature: 'test-sig' }),
    } as any;
  }) as any;
  impl.calls = calls;
  return impl;
}

function authFor(scope: string): string {
  return JSON.stringify({ authId: 'test', expiresAtMs: FIXED_NOW + 60_000, scopes: [scope] });
}

describe('PumpApiClient action-method guards — R1 full coverage (EM-STRAT-012)', () => {
  let fetchImpl: ReturnType<typeof makeRecordingFetch>;

  beforeEach(() => {
    setExecutionClockForTesting(() => FIXED_NOW);
    fetchImpl = makeRecordingFetch();
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    resetExecutionClockForTesting();
    vi.unstubAllEnvs();
  });

  function makeClient(): PumpApiClient {
    // apiKey mode satisfies isLightning (atomicTwoLegArb's own precondition).
    return new PumpApiClient({ apiKey: 'fake-test-api-key-not-real', fetchImpl });
  }

  // ── buy ────────────────────────────────────────────────────────────────

  it('buy is BLOCKED without authorization — zero HTTP calls', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await expect(client.buy({
      action: 'buy', mint: 'Mint', amount: 1,
    } as any)).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('buy proceeds with the pumpapi-client:buy scope', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('pumpapi-client:buy'));
    const client = makeClient();
    const res = await client.buy({ action: 'buy', mint: 'Mint', amount: 1 } as any);
    expect((res as any).signature).toBe('test-sig');
    expect(fetchImpl.calls.length).toBe(1);
  });

  // ── sell ───────────────────────────────────────────────────────────────

  it('sell is BLOCKED without authorization — zero HTTP calls', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await expect(client.sell({
      action: 'sell', mint: 'Mint', amount: 1,
    } as any)).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('sell proceeds with the pumpapi-client:sell scope', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('pumpapi-client:sell'));
    const client = makeClient();
    const res = await client.sell({ action: 'sell', mint: 'Mint', amount: 1 } as any);
    expect((res as any).signature).toBe('test-sig');
    expect(fetchImpl.calls.length).toBe(1);
  });

  // ── actions ────────────────────────────────────────────────────────────

  it('actions (arbitrary action array) is BLOCKED without authorization — zero HTTP calls', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await expect(client.actions({
      actions: [{ action: 'buy', mint: 'Mint', amount: 1 } as any],
    })).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('actions proceeds with the pumpapi-client:actions scope', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('pumpapi-client:actions'));
    const client = makeClient();
    const res = await client.actions({
      actions: [{ action: 'buy', mint: 'Mint', amount: 1 } as any],
    });
    expect((res as any).signature).toBe('test-sig');
    expect(fetchImpl.calls.length).toBe(1);
  });

  // ── jitoBundle ─────────────────────────────────────────────────────────

  it('jitoBundle is BLOCKED without authorization — zero HTTP calls', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await expect(client.jitoBundle({
      transactions: [{ action: 'buy' }], jitoTip: 0.0002,
    })).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('jitoBundle proceeds with the pumpapi-client:jito-bundle scope', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('pumpapi-client:jito-bundle'));
    const client = makeClient();
    const res = await client.jitoBundle({
      transactions: [{ action: 'buy' }], jitoTip: 0.0002,
    });
    // The mock fetch returns { signature: 'test-sig' } for all responses;
    // we only need to verify the call proceeded past the guard.
    expect(res).toBeDefined();
    expect(fetchImpl.calls.length).toBe(1);
  });

  // ── migrate ────────────────────────────────────────────────────────────

  it('migrate is BLOCKED without authorization — zero HTTP calls', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await expect(client.migrate('Mint')).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('migrate proceeds with the pumpapi-client:migrate scope', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('pumpapi-client:migrate'));
    const client = makeClient();
    const res = await client.migrate('Mint');
    expect((res as any).signature).toBe('test-sig');
    expect(fetchImpl.calls.length).toBe(1);
  });

  // ── burn ───────────────────────────────────────────────────────────────

  it('burn is BLOCKED without authorization — zero HTTP calls', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await expect(client.burn('Mint')).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('burn proceeds with the pumpapi-client:burn scope', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('pumpapi-client:burn'));
    const client = makeClient();
    const res = await client.burn('Mint');
    expect((res as any).signature).toBe('test-sig');
    expect(fetchImpl.calls.length).toBe(1);
  });

  // ── wrapSol ────────────────────────────────────────────────────────────

  it('wrapSol is BLOCKED without authorization — zero HTTP calls', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await expect(client.wrapSol(1)).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('wrapSol proceeds with the pumpapi-client:wrap-sol scope', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('pumpapi-client:wrap-sol'));
    const client = makeClient();
    const res = await client.wrapSol(1);
    expect((res as any).signature).toBe('test-sig');
    expect(fetchImpl.calls.length).toBe(1);
  });

  // ── transfer ───────────────────────────────────────────────────────────

  it('transfer is BLOCKED without authorization — zero HTTP calls', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await expect(client.transfer('Mint', 'ToAddr', 1)).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('transfer proceeds with the pumpapi-client:transfer scope', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('pumpapi-client:transfer'));
    const client = makeClient();
    const res = await client.transfer('Mint', 'ToAddr', 1);
    expect((res as any).signature).toBe('test-sig');
    expect(fetchImpl.calls.length).toBe(1);
  });

  // ── claimCashback (SAFETY-POSITIVE) ────────────────────────────────────

  it('SAFETY-POSITIVE: claimCashback is usable WITHOUT authorization (recovers owed cashback)', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    const res = await client.claimCashback();
    expect((res as any).signature).toBe('test-sig');
    expect(fetchImpl.calls.length).toBe(1);
  });

  // ── Read-only methods (ungated) ────────────────────────────────────────

  it('read-only getBalances is usable WITHOUT authorization', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await client.getBalances();
    expect(fetchImpl.calls.length).toBe(1);
  });

  it('read-only getTokenInfo is usable WITHOUT authorization', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await client.getTokenInfo('Mint');
    expect(fetchImpl.calls.length).toBe(1);
  });

  // ── atomicTwoLegArb (R1: does NOT delegate through actions()) ───────────

  it('atomicTwoLegArb is BLOCKED without authorization — zero HTTP calls', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await expect(client.atomicTwoLegArb(ARB_PARAMS)).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('atomicTwoLegArb proceeds with the pumpapi-client:atomic-two-leg-arb scope (does NOT require actions scope)', async () => {
    // R1: atomicTwoLegArb calls this.post() directly, NOT this.actions().
    // Therefore it requires ONLY its own scope, NOT the actions scope.
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('pumpapi-client:atomic-two-leg-arb'));
    const client = makeClient();
    const res = await client.atomicTwoLegArb(ARB_PARAMS);
    expect((res as any).signature).toBe('test-sig');
    expect(fetchImpl.calls.length).toBe(1);
  });

  it('atomicTwoLegArb with ONLY the actions scope is DENIED (scopes are narrow, no bypass via actions)', async () => {
    // R1: having the actions scope does NOT authorize atomicTwoLegArb.
    // The two methods are independently guarded.
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('pumpapi-client:actions'));
    const client = makeClient();
    await expect(client.atomicTwoLegArb(ARB_PARAMS)).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('actions with ONLY the atomic-two-leg-arb scope is DENIED (no reverse bypass)', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('pumpapi-client:atomic-two-leg-arb'));
    const client = makeClient();
    await expect(client.actions({
      actions: [{ action: 'buy', mint: 'Mint', amount: 1 } as any],
    })).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  // ── Scoped positive control ───────────────────────────────────────────

  it('scoped positive control: authorization for one action does NOT enable any other', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('pumpapi-client:buy'));
    const client = makeClient();
    // buy is authorized.
    await client.buy({ action: 'buy', mint: 'Mint', amount: 1 } as any);
    expect(fetchImpl.calls.length).toBe(1);
    fetchImpl.calls.length = 0;
    // sell is NOT authorized (different scope).
    await expect(client.sell({ action: 'sell', mint: 'Mint', amount: 1 } as any))
      .rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
    // transfer is NOT authorized.
    await expect(client.transfer('Mint', 'ToAddr', 1)).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
    // claimCashback IS usable (safety-positive, no scope needed).
    await client.claimCashback();
    expect(fetchImpl.calls.length).toBe(1);
  });

  // ── Phase-0.5: hard-private transport helper (work order C) ───────────

  it('Phase-0.5 hard privacy: the old post() runtime property DOES NOT EXIST on the instance', () => {
    const client = makeClient() as any;
    // TS `private` compiled to a regular own property would let untyped
    // callers submit arbitrary action bodies. #post is not an own property.
    expect(client.post).toBeUndefined();
    const ownProps = Object.getOwnPropertyNames(client);
    expect(ownProps).not.toContain('post');
    expect(ownProps).not.toContain('#post');
  });

  it('Phase-0.5 hard privacy: an untyped caller cannot invoke the transport helper — zero HTTP calls', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient() as any;
    expect(typeof client.post).toBe('undefined');
    try {
      await client.post?.({ action: 'buy', mint: 'Mint', amount: 1 });
    } catch {
      // TypeError or no-op — either way, no HTTP happened.
    }
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('Phase-0.5 expiry: the same client instance is denied after authorization lapses (per-call re-check)', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('pumpapi-client:buy'));
    const client = makeClient();
    await client.buy({ action: 'buy', mint: 'Mint', amount: 1 } as any);
    expect(fetchImpl.calls.length).toBe(1);
    setExecutionClockForTesting(() => FIXED_NOW + 61_000);
    await expect(client.buy({ action: 'buy', mint: 'Mint', amount: 1 } as any))
      .rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(1);
  });

  // ── Phase-0.5: generatePumpWallet credential-exposure gate ────────────

  it('Phase-0.5: generatePumpWallet is BLOCKED without authorization — zero HTTP calls (no key material transmitted)', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const res = await import('../src/index.js');
    await expect(res.generatePumpWallet({
      existingPrivateKey: 'fake-test-key-not-real',
      fetchImpl,
    })).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('Phase-0.5: generatePumpWallet proceeds with the pumpapi-client:generate-wallet scope (mocked transport)', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('pumpapi-client:generate-wallet'));
    const res = await import('../src/index.js');
    const out = await res.generatePumpWallet({
      generateApiKey: true,
      fetchImpl,
    });
    expect(out).toBeDefined();
    expect(fetchImpl.calls.length).toBe(1);
    expect(fetchImpl.calls[0].url).toContain('wallet.pumpapi.io');
  });
});
