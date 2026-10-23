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

  it('placeArbitrageOrder with intent "close" is risk-reducing and does NOT require authorization', async () => {
    // Documented semantics (VooiExecutor.closeArb): legs carry reduceOnly:true,
    // so close-intent orders can only shrink/flatten exposure. Deliberately
    // usable without execution authorization.
    delete process.env[EXECUTION_AUTH_ENV_VAR];
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
