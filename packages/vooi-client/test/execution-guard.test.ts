import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VooiClient } from '../src/index.js';
import {
  EXECUTION_AUTH_ENV_VAR,
  ExecutionNotAuthorizedError,
  setExecutionClockForTesting,
  resetExecutionClockForTesting,
} from '@edge/risk';

// EM-STRAT-012 Phase-0 sink-class tests for VooiClient — the shared HTTP
// choke point. All HTTP is intercepted via the injected fetchImpl (offline,
// deterministic). All authorization is in-memory via vi.stubEnv.

const FIXED_NOW = 1_700_000_000_000;

function makeRecordingFetch() {
  const calls: Array<{ url: string; init: any }> = [];
  const impl = (async (url: string | URL | Request, init?: any) => {
    calls.push({ url: typeof url === 'string' ? url : url.toString(), init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'test-order-1', status: 'pending', pairs: [], items: [] }),
      text: async () => JSON.stringify({}),
    } as any;
  }) as any;
  impl.calls = calls;
  return impl;
}

const ORDER_REQ = {
  primary: { asset: 'BTC', exchange: 'hyperliquid', side: 'buy' as const, size: 100, type: 'market' as const },
  hedge: { asset: 'BTC', exchange: 'binance', side: 'sell' as const, size: 100, type: 'market' as const },
  partialFillPolicy: 'fullFill' as const,
  hedgeFailurePolicy: 'alertAndHold' as const,
};

// R1 close-intent test fixtures: both legs carry reduceOnly === true.
// This is the ONLY validated shape that qualifies for the close exemption.
const CLOSE_REQ_BOTH_REDUCE = {
  primary: { asset: 'BTC', exchange: 'hyperliquid', side: 'sell' as const, size: 100, type: 'market' as const, reduceOnly: true },
  hedge: { asset: 'BTC', exchange: 'binance', side: 'buy' as const, size: 100, type: 'market' as const, reduceOnly: true },
  partialFillPolicy: 'fullFill' as const,
  hedgeFailurePolicy: 'alertAndHold' as const,
};

