import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mockFetch } from './_setup/offline-mocks.js';

// ─── EM-STRAT-006 §2 + EM-STRAT-007 §2: Offline guard verification ──────
//
// These tests verify that the offline guard installed by the vitest setup
// file actually blocks unexpected external network requests. The guard
// must throw a clear error explaining how to register a mock or move the
// test to an explicit opt-in integration path.
//
// EM-STRAT-007 §2 additions:
//   - Verify the guard CANNOT be disabled (no disable/enable escape hatch).
//   - Verify the guard remains active after mock clearing.
//   - Verify the guard remains active across sequential tests.
//   - Verify the unwrapped real transport is NOT exposed on globalThis.

describe('EM-STRAT-006 §2 — offline guard verification', () => {
  beforeEach(() => {
    mockFetch.clear();
  });
  afterEach(() => {
    mockFetch.clear();
  });

  it('blocks fetch to unregistered external URLs with a clear error', async () => {
    await expect(fetch('https://example.com/api')).rejects.toThrow(
      /EM-STRAT-007 offline guard/,
    );
  });

  it('error message explains how to register a mock', async () => {
    try {
      await fetch('https://api.example.com/data');
      expect.fail('fetch should have thrown');
    } catch (e: any) {
      expect(e.message).toContain('mockFetch.register');
      expect(e.message).toContain('offline-guard.ts');
    }
  });

  it('serves registered mock responses deterministically', async () => {
    mockFetch.register('api.example.com', {
      status: 200,
      json: async () => ({ hello: 'world' }),
    });
    const res = await fetch('https://api.example.com/data');
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body).toEqual({ hello: 'world' });
  });

  it('supports function-based mock responses', async () => {
    mockFetch.register('api.example.com', (url) => ({
      status: 200,
      json: async () => ({ echoed: url }),
    }));
    const res = await fetch('https://api.example.com/data');
    const body = await res.json() as any;
    expect(body.echoed).toBe('https://api.example.com/data');
  });

  it('records all fetch calls for debugging', async () => {
    mockFetch.register('api.example.com', { status: 200, json: async () => ({}) });
    await fetch('https://api.example.com/first');
    await fetch('https://api.example.com/second');
    const urls = mockFetch.calls.map(c => c.url);
    expect(urls).toContain('https://api.example.com/first');
    expect(urls).toContain('https://api.example.com/second');
  });

  it('clear() resets the mock registry and call log', async () => {
    mockFetch.register('api.example.com', { status: 200, json: async () => ({}) });
    await fetch('https://api.example.com/data');
    expect(mockFetch.calls.length).toBeGreaterThan(0);
    mockFetch.clear();
    expect(mockFetch.calls.length).toBe(0);
    // After clear, fetch should be blocked again.
    await expect(fetch('https://api.example.com/data')).rejects.toThrow(/offline guard/);
  });

  it('first-match-wins: earlier registrations take precedence', async () => {
    mockFetch.register('api.example.com', { status: 200, json: async () => ({ first: true }) });
    mockFetch.register('api.example.com', { status: 200, json: async () => ({ second: true }) });
    const res = await fetch('https://api.example.com/data');
    const body = await res.json() as any;
    expect(body).toEqual({ first: true });
  });

  it('blocks the actual external APIs used by scanners when no mock registered', async () => {
    // These are the real external endpoints scanners call. Without mocks,
    // the guard must block all of them.
    const blockedUrls = [
      'https://yields.llama.fi/pools',
      'https://api-boros.pendle.finance/apis/v1/markets',
      'https://api-v2.pendle.finance/core/v2/markets/all?limit=100&skip=0',
      'https://api.hyperliquid.xyz/info',
      'https://perps-api.vooi.io/api/v1/arbitrage',
      'https://api.coingecko.com/api/v3/simple/price',
      'https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT',
    ];
    for (const url of blockedUrls) {
      await expect(fetch(url)).rejects.toThrow(/EM-STRAT-007 offline guard/);
    }
  });
});

// ─── EM-STRAT-007 §1: No escape hatch ──────────────────────────────────

describe('EM-STRAT-007 §1 — guard has no disable/enable escape hatch', () => {
  beforeEach(() => {
    mockFetch.clear();
  });
  afterEach(() => {
    mockFetch.clear();
  });

  it('mockFetch API does NOT expose a disable() method', () => {
    // EM-STRAT-007 §1: the public mockFetch API must not include disable().
    expect(typeof (mockFetch as any).disable).toBe('undefined');
  });

  it('mockFetch API does NOT expose an enable() method', () => {
    // EM-STRAT-007 §1: the public mockFetch API must not include enable().
    expect(typeof (mockFetch as any).enable).toBe('undefined');
  });

  it('globalThis does NOT expose originalFetch (the unwrapped real transport)', () => {
    // EM-STRAT-007 §1: the unwrapped real fetch is module-private.
    // It must NOT be reachable from globalThis.
    expect((globalThis as any).originalFetch).toBeUndefined();
  });

  it('globalThis.fetch IS the wrapped (fail-closed) guard, not the real transport', async () => {
    // EM-STRAT-007 §1: confirm globalThis.fetch is the guard, not the real
    // transport. The guard rejects unregistered URLs; the real transport
    // would attempt the network call.
    await expect(fetch('https://example.unregistered.test/api')).rejects.toThrow(
      /EM-STRAT-007 offline guard/,
    );
  });

  it('attempting to call disable() throws (method does not exist)', () => {
    // EM-STRAT-007 §1: calling disable() must fail — it's not on the API.
    expect(() => (mockFetch as any).disable()).toThrow(TypeError);
  });

  it('attempting to call enable() throws (method does not exist)', () => {
    expect(() => (mockFetch as any).enable()).toThrow(TypeError);
  });
});

