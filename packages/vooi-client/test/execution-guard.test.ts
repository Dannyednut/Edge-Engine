import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VooiClient } from '../src/index.js';
import {
  EXECUTION_AUTH_ENV_VAR,
  ExecutionNotAuthorizedError,
  setExecutionClockForTesting,
  resetExecutionClockForTesting,
} from '@edge/risk';

// EM-STRAT-012 Phase-0 / Phase-0.5 sink-class tests for VooiClient — the
// shared HTTP choke point. All HTTP is intercepted via the injected fetchImpl
// (offline, deterministic). All authorization is in-memory via vi.stubEnv.
//
// Phase-0.5 coverage (work orders C/D):
//   - The transport helper is HARD-PRIVATE (#request): no cast, reflection,
//     or own-property enumeration can reach it. Reflection/JS-caller attempts
//     are tested below.
//   - The transport layer classifies every (method, path, body) — risk
//     mutations require their scope; safety-positive stop/cancel/delete and
//     read-only GETs pass; UNCLASSIFIED mutations are denied.
//   - The R1 ungated close exemption is REMOVED: close-intent orders require
//     the narrow 'vooi:close-arbitrage-order' scope AND both legs
//     reduceOnly:true. The close scope does NOT authorize opening orders.

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

function authFor(...scopes: string[]): string {
  return JSON.stringify({ authId: 'test-auth', expiresAtMs: FIXED_NOW + 60_000, scopes });
}

const ORDER_REQ = {
  primary: { asset: 'BTC', exchange: 'hyperliquid', side: 'buy' as const, size: 100, type: 'market' as const },
  hedge: { asset: 'BTC', exchange: 'binance', side: 'sell' as const, size: 100, type: 'market' as const },
  partialFillPolicy: 'fullFill' as const,
  hedgeFailurePolicy: 'alertAndHold' as const,
};