describe('VooiClient submission sinks — execution guard (EM-STRAT-012)', () => {
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

  function makeClient(): VooiClient {
    return new VooiClient({ apiToken: 'test-token', fetchImpl });
  }

  it('placeArbitrageOrder (open intent) is BLOCKED without authorization — zero HTTP calls', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await expect(client.placeArbitrageOrder(ORDER_REQ)).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('placeArbitrageOrder (open intent) proceeds with a valid scoped authorization', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, JSON.stringify({
      authId: 'test', expiresAtMs: FIXED_NOW + 60_000, scopes: ['vooi:place-arbitrage-order'],
    }));
    const client = makeClient();
    const order = await client.placeArbitrageOrder(ORDER_REQ);
    expect(order.id).toBe('test-order-1');
    expect(fetchImpl.calls.length).toBe(1);
    expect(fetchImpl.calls[0].url).toContain('/arbitrage-orders');
  });

  it('R1 close-intent: a VALID two-leg reduce-only close proceeds WITHOUT authorization', async () => {
    // EM-STRAT-012 Phase-0 R1: caller-supplied intent:"close" is NOT trusted
    // on its own. BOTH legs must carry reduceOnly === true. With both legs
    // reduce-only, the venue can only shrink/flatten exposure — the close
    // exemption applies and no execution authorization is required.
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    const order = await client.placeArbitrageOrder(CLOSE_REQ_BOTH_REDUCE, { intent: 'close' });
    expect(order.id).toBe('test-order-1');
    expect(fetchImpl.calls.length).toBe(1);
  });

  it('R1 close-intent: missing reduceOnly on the PRIMARY leg DENIES — zero HTTP calls', async () => {
    // intent:"close" but primary.reduceOnly is undefined → not a validated
    // close → falls through to the open-intent guard → denied without auth.
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    const req = {
      ...CLOSE_REQ_BOTH_REDUCE,
      primary: { ...CLOSE_REQ_BOTH_REDUCE.primary, reduceOnly: undefined },
    };
    await expect(client.placeArbitrageOrder(req, { intent: 'close' })).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('R1 close-intent: missing reduceOnly on the HEDGE leg DENIES — zero HTTP calls', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    const req = {
      ...CLOSE_REQ_BOTH_REDUCE,
      hedge: { ...CLOSE_REQ_BOTH_REDUCE.hedge, reduceOnly: undefined },
    };
    await expect(client.placeArbitrageOrder(req, { intent: 'close' })).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('R1 close-intent: reduceOnly:false on either leg DENIES — zero HTTP calls', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    const req = {
      ...CLOSE_REQ_BOTH_REDUCE,
      primary: { ...CLOSE_REQ_BOTH_REDUCE.primary, reduceOnly: false },
    };
    await expect(client.placeArbitrageOrder(req, { intent: 'close' })).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('R1 close-intent: an UNAUTHORIZED close-intent order with non-reduce-only legs is DENIED (intent label alone is not proof)', async () => {
    // This is the R1 regression: previously, intent:"close" alone bypassed
    // the guard. Now the guard validates both legs. A non-reduce-only close
    // is treated as an opening order and requires authorization.
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await expect(client.placeArbitrageOrder(ORDER_REQ, { intent: 'close' })).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('R1 close-intent: a non-reduce-only close-intent order WITH open-intent scope PROCEEDS', async () => {
    // If the caller has the open-intent scope, the order proceeds regardless
    // of intent label (the close exemption is an optimization, not a
    // restriction). This proves the guard falls through correctly.
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, JSON.stringify({
      authId: 'test', expiresAtMs: FIXED_NOW + 60_000, scopes: ['vooi:place-arbitrage-order'],
    }));
    const client = makeClient();
    const order = await client.placeArbitrageOrder(ORDER_REQ, { intent: 'close' });
    expect(order.id).toBe('test-order-1');
    expect(fetchImpl.calls.length).toBe(1);
  });

  it('createBot is BLOCKED without authorization — zero HTTP calls', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await expect(client.createBot({
      exchanges: ['hyperliquid'], leverage: 1, notionalUsd: 1000,
      maxHoldHours: 24, maxRoundTripCostBps: 12, categories: ['crypto'],
    })).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('createBot proceeds with the vooi:create-bot scope', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, JSON.stringify({
      authId: 'test', expiresAtMs: FIXED_NOW + 60_000, scopes: ['vooi:create-bot'],
    }));
    const client = makeClient();
    const bot = await client.createBot({
      exchanges: ['hyperliquid'], leverage: 1, notionalUsd: 1000,
      maxHoldHours: 24, maxRoundTripCostBps: 12, categories: ['crypto'],
    });
    expect(bot.id).toBe('test-order-1');
    expect(fetchImpl.calls.length).toBe(1);
  });

  it('startBot is BLOCKED without authorization — zero HTTP calls', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await expect(client.startBot('bot-1')).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('startBot proceeds with the vooi:start-bot scope', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, JSON.stringify({
      authId: 'test', expiresAtMs: FIXED_NOW + 60_000, scopes: ['vooi:start-bot'],
    }));
    const client = makeClient();
    await client.startBot('bot-1');
    expect(fetchImpl.calls.length).toBe(1);
    expect(fetchImpl.calls[0].url).toContain('/bots/bot-1/start');
  });

  it('SAFETY-POSITIVE: stopBot is usable WITHOUT authorization (emergency stop)', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await client.stopBot('bot-1');
    expect(fetchImpl.calls.length).toBe(1);
    expect(fetchImpl.calls[0].url).toContain('/bots/bot-1/stop');
  });

  it('SAFETY-POSITIVE: cancelArbitrageOrder is usable WITHOUT authorization', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await client.cancelArbitrageOrder('order-1');
    expect(fetchImpl.calls.length).toBe(1);
  });

  it('SAFETY-POSITIVE: deleteBot is usable WITHOUT authorization (cleanup)', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await client.deleteBot('bot-1');
    expect(fetchImpl.calls.length).toBe(1);
  });

  it('read-only scanArbitrage is usable WITHOUT authorization', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await client.scanArbitrage({ limit: 5 });
    expect(fetchImpl.calls.length).toBe(1);
  });
});
