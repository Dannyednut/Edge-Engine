import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BackpackClient } from '../src/index.js';
import {
  EXECUTION_AUTH_ENV_VAR,
  ExecutionNotAuthorizedError,
  setExecutionClockForTesting,
  resetExecutionClockForTesting,
} from '@edge/risk';

// EM-STRAT-012 Phase-0 sink tests for the dormant BackpackClient.placeOrder
// submission sink. Fully offline: the client's signedRequest path throws
// "not yet implemented" before any HTTP, so we assert GUARD IDENTITY —
// an unauthorized call fails with ExecutionNotAuthorizedError (guard fired
// before the sink), and an authorized or risk-reducing call fails with the
// client's own not-implemented error (guard allowed it through to the sink).
// The fixture credentials below are fake, in-memory test values — never real
// secrets, never written to any file.

const FIXED_NOW = 1_700_000_000_000;

function makeClient(): BackpackClient {
  return new BackpackClient({ apiKey: 'test-key', apiSecret: 'test-secret' });
}

describe('BackpackClient.placeOrder sink — execution guard (EM-STRAT-012)', () => {
  beforeEach(() => {
    setExecutionClockForTesting(() => FIXED_NOW);
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

  it('placeOrder (risk-increasing) is BLOCKED without authorization — guard fires before the sink', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    try {
      await client.placeOrder(ORDER);
      expect.fail('placeOrder should have been blocked');
    } catch (e: any) {
      // Must be the GUARD error, not the client's not-implemented error —
      // proving containment fires before any submission attempt.
      expect(e.name).toBe('ExecutionNotAuthorizedError');
    }
  });

  it('placeOrder proceeds past the guard with the backpack-client:place-order scope', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, JSON.stringify({
      authId: 'test', expiresAtMs: FIXED_NOW + 60_000, scopes: ['backpack-client:place-order'],
    }));
    const client = makeClient();
    // Guard passes; the client's own unimplemented-signing error is the
    // expected next failure (offline-safe, no HTTP).
    await expect(client.placeOrder(ORDER)).rejects.toThrow(/not yet implemented/);
  });

  it('SAFETY-POSITIVE: a reduceOnly order (risk-reducing) is usable WITHOUT authorization', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    // reduceOnly:true classifies the order risk-reducing — the guard is
    // skipped and the call proceeds to the client sink (not-implemented).
    await expect(client.placeOrder({ ...ORDER, side: 'Ask', reduceOnly: true }))
      .rejects.toThrow(/not yet implemented/);
  });

  it('SAFETY-POSITIVE: cancelOrder is usable WITHOUT authorization', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await expect(client.cancelOrder('order-1', 'SOL_USDC'))
      .rejects.toThrow(/not yet implemented/);
  });
});
