import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CexExecutor, type CexOrderParams } from '../src/cex-executor.js';
import {
  EXECUTION_AUTH_ENV_VAR,
  ExecutionNotAuthorizedError,
  loadDotEnvIntoProcessEnv,
  setExecutionClockForTesting,
  resetExecutionClockForTesting,
} from '@edge/risk';

// ─── EM-STRAT-014-B1 — CexExecutor containment acceptance tests ─────────
//
// Fully OFFLINE and deterministic: the 'ccxt' module is replaced by a
// recording fake via vi.mock, so no real CCXT class is ever instantiated,
// no API key is real, and no network request is possible (the vitest
// offline guard would block it anyway). Every risk-increasing path is
// asserted to fail closed AT THE CALL BOUNDARY — the fake's call counters
// must remain zero on every denial.
//
// This file imports cex-executor DIRECTLY by file path — the same path any
// in-repo caller must use, because the class is deliberately NOT
// re-exported from packages/executor/src/index.ts (EM-STRAT-014-B1 keeps
// the package surface minimal; containment lives at the sinks).

// vi.hoisted runs before module imports, so the mock factory below can
// close over these counters safely.
const calls = vi.hoisted(() => ({
  createOrder: 0,
  withdraw: 0,
  cancelOrder: 0,
  fetchTicker: 0,
  fetchOrderBook: 0,
  fetchBalance: 0,
  fetchPositions: 0,
  fetchDepositAddress: 0,
  lastCreateOrderArgs: null as unknown[] | null,
  lastWithdrawArgs: null as unknown[] | null,
  lastCancelArgs: null as unknown[] | null,
}));

function resetCalls(): void {
  calls.createOrder = 0;
  calls.withdraw = 0;
  calls.cancelOrder = 0;
  calls.fetchTicker = 0;
  calls.fetchOrderBook = 0;
  calls.fetchBalance = 0;
  calls.fetchPositions = 0;
  calls.fetchDepositAddress = 0;
  calls.lastCreateOrderArgs = null;
  calls.lastWithdrawArgs = null;
  calls.lastCancelArgs = null;
}

vi.mock('ccxt', () => {
  class FakeExchange {
    has = { fetchPositions: true };

    async createOrder(...args: unknown[]) {
      calls.createOrder++;
      calls.lastCreateOrderArgs = args;
      return { id: 'mock-order-1', symbol: args[0], type: args[1], side: args[2], amount: args[3] };
    }

    async withdraw(...args: unknown[]) {
      calls.withdraw++;
      calls.lastWithdrawArgs = args;
      return { id: 'mock-withdrawal-1' };
    }

    async cancelOrder(...args: unknown[]) {
      calls.cancelOrder++;
      calls.lastCancelArgs = args;
      return { id: 'mock-cancel-1' };
    }

    async fetchTicker(_symbol: string) {
      calls.fetchTicker++;
      return { last: 50_000, bid: 49_999, ask: 50_001, baseVolume: 1_234, high: 51_000, low: 49_000 };
    }

    async fetchOrderBook(_symbol: string, _limit?: number) {
      calls.fetchOrderBook++;
      return { bids: [[49_999, 1], [49_998, 2]], asks: [[50_001, 1], [50_002, 2]] };
    }

    async fetchBalance() {
      calls.fetchBalance++;
      return { total: { USDT: 1_000 }, free: { USDT: 900 }, used: { USDT: 100 } };
    }

    async fetchPositions() {
      calls.fetchPositions++;
      return [];
    }

    async fetchDepositAddress(_currency: string) {
      calls.fetchDepositAddress++;
      return { address: '0xmockdepositaddress', tag: 'mock-tag' };
    }
  }
  return { default: { binance: FakeExchange } };
});

const FIXED_NOW = 1_700_000_000_000;

// Test-only credential strings — not real secrets, never sent anywhere (the
// fake exchange swallows the config; the offline guard blocks all network).
const OPTS = {
  exchangeId: 'binance',
  apiKey: 'TEST-ONLY-NOT-A-REAL-KEY',
  apiSecret: 'test-only-not-a-real-secret',
};

const MARKET_ORDER: CexOrderParams = { symbol: 'BTC/USDT', side: 'sell', amount: 0.001 };
const LIMIT_ORDER: CexOrderParams = { symbol: 'BTC/USDT', side: 'sell', amount: 0.001, price: 50_000 };

/** Stub a valid (or deliberately malformed/expired) descriptor into the env. */
function grant(scopes: readonly string[], expiresAtMs: number = FIXED_NOW + 60_000): void {
  vi.stubEnv(EXECUTION_AUTH_ENV_VAR, JSON.stringify({ authId: 'em-strat-014-b1-test', expiresAtMs, scopes: [...scopes] }));
}

