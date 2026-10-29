import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BackpackClient } from '../src/index.js';
import {
  EXECUTION_AUTH_ENV_VAR,
  ExecutionNotAuthorizedError,
  setExecutionClockForTesting,
  resetExecutionClockForTesting,
} from '@edge/risk';

// EM-STRAT-012 Phase-0 sink tests + EM-STRAT-012-R2 (work order C) for the
// dormant BackpackClient.placeOrder submission sink. Fully offline: the
// client's signedRequest path throws "not yet implemented" before any HTTP,
// so we assert GUARD IDENTITY — an unauthorized call fails with
// ExecutionNotAuthorizedError (guard fired before the sink), and an
// authorized call fails with the client's own not-implemented error (guard
// allowed it through to the sink).
//
// R2 work order C: the previous reduceOnly:true exemption (venue-semantics
// based, unevidenced) was REMOVED. EVERY order — including reduceOnly ones —
// requires the 'backpack-client:place-order' scope. A recording fetchImpl is
// injected and asserted to receive ZERO calls on denial.
//
// The fixture credentials below are fake, in-memory test values — never real
// secrets, never written to any file.

const FIXED_NOW = 1_700_000_000_000;

function makeRecordingFetch() {
  const calls: Array<{ url: string; init: any }> = [];
  const impl = (async (url: string | URL | Request, init?: any) => {
    calls.push({ url: typeof url === 'string' ? url : url.toString(), init });
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '{}',
    } as any;
  }) as any;
  impl.calls = calls;
  return impl;
}

function makeClient(fetchImpl?: typeof fetch): BackpackClient {
  return new BackpackClient({ apiKey: 'test-key', apiSecret: 'test-secret', fetchImpl });
}

function authFor(...scopes: string[]): string {
  return JSON.stringify({ authId: 'test', expiresAtMs: FIXED_NOW + 60_000, scopes });
}

describe('BackpackClient.placeOrder sink — execution guard (EM-STRAT-012 + R2)', () => {
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

  const ORDER = {
    symbol: 'SOL_USDC',
    side: 'Bid' as const,
    orderType: 'Market' as const,
    quantity: '1',
  };

  it('placeOrder (risk-increasing) is BLOCKED without authorization — guard fires before the sink, zero HTTP', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient(fetchImpl);
    try {
      await client.placeOrder(ORDER);
      expect.fail('placeOrder should have been blocked');
    } catch (e: any) {
      // Must be the GUARD error, not the client's not-implemented error —
      // proving containment fires before any submission attempt.
      expect(e.name).toBe('ExecutionNotAuthorizedError');
    }
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('placeOrder proceeds past the guard with the backpack-client:place-order scope', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('backpack-client:place-order'));
    const client = makeClient(fetchImpl);
    // Guard passes; the client's own unimplemented-signing error is the
    // expected next failure (offline-safe, no HTTP).
    await expect(client.placeOrder(ORDER)).rejects.toThrow(/not yet implemented/);
  });

  it('R2 work order C: a reduceOnly:true order is BLOCKED without authorization — zero HTTP (exemption removed)', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient(fetchImpl);
    // The old exemption let reduceOnly orders through unevidenced; the
    // conservative VOOI standard now applies to EVERY order.
    try {
      await client.placeOrder({ ...ORDER, side: 'Ask', reduceOnly: true });
      expect.fail('reduceOnly placeOrder should have been blocked');
    } catch (e: any) {
      expect(e.name).toBe('ExecutionNotAuthorizedError');
    }
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('R2 work order C: a reduceOnly:true order proceeds with the proper scope (guard passes to the sink)', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('backpack-client:place-order'));
    const client = makeClient(fetchImpl);
    await expect(client.placeOrder({ ...ORDER, side: 'Ask', reduceOnly: true }))
      .rejects.toThrow(/not yet implemented/);
  });

  it('R2: authorization is re-checked per call — the same client instance is denied after the authorization lapses', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('backpack-client:place-order'));
    const client = makeClient(fetchImpl);
    await expect(client.placeOrder(ORDER)).rejects.toThrow(/not yet implemented/);
    // Authorization lapses (clock advances past expiry).
    setExecutionClockForTesting(() => FIXED_NOW + 61_000);
    try {
      await client.placeOrder({ ...ORDER, symbol: 'TSLA.US_USDC_PERP' });
      expect.fail('lapsed placeOrder should have been blocked');
    } catch (e: any) {
      expect(e.name).toBe('ExecutionNotAuthorizedError');
    }
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('R2: an unrelated scope does NOT authorize placeOrder (scoped control)', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('vooi:place-arbitrage-order', 'pumpapi-client:buy'));
    const client = makeClient(fetchImpl);
    try {
      await client.placeOrder(ORDER);
      expect.fail('placeOrder with an unrelated scope should have been blocked');
    } catch (e: any) {
      expect(e.name).toBe('ExecutionNotAuthorizedError');
    }
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('SAFETY-POSITIVE: cancelOrder is usable WITHOUT authorization', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient(fetchImpl);
    await expect(client.cancelOrder('order-1', 'SOL_USDC'))
      .rejects.toThrow(/not yet implemented/);
  });
});