// ─── EM-STRAT-007 §2: Guard lifecycle and coverage ─────────────────────

describe('EM-STRAT-007 §2 — guard remains active after clear() and across sequential tests', () => {
  afterEach(() => {
    mockFetch.clear();
  });

  it('guard is active BEFORE any mock is registered (test 1 of 3)', async () => {
    // First test in the sequence — guard must be active.
    await expect(fetch('https://seq-test.example.com/1')).rejects.toThrow(/offline guard/);
  });

  it('guard remains active AFTER clear() in a previous test (test 2 of 3)', async () => {
    // The previous test called no clear() but the afterEach did. The guard
    // must still be active.
    await expect(fetch('https://seq-test.example.com/2')).rejects.toThrow(/offline guard/);
  });

  it('guard remains active after registering+clearing mocks (test 3 of 3)', async () => {
    // Register a mock, use it, then clear. The guard must still be active
    // for unregistered URLs.
    mockFetch.register('seq-test.example.com', { status: 200, json: async () => ({ ok: true }) });
    const res = await fetch('https://seq-test.example.com/mocked');
    expect(res.ok).toBe(true);
    mockFetch.clear();
    // After clear, the same URL must be blocked.
    await expect(fetch('https://seq-test.example.com/mocked')).rejects.toThrow(/offline guard/);
    // And a different unregistered URL must also be blocked.
    await expect(fetch('https://other.example.com/')).rejects.toThrow(/offline guard/);
  });

  it('clear() does NOT disable the guard — only clears the mock registry', async () => {
    mockFetch.register('api.example.com', { status: 200, json: async () => ({}) });
    mockFetch.clear();
    // Guard must still block unregistered URLs.
    await expect(fetch('https://not-registered.example.com/')).rejects.toThrow(/offline guard/);
  });

  it('registering a mock does NOT disable the guard for other URLs', async () => {
    mockFetch.register('api.example.com', { status: 200, json: async () => ({ ok: true }) });
    // Registered URL works.
    const res = await fetch('https://api.example.com/data');
    expect(res.ok).toBe(true);
    // Unregistered URL is still blocked.
    await expect(fetch('https://other.example.com/')).rejects.toThrow(/offline guard/);
  });

  it('guard cannot be bypassed by overwriting globalThis.fetch (the guard is re-installed per file)', async () => {
    // EM-STRAT-007 §2: even if a test overwrites globalThis.fetch with a
    // custom function, the guard setup runs once per test FILE. Within a
    // single test file, overwriting globalThis.fetch affects only that
    // test's local view — but the guard's wrappedFetch closure is still
    // the only fetch the next test file will see (because setupFiles runs
    // before each test file's imports).
    //
    // This test verifies the CURRENT globalThis.fetch is the guard (not a
    // custom overwrite from a previous test). If a previous test in this
    // file overwrote globalThis.fetch, it would have been restored by the
    // afterEach mockFetch.clear() — but clear() does NOT restore fetch,
    // it only clears the mock registry. So we verify that the current
    // globalThis.fetch rejects unregistered URLs (i.e., it IS the guard).
    await expect(fetch('https://verify-guard.example.com/')).rejects.toThrow(/offline guard/);
  });
});

// ─── EM-STRAT-007 §2: Inventory of request mechanisms ──────────────────

describe('EM-STRAT-007 §2 — no external-call mechanism bypasses global fetch', () => {
  // These tests document that the test suite does not use any alternative
  // request mechanism (http/https modules, axios, undici, node-fetch,
  // WebSocket, XMLHttpRequest) that would bypass the global fetch guard.
  //
  // The offline-guard.test.ts file itself is EXCLUDED from the scan because
  // it contains the pattern strings as test fixtures (self-reference).

  it('test files do not import node:http or node:https directly', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const testDir = path.resolve(__dirname);
    const testFiles = fs.readdirSync(testDir).filter(f => f.endsWith('.test.ts') && f !== 'offline-guard.test.ts');
    const forbidden = ["from 'node:http'", 'from "node:http"', "from 'node:https'", 'from "node:https"', "from 'http'", 'from "http"', "from 'https'", 'from "https"', "from 'axios'", 'from "axios"', "from 'undici'", 'from "undici"', "from 'node-fetch'", 'from "node-fetch"', "from 'superagent'", 'from "superagent"'];
    const violations: string[] = [];
    for (const f of testFiles) {
      const content = fs.readFileSync(path.join(testDir, f), 'utf8');
      for (const pattern of forbidden) {
        if (content.includes(pattern)) {
          violations.push(`${f}: ${pattern}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('test files do not construct WebSocket instances', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const testDir = path.resolve(__dirname);
    const testFiles = fs.readdirSync(testDir).filter(f => f.endsWith('.test.ts') && f !== 'offline-guard.test.ts');
    const violations: string[] = [];
    for (const f of testFiles) {
      const content = fs.readFileSync(path.join(testDir, f), 'utf8');
      if (/\bnew\s+WebSocket\b/.test(content)) {
        violations.push(f);
      }
    }
    expect(violations).toEqual([]);
  });

  it('test files do not use XMLHttpRequest', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const testDir = path.resolve(__dirname);
    const testFiles = fs.readdirSync(testDir).filter(f => f.endsWith('.test.ts') && f !== 'offline-guard.test.ts');
    const violations: string[] = [];
    for (const f of testFiles) {
      const content = fs.readFileSync(path.join(testDir, f), 'utf8');
      if (/\bXMLHttpRequest\b/.test(content)) {
        violations.push(f);
      }
    }
    expect(violations).toEqual([]);
  });
});