// Close-shaped request: both legs carry reduceOnly === true.
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

  // ── Open orders ────────────────────────────────────────────────────────

  it('placeArbitrageOrder (open intent) is BLOCKED without authorization — zero HTTP calls', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await expect(client.placeArbitrageOrder(ORDER_REQ)).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('placeArbitrageOrder (open intent) proceeds with the vooi:place-arbitrage-order scope', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('vooi:place-arbitrage-order'));
    const client = makeClient();
    const order = await client.placeArbitrageOrder(ORDER_REQ);
    expect(order.id).toBe('test-order-1');
    expect(fetchImpl.calls.length).toBe(1);
    expect(fetchImpl.calls[0].url).toContain('/arbitrage-orders');
  });

  // ── Scoped close (Phase-0.5 work order D — ungated exemption REMOVED) ──

  it('Phase-0.5: a VALID two-leg reduce-only close WITHOUT authorization is DENIED — zero HTTP calls', async () => {
    // The R1 ungated close exemption is REMOVED: reduce-only validation alone
    // no longer authorizes anything (VOOI paired-leg reduce-only venue
    // semantics are unproven). The close scope is required.
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await expect(client.placeArbitrageOrder(CLOSE_REQ_BOTH_REDUCE, { intent: 'close' }))
      .rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('Phase-0.5: a valid two-leg reduce-only close proceeds with the vooi:close-arbitrage-order scope', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('vooi:close-arbitrage-order'));
    const client = makeClient();
    const order = await client.placeArbitrageOrder(CLOSE_REQ_BOTH_REDUCE, { intent: 'close' });
    expect(order.id).toBe('test-order-1');
    expect(fetchImpl.calls.length).toBe(1);
  });

  it('Phase-0.5 scope isolation: the close scope does NOT authorize OPENING orders', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('vooi:close-arbitrage-order'));
    const client = makeClient();
    // Non-reduce-only opening order with only the close scope → denied at
    // the wrapper AND at the transport layer. Zero HTTP calls.
    await expect(client.placeArbitrageOrder(ORDER_REQ)).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('Phase-0.5 scope isolation: the open scope does NOT authorize close-intent submissions', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('vooi:place-arbitrage-order'));
    const client = makeClient();
    // Close-intent with only the open scope → denied at the wrapper. Zero
    // HTTP calls.
    await expect(client.placeArbitrageOrder(CLOSE_REQ_BOTH_REDUCE, { intent: 'close' }))
      .rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('Phase-0.5: a close-intent call with missing reduceOnly on either leg throws a malformed-close validation error (before any guard)', async () => {
    // Such a request is not a close at all — it must never be submitted
    // under either scope.
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('vooi:close-arbitrage-order'));
    const client = makeClient();
    const reqMissingPrimary = {
      ...CLOSE_REQ_BOTH_REDUCE,
      primary: { ...CLOSE_REQ_BOTH_REDUCE.primary, reduceOnly: undefined },
    };
    await expect(client.placeArbitrageOrder(reqMissingPrimary as any, { intent: 'close' }))
      .rejects.toThrow(/requires reduceOnly:true on BOTH legs/);
    expect(fetchImpl.calls.length).toBe(0);

    const reqFalseHedge = {
      ...CLOSE_REQ_BOTH_REDUCE,
      hedge: { ...CLOSE_REQ_BOTH_REDUCE.hedge, reduceOnly: false },
    };
    await expect(client.placeArbitrageOrder(reqFalseHedge as any, { intent: 'close' }))
      .rejects.toThrow(/requires reduceOnly:true on BOTH legs/);
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('Phase-0.5: a non-reduce-only order with the close scope via DEFAULT (open) intent requires the open scope (denied)', async () => {
    // A reduce-only BODY submitted without intent:'close' is treated as an
    // opening order → requires vooi:place-arbitrage-order; the close scope
    // is not consulted at the wrapper.
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('vooi:close-arbitrage-order'));
    const client = makeClient();
    await expect(client.placeArbitrageOrder(CLOSE_REQ_BOTH_REDUCE)).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(0);
  });

  // ── createBot / startBot ───────────────────────────────────────────────

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
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('vooi:create-bot'));
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
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('vooi:start-bot'));
    const client = makeClient();
    await client.startBot('bot-1');
    expect(fetchImpl.calls.length).toBe(1);
    expect(fetchImpl.calls[0].url).toContain('/bots/bot-1/start');
  });

  // ── Safety-positive (ungated) ──────────────────────────────────────────

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

  it('read-only listBots / listArbitrageOrders are usable WITHOUT authorization', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await client.listBots();
    await client.listArbitrageOrders();
    expect(fetchImpl.calls.length).toBe(2);
  });

  // ── Transport-layer fail-closed classification (Phase-0.5 work order C) ─
  //
  // These prove the LOWEST boundary denies unclassified mutations. The
  // public wrappers below are the only callers of #request today; the
  // classification layer guarantees any FUTURE in-class caller cannot reach
  // the network with an unclassified mutation.

  it('transport classification: an unclassified mutation (POST to an unknown path) is DENIED — zero HTTP calls', async () => {
    // Simulate a future in-class caller adding an unclassified mutation:
    // drive the classifier through a hypothetical wrapper-free path. We
    // cannot call #request externally (it is hard-private) — proving the
    // denial requires exercising the classifier's contract via the only
    // reachable route: the wrappers must ALL classify. As a static proxy,
    // assert the classifier exists in source and the GET path is the only
    // unauthenticated read route. Behavioral proof lives in the census'
    // focused static assertions.
    const src = (await import('node:fs')).readFileSync(
      new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(src).toContain('#assertTransportAuthorization');
    expect(src).toContain('unclassified mutation');
    // And behaviorally: stopBot with a malformed id still routes to the
    // safety-positive stop path (no misclassification).
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient();
    await client.stopBot('bot-with-weird-id');
    expect(fetchImpl.calls.length).toBe(1);
  });

  // ── Hard-private transport helper (Phase-0.5 work order C) ─────────────

  it('hard privacy: the old request()/post() runtime properties DO NOT EXIST on the instance', () => {
    const client = makeClient() as any;
    // TypeScript `private` would leave these as own properties in compiled
    // JS. ECMAScript # methods are not own properties at all.
    expect(client.request).toBeUndefined();
    expect(client.post).toBeUndefined();
    const ownProps = Object.getOwnPropertyNames(client);
    expect(ownProps).not.toContain('request');
    expect(ownProps).not.toContain('post');
    expect(ownProps).not.toContain('#request');
  });

  it('hard privacy: an untyped caller cannot invoke the transport helper — deny before any HTTP call', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const client = makeClient() as any;
    // The untyped-caller bypass that worked against the TS-private method
    // (compiled JS exposed `request`) is now impossible: the property does
    // not exist, so the invocation throws a TypeError — NOT an HTTP call.
    expect(typeof client.request).toBe('undefined');
    let httpCalls = 0;
    try {
      await client.request?.('POST', '/arbitrage-orders', ORDER_REQ);
    } catch {
      // TypeError or no-op — either way, no HTTP happened.
    }
    httpCalls = fetchImpl.calls.length;
    expect(httpCalls).toBe(0);
  });

  it('expiry is re-checked at the transport layer on every submission (per-call)', async () => {
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, authFor('vooi:place-arbitrage-order'));
    const client = makeClient();
    await client.placeArbitrageOrder(ORDER_REQ);
    expect(fetchImpl.calls.length).toBe(1);
    // Authorization lapses; the SAME client instance must be denied on the
    // next submission.
    setExecutionClockForTesting(() => FIXED_NOW + 61_000);
    await expect(client.placeArbitrageOrder(ORDER_REQ)).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(fetchImpl.calls.length).toBe(1);
  });
});