describe('CexExecutor — execution containment (EM-STRAT-014-B1)', () => {
  beforeEach(() => {
    setExecutionClockForTesting(() => FIXED_NOW);
    vi.unstubAllEnvs();
    resetCalls();
  });
  afterEach(() => {
    resetExecutionClockForTesting();
    vi.unstubAllEnvs();
  });

  // ── Acceptance 1: fail-closed without authorization ───────────────────

  it('A1: without authorization, marketOrder and limitOrder fail closed and the mock createOrder call count remains zero', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    // Construction itself is deliberately ungated (read-only capability
    // preserved) — the DENIAL must happen at the submission boundary.
    const ex = new CexExecutor(OPTS);
    expect(ex.exchangeId).toBe('binance');

    const mErr = await ex.marketOrder(MARKET_ORDER).then(() => null, (e: unknown) => e);
    expect(mErr).toBeInstanceOf(ExecutionNotAuthorizedError);
    expect((mErr as ExecutionNotAuthorizedError).scope).toBe('cex-executor:place-order');

    const lErr = await ex.limitOrder(LIMIT_ORDER).then(() => null, (e: unknown) => e);
    expect(lErr).toBeInstanceOf(ExecutionNotAuthorizedError);
    expect((lErr as ExecutionNotAuthorizedError).scope).toBe('cex-executor:place-order');

    expect(calls.createOrder).toBe(0);
    expect(calls.lastCreateOrderArgs).toBeNull();
  });

  // ── Acceptance 2: wrong-scope / malformed / expired — at the call boundary ──

  it('A2: wrong-scope, malformed, and expired authorizations fail closed before the exchange sink, including on an already-created instance', async () => {
    // Instance created with NO authorization at all — every submission is
    // checked per call, so this instance must never reach the sink.
    const ex = new CexExecutor(OPTS);

    // (a) a real, valid descriptor for the WRONG scope must not work.
    grant(['vooi:place-arbitrage-order']);
    const wrongScope = await ex.marketOrder(MARKET_ORDER).then(() => null, (e: unknown) => e);
    expect(wrongScope).toBeInstanceOf(ExecutionNotAuthorizedError);
    expect((wrongScope as ExecutionNotAuthorizedError).scope).toBe('cex-executor:place-order');
    expect(calls.createOrder).toBe(0);

    // (b) malformed JSON must not work.
    vi.stubEnv(EXECUTION_AUTH_ENV_VAR, '{"authId": "broken"');
    await expect(ex.limitOrder(LIMIT_ORDER)).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(calls.createOrder).toBe(0);

    // (c) already-expired descriptor must not work.
    grant(['cex-executor:place-order'], FIXED_NOW - 1);
    const expired = await ex.marketOrder(MARKET_ORDER).then(() => null, (e: unknown) => e);
    expect(expired).toBeInstanceOf(ExecutionNotAuthorizedError);
    expect(String((expired as Error).message)).toContain('expired');
    expect(calls.createOrder).toBe(0);

    // (d) excessively long-lived descriptor (beyond the 1h cap) must not work.
    grant(['cex-executor:place-order'], FIXED_NOW + 2 * 60 * 60 * 1000);
    await expect(ex.marketOrder(MARKET_ORDER)).rejects.toThrow(/exceeds maximum/);
    expect(calls.createOrder).toBe(0);

    // (e) withdrawal surface: wrong-scope denial at the same boundary.
    grant(['cex-executor:place-order']);
    await expect(ex.withdraw('USDT', 10, '0xdestination')).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(calls.withdraw).toBe(0);
  });

  it('A2b: an instance created under a VALID descriptor cannot submit after the descriptor expires (per-call re-check on the same instance)', async () => {
    grant(['cex-executor:place-order']);
    const ex = new CexExecutor(OPTS);
    // Sanity: authorized NOW.
    await ex.marketOrder(MARKET_ORDER);
    expect(calls.createOrder).toBe(1);

    // Authorization lapses (clock advances past expiry; env unchanged).
    setExecutionClockForTesting(() => FIXED_NOW + 61_000);
    await expect(ex.marketOrder(MARKET_ORDER)).rejects.toThrow(ExecutionNotAuthorizedError);
    await expect(ex.limitOrder(LIMIT_ORDER)).rejects.toThrow(ExecutionNotAuthorizedError);
    // Only the pre-expiry call reached the sink.
    expect(calls.createOrder).toBe(1);
  });

  // ── Acceptance 3: the order scope allows ONLY the order path ──────────

  it('A3: a valid cex-executor:place-order scope allows only the intended mocked order paths — it does NOT authorize withdrawal', async () => {
    grant(['cex-executor:place-order']);
    const ex = new CexExecutor(OPTS);

    const m = await ex.marketOrder(MARKET_ORDER);
    expect(m.id).toBe('mock-order-1');
    expect(calls.lastCreateOrderArgs?.[1]).toBe('market');

    const l = await ex.limitOrder(LIMIT_ORDER);
    expect(l.id).toBe('mock-order-1');
    expect(calls.lastCreateOrderArgs?.[1]).toBe('limit');
    expect(calls.lastCreateOrderArgs?.[4]).toBe(50_000);

    expect(calls.createOrder).toBe(2);
    // The order scope must NOT open the withdrawal sink.
    await expect(ex.withdraw('USDT', 10, '0xdestination')).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(calls.withdraw).toBe(0);
  });

  // ── Acceptance 4: withdrawal requires its OWN scope ───────────────────

  it('A4: without the separate withdrawal scope, withdraw fails closed and the mock withdrawal call count remains zero — a valid order scope alone must not authorize it', async () => {
    // (a) no authorization at all.
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const exNoAuth = new CexExecutor(OPTS);
    await expect(exNoAuth.withdraw('USDT', 10, '0xdestination')).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(calls.withdraw).toBe(0);

    // (b) a VALID order scope is still not withdrawal authority.
    grant(['cex-executor:place-order']);
    const exOrderOnly = new CexExecutor(OPTS);
    const wErr = await exOrderOnly.withdraw('USDT', 10, '0xdestination').then(() => null, (e: unknown) => e);
    expect(wErr).toBeInstanceOf(ExecutionNotAuthorizedError);
    expect((wErr as ExecutionNotAuthorizedError).scope).toBe('cex-executor:withdraw');
    expect(calls.withdraw).toBe(0);
  });

  // ── Acceptance 5: the withdrawal scope allows ONLY the withdrawal path ──

  it('A5: a valid cex-executor:withdraw scope allows only the mocked withdrawal path — order placement stays denied unless the place-order scope is explicitly present', async () => {
    grant(['cex-executor:withdraw']);
    const ex = new CexExecutor(OPTS);

    const w = await ex.withdraw('USDT', 10, '0xdestination', 'mock-tag');
    expect(w).toBeDefined();
    expect(calls.withdraw).toBe(1);
    expect(calls.lastWithdrawArgs?.[0]).toBe('USDT');
    expect(calls.lastWithdrawArgs?.[2]).toBe('0xdestination');

    // Withdrawal authority must NOT authorize order placement.
    await expect(ex.marketOrder(MARKET_ORDER)).rejects.toThrow(ExecutionNotAuthorizedError);
    await expect(ex.limitOrder(LIMIT_ORDER)).rejects.toThrow(ExecutionNotAuthorizedError);
    expect(calls.createOrder).toBe(0);

    // Only when BOTH scopes are explicitly present are both paths open.
    grant(['cex-executor:withdraw', 'cex-executor:place-order']);
    await ex.marketOrder(MARKET_ORDER);
    await ex.withdraw('USDT', 10, '0xdestination');
    expect(calls.createOrder).toBe(1);
    expect(calls.withdraw).toBe(2);
  });

  // ── Acceptance 6: the underlying CCXT exchange is unreachable ─────────

  it('A6: the underlying CCXT exchange cannot be obtained from a public property, reflective property enumeration, or ordinary caller access', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const ex = new CexExecutor(OPTS);
    const untyped = ex as unknown as Record<string, unknown>;

    // The former PUBLIC `readonly exchange` must be gone entirely.
    expect(untyped['exchange']).toBeUndefined();
    expect('exchange' in ex).toBe(false);

    // Hard-private # fields are not own properties: enumeration and
    // reflection cannot see them.
    const ownProps = Object.getOwnPropertyNames(ex);
    expect(ownProps).not.toContain('exchange');
    expect(ownProps).not.toContain('#exchange');
    const reflective = Reflect.ownKeys(ex).map(String);
    expect(reflective).not.toContain('exchange');
    expect(reflective).not.toContain('#exchange');

    // The only own property is inert metadata (exchangeId).
    expect(ownProps).toEqual(['exchangeId']);

    // JSON serialization can neither reach the exchange nor leak credentials.
    const json = JSON.stringify(ex);
    expect(json).not.toContain('TEST-ONLY-NOT-A-REAL-KEY');
    expect(json).not.toContain('test-only-not-a-real-secret');
    expect(json).not.toContain('createOrder');

    // A prototype-climbing caller gets nothing usable either.
    expect(Object.getPrototypeOf(ex).constructor.name).toBe('CexExecutor');
    expect((Object.getPrototypeOf(ex) as Record<string, unknown>)['exchange']).toBeUndefined();
  });

  // ── Acceptance 7: read-only capability preserved; documented cancellation ──

  it('A7: read-only market/account data works WITHOUT any authorization, and the read-only session performs zero submission calls', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const ex = new CexExecutor(OPTS);

    const t = await ex.getTicker('BTC/USDT');
    expect(t).toEqual({ last: 50_000, bid: 49_999, ask: 50_001, volume: 1_234, high: 51_000, low: 49_000 });

    const ob = await ex.getOrderBook('BTC/USDT');
    expect(ob.bids).toEqual([[49_999, 1], [49_998, 2]]);
    expect(ob.asks).toEqual([[50_001, 1], [50_002, 2]]);
    expect(ob.midPrice).toBe(50_000);
    expect(ob.spread).toBeCloseTo(2 / 50_000, 10);

    const b = await ex.getBalance();
    expect(b).toEqual({ USDT: 1_000 });

    expect(await ex.getPositions()).toEqual([]);

    const d = await ex.getDepositAddress('USDT');
    expect(d).toEqual({ address: '0xmockdepositaddress', tag: 'mock-tag' });

    const h = await ex.healthCheck();
    expect(h.ok).toBe(true);

    // Every read-only path above hit exactly its own fake method…
    expect(calls.fetchTicker).toBe(1);
    expect(calls.fetchOrderBook).toBe(1);
    expect(calls.fetchBalance).toBe(2); // getBalance + healthCheck
    expect(calls.fetchPositions).toBe(1);
    expect(calls.fetchDepositAddress).toBe(1);
    // …and NO submission path was ever touched.
    expect(calls.createOrder).toBe(0);
    expect(calls.withdraw).toBe(0);
    expect(calls.cancelOrder).toBe(0);
  });

  it('A7b: cancelOrder is SAFETY-POSITIVE — it stays available without authorization, reaches its sink, and can NEVER place orders or move funds', async () => {
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    const ex = new CexExecutor(OPTS);
    const r = await ex.cancelOrder('order-123', 'BTC/USDT');
    expect(r).toBeDefined();
    expect(calls.cancelOrder).toBe(1);
    expect(calls.lastCancelArgs?.[0]).toBe('order-123');
    expect(calls.lastCancelArgs?.[1]).toBe('BTC/USDT');
    // Cancellation cannot create exposure: no order, no withdrawal.
    expect(calls.createOrder).toBe(0);
    expect(calls.withdraw).toBe(0);
  });

  // ── Acceptance 8: census/regression controls ──────────────────────────

  it('A8a: the @edge/executor package loads NO .env file — EDGE_EXECUTION_AUTH can only arrive via the parent-process environment', () => {
    const srcDir = resolve(__dirname, '..', 'src');
    const offenders: string[] = [];
    for (const f of readdirSync(srcDir)) {
      if (!f.endsWith('.ts')) continue;
      // Strip comments (same approach as the census) so PROSE mentioning
      // the shared dotenv-safety helper cannot trip the scan — only real
      // loading CODE counts.
      const code = readFileSync(join(srcDir, f), 'utf8')
        .split('\n')
        .filter(l => {
          const t = l.trimStart();
          return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/'));
        })
        .join('\n')
        .replace(/(?<!:)\/\/.*$/gm, '');
      // No dotenv usage, no quoted '.env' path, and no direct file reads —
      // i.e. nothing in the package can load a persisted .env at all.
      if (/dotenv/i.test(code) || /['"]\.env['"]/.test(code) || /readFileSync/.test(code)) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('A8b: a persisted .env cannot arm the guard — the shared loader excludes EDGE_EXECUTION_AUTH and the order sink stays closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cex-b1-env-'));
    const envPath = join(dir, '.env');
    try {
      writeFileSync(
        envPath,
        `${EXECUTION_AUTH_ENV_VAR}=${JSON.stringify({
          authId: 'from-dotenv',
          expiresAtMs: FIXED_NOW + 60_000,
          scopes: ['cex-executor:place-order', 'cex-executor:withdraw'],
        })}\n`,
        'utf8',
      );
      loadDotEnvIntoProcessEnv(envPath);

      // The loader must NOT have armed the guard from the file…
      expect(process.env[EXECUTION_AUTH_ENV_VAR]).toBeUndefined();

      // …so both CexExecutor submission sinks stay closed.
      const ex = new CexExecutor(OPTS);
      await expect(ex.marketOrder(MARKET_ORDER)).rejects.toThrow(ExecutionNotAuthorizedError);
      await expect(ex.withdraw('USDT', 10, '0xdestination')).rejects.toThrow(ExecutionNotAuthorizedError);
      expect(calls.createOrder).toBe(0);
      expect(calls.withdraw).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
