import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PumpApiClient } from '../src/index.js';
import {
  EXECUTION_AUTH_ENV_VAR,
  ExecutionNotAuthorizedError,
  setExecutionClockForTesting,
  resetExecutionClockForTesting,
} from '@edge/risk';

// EM-STRAT-012 Phase-0 sink tests for the dormant PumpApiClient
// atomicTwoLegArb submission sink. All HTTP is intercepted via the injected
// fetchImpl (offline, deterministic). The fixture apiKey is a fake in-memory
// test value — never a real credential, never written to any file.

const FIXED_NOW = 1_700_000_000_000;

const ARB_PARAMS = {
  mint: 'TestMint1111111111111111111111111111111111',
  buyPool: { poolId: 'pool-a' },
  sellPool: { poolId: 'pool-b' },
  quoteAmountIn: 1,
  minBaseOut: 0.5,
  minQuoteOut: 1.1,
};

describe('PumpApiClient.atomicTwoLegArb sink — execution guard (EM-STRAT-012)', () => {
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

  function makeClient(): PumpApiClient {
    // apiKey mode satisfies isLightning (atomicTwoLegArb's own precondition).
    // The value is a fake test fixture, not a real credential.
    return new PumpApiClient({ apiKey: 'fake-test-api-key-not-real', fetchImpl });
  }

  it('atomicTwoLegArb is BLOCKED without authorization — zero HTTP calls', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await expect(client.atomicTwoLegArb(ARB_PARAMS)).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('atomicTwoLegArb proceeds with the pumpapi-client:atomic-two-leg-arb scope', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, JSON.stringify({
      authId: 'test', expiresAtMs: FIXED_NOW + 60_000, scopes: ['pumpapi-client:atomic-two-leg-arb'],
    }));
    const client = makeClient();
    const res = await client.atomicTwoLegArb(ARB_PARAMS);
    expect((res as any).signature).toBe('test-sig');
    expect(fetchImpl.calls.length).toBe(1);
  });

  it('read-only getTokenInfo is usable WITHOUT authorization', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await client.getTokenInfo('TestMint');
    expect(fetchImpl.calls.length).toBe(1);
  });
});
