import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mockFetch } from './_setup/offline-mocks.js';
import {
  FETCH_OVERRIDE_PATTERNS,
  GUARD_SETUP_FILE,
  scanForFetchOverrides,
  scanForOriginalFetchExposure,
  assertFetchIsGuarded,
  runPatternSelfTest,
} from './_setup/fetch-override-patterns.js';

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
//   - Verify the unwrapped real transport is NOT exposed on the global object.
//
// EM-STRAT-009 §1/§2: the runtime assertion uses assertFetchIsGuarded
// (imported from the helper) which fixes the false-positive bug where a
// fulfilled fetch could be mistaken for a guarded rejection. The static
// scanner now covers EVERY .ts file under the test directory, including
// this file — pattern definitions live in the helper to avoid
// self-triggering.

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
    expect(typeof (mockFetch as any).disable).toBe('undefined');
  });

  it('mockFetch API does NOT expose an enable() method', () => {
    expect(typeof (mockFetch as any).enable).toBe('undefined');
  });

  it('the global object does NOT expose the unwrapped real transport', () => {
    expect((globalThis as any).originalFetch).toBeUndefined();
  });

  it('the installed fetch IS the wrapped fail-closed guard, not the real transport', async () => {
    await expect(fetch('https://example.unregistered.test/api')).rejects.toThrow(
      /EM-STRAT-007 offline guard/,
    );
  });

  it('attempting to call disable() throws (method does not exist)', () => {
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
    await expect(fetch('https://seq-test.example.com/1')).rejects.toThrow(/offline guard/);
  });

  it('guard remains active AFTER clear() in a previous test (test 2 of 3)', async () => {
    await expect(fetch('https://seq-test.example.com/2')).rejects.toThrow(/offline guard/);
  });

  it('guard remains active after registering+clearing mocks (test 3 of 3)', async () => {
    mockFetch.register('seq-test.example.com', { status: 200, json: async () => ({ ok: true }) });
    const res = await fetch('https://seq-test.example.com/mocked');
    expect(res.ok).toBe(true);
    mockFetch.clear();
    await expect(fetch('https://seq-test.example.com/mocked')).rejects.toThrow(/offline guard/);
    await expect(fetch('https://other.example.com/')).rejects.toThrow(/offline guard/);
  });

  it('clear() does NOT disable the guard — only clears the mock registry', async () => {
    mockFetch.register('api.example.com', { status: 200, json: async () => ({}) });
    mockFetch.clear();
    await expect(fetch('https://not-registered.example.com/')).rejects.toThrow(/offline guard/);
  });

  it('registering a mock does NOT disable the guard for other URLs', async () => {
    mockFetch.register('api.example.com', { status: 200, json: async () => ({ ok: true }) });
    const res = await fetch('https://api.example.com/data');
    expect(res.ok).toBe(true);
    await expect(fetch('https://other.example.com/')).rejects.toThrow(/offline guard/);
  });

  it('current installed fetch IS the fail-closed guard (no overwrite detected at test start)', async () => {
    // EM-STRAT-008 §1: this test verifies that the installed fetch is
    // currently the fail-closed guard (rejects unregistered URLs). It does
    // NOT claim that reassignment is impossible — JavaScript allows
    // arbitrary reassignment at runtime. The protection against accidental
    // bypass is:
    //   (a) the static regression check in the "fetch-override detection"
    //       suite below, which scans all test source files for reassignment
    //       patterns and fails if any are found; and
    //   (b) the per-test runtime verification using assertFetchIsGuarded
    //       (see the "guard is active at the start of every test" suite
    //       below), which catches leaks from a previous test in the same
    //       describe block.
    await expect(fetch('https://verify-guard.example.com/')).rejects.toThrow(/offline guard/);
  });
});

// ─── EM-STRAT-007 §2: Inventory of request mechanisms ──────────────────

describe('EM-STRAT-007 §2 — no external-call mechanism bypasses the installed fetch', () => {
  // These tests document that the test suite does not use any alternative
  // request mechanism that would bypass the installed fail-closed guard.

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

// ─── EM-STRAT-008 §1 + EM-STRAT-009 §2: Fetch-override static detection ─
//
// EM-STRAT-009 §2: the static scanner now covers EVERY .ts file under
// packages/scanner/test/, including this test file and the helper file.
// The ONLY exempted file is the guard setup file (GUARD_SETUP_FILE) which
// legitimately installs the wrapped fail-closed fetch.
//
// Pattern definitions live in _setup/fetch-override-patterns.ts to avoid
// self-triggering. This test file imports and calls the scanner; it does
// NOT contain the literal override syntax in its own source.

describe('EM-STRAT-008 §1 + EM-STRAT-009 §2 — fetch-override static detection (covers ALL test files)', () => {

  it('no test file (except the guard setup) contains a fetch-override pattern', () => {
    const path = require('node:path');
    const testDir = path.resolve(__dirname);
    const violations = scanForFetchOverrides(testDir);

    if (violations.length > 0) {
      const detail = violations
        .map(v => `  ${v.file} — ${v.patternId} (line ${v.line}): ${v.source}`)
        .join('\n');
      expect.fail(
        `EM-STRAT-009 §2: found ${violations.length} fetch-override pattern(s).\n` +
        `Only ${GUARD_SETUP_FILE} is allowed to assign the fetch transport.\n` +
        `Review each finding and either remove the override or document why it is safe.\n` +
        `Violations:\n${detail}`,
      );
    }
    expect(violations).toEqual([]);
  });

  it('the guard setup file IS allowed to install the wrapped fetch', () => {
    // EM-STRAT-009 §2: verify the guard setup file exists and contains the
    // legitimate guard-installation assignment. This confirms the exemption
    // is not vacuous — the setup file really does install the guard.
    const fs = require('node:fs');
    const path = require('node:path');
    const guardSetupPath = path.resolve(__dirname, GUARD_SETUP_FILE);
    expect(fs.existsSync(guardSetupPath)).toBe(true);
    const content = fs.readFileSync(guardSetupPath, 'utf8');
    // The setup file must contain the guard installation line.
    expect(content).toMatch(/globalThis\s*\.\s*fetch\s*=\s*wrappedFetch/);
    // The setup file must NOT expose the original real fetch on the global object.
    expect(content).not.toMatch(/globalThis\s*\.\s*originalFetch\s*=/);
  });

  it('no file exposes the unwrapped real transport on the global object', () => {
    const path = require('node:path');
    const testDir = path.resolve(__dirname);
    const violations = scanForOriginalFetchExposure(testDir);
    expect(violations).toEqual([]);
  });

  it('detection patterns actually match known override forms (self-test)', () => {
    // EM-STRAT-009 §2: verify the detection patterns are not vacuous —
    // they must match real override examples. The sample strings are
    // constructed via concatenation in the helper file to avoid
    // self-triggering the static scanner.
    const { matches } = runPatternSelfTest();
    for (const result of matches) {
      expect(result.matched).toBe(true);
    }
    // Verify we tested at least one sample per pattern.
    expect(matches.length).toBeGreaterThanOrEqual(FETCH_OVERRIDE_PATTERNS.length);
  });

  it('detection patterns do NOT match non-override fetch usage (false-positive check)', () => {
    // EM-STRAT-009 §2: verify the patterns do not match legitimate fetch
    // calls or mock registrations. Samples are constructed in the helper.
    const { falsePositives } = runPatternSelfTest();
    for (const result of falsePositives) {
      expect(result.matched).toBe(false);
    }
  });
});

// ─── EM-STRAT-009 §1 + EM-STRAT-010 §1: Runtime guard-assertion correctness ─
//
// EM-STRAT-009 §1: the previous runtime check had a bug where a fulfilled
// fetch() would throw a synthetic error containing "offline guard", which
// was then caught by the same catch block and accepted as evidence that
// the guard worked. The fix is assertFetchIsGuarded (imported from the
// helper), which structures the check so that:
//   - A fulfilled fetch() result fails the test OUTSIDE the rejection-
//     catching path.
//   - A rejected result passes only when the rejection matches the EXACT
//     guard error signature (not a loose substring match).
//   - An unrelated rejection fails the test.
//   - The assertion does not use its own synthetic error as evidence.
//
// EM-STRAT-010 §1: the rejection-matching logic was further tightened to
// match the specific stable error signature produced by the installed
// guard (OFFLINE_GUARD_ERROR_SIGNATURE). A substituted fetch that rejects
// with a generic message containing "offline guard" but lacking the full
// guard signature (prefix + blocked-URL line) will FAIL the assertion.
// This prevents false positives from lookalike rejections.

describe('EM-STRAT-009 §1 + EM-STRAT-010 §1 — assertFetchIsGuarded correctness', () => {

  it('passes when the fetch function rejects with the exact guard signature', async () => {
    // EM-STRAT-010 §1: a properly guarded fetch rejects unregistered URLs
    // with the EXACT guard error format. assertFetchIsGuarded should pass
    // (not throw). We construct the exact guard message format here.
    const prefix = '[EM-STRAT-007 offline guard] External network request blocked:';
    const url = 'https://test.example.com/';
    const guardedFetch = async () => {
      throw new Error(prefix + '\n  URL: ' + url + '\n  ...');
    };
    // Should NOT throw — the guard is working correctly.
    await assertFetchIsGuarded(guardedFetch as any, url);
  });

  it('FAILS when the fetch function RESOLVES (guard bypassed)', async () => {
    // EM-STRAT-009 §1: a resolving fetch means the guard has been bypassed.
    // assertFetchIsGuarded MUST throw. The previous implementation would
    // mistakenly pass in this case.
    const bypassedFetch = async () => new Response('{}', { status: 200 });
    await expect(
      assertFetchIsGuarded(bypassedFetch as any, 'https://test.example.com/'),
    ).rejects.toThrow(/RESOLVED but should have REJECTED/);
  });

  it('FAILS when the fetch function rejects with an unrelated error', async () => {
    // EM-STRAT-010 §1: if fetch was overwritten with a function that throws
    // a completely different error (not containing any guard wording),
    // assertFetchIsGuarded must fail.
    const customErrorFetch = async () => {
      throw new TypeError('network error');
    };
    await expect(
      assertFetchIsGuarded(customErrorFetch as any, 'https://test.example.com/'),
    ).rejects.toThrow(/does NOT match the exact guard signature/);
  });

  it('FAILS when a substituted fetch rejects with a lookalike containing the substring but not the full signature', async () => {
    // EM-STRAT-010 §1: this is the KEY new regression test. A substituted
    // fetch rejects with a generic message containing the words "offline
    // guard" but NOT the actual guard signature (no prefix, no blocked-URL
    // line format). The old /offline guard/i substring match would
    // mistakenly PASS this case. The tightened assertion must FAIL it.
    const lookalikeFetch = async () => {
      throw new Error('something about offline guard went wrong');
    };
    await expect(
      assertFetchIsGuarded(lookalikeFetch as any, 'https://test.example.com/'),
    ).rejects.toThrow(/does NOT match the exact guard signature/);
  });

  it('FAILS when a substituted fetch rejects with only the prefix but no blocked-URL line', async () => {
    // EM-STRAT-010 §1: even if a substituted fetch uses the exact prefix,
    // the signature requires the blocked-URL line format. A rejection with
    // only the prefix (no URL line) must FAIL — it does not prove the
    // actual guard produced it.
    const prefixOnlyFetch = async () => {
      throw new Error('[EM-STRAT-007 offline guard] something else entirely');
    };
    await expect(
      assertFetchIsGuarded(prefixOnlyFetch as any, 'https://test.example.com/'),
    ).rejects.toThrow(/does NOT match the exact guard signature/);
  });

  it('the failure message for a resolved fetch does NOT contain the guard substring', async () => {
    // EM-STRAT-009 §1: the synthetic failure message must NOT contain
    // "offline guard" — otherwise it could be confused with the expected
    // rejection. This is the root cause of the original bug.
    const bypassedFetch = async () => new Response('{}', { status: 200 });
    try {
      await assertFetchIsGuarded(bypassedFetch as any, 'https://test.example.com/');
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e.message).not.toMatch(/offline guard/i);
      expect(e.message).toMatch(/RESOLVED but should have REJECTED/);
    }
  });

  it('the actual installed fetch passes the assertion (guard is active)', async () => {
    // Verify the real installed fetch (the guard) passes the assertion.
    // This confirms the guard is working at the time this test runs and
    // that the assertion correctly accepts the real guard's error format.
    await assertFetchIsGuarded(fetch, 'https://em-strat-010-real-check.example.com/');
  });
});

// ─── EM-STRAT-009 §2: Per-test runtime guard-active verification ───────
//
// EM-STRAT-009 §2: the beforeEach in this describe block uses
// assertFetchIsGuarded to verify the guard is active at the start of
// every test in THIS describe block. If a prior test in this block
// overwrote the fetch transport, the beforeEach will fail immediately.
//
// SCOPE LIMITATION (documented accurately):
// This beforeEach is LOCAL to this describe block. It does NOT protect
// tests in other describe blocks or other test files. Suite-wide
// protection relies on:
//   (a) the static scanner (covers ALL .ts files — see the
//       "fetch-override static detection" suite above), which catches
//       override patterns at code-review time before they ever run; and
//   (b) the vitest setupFiles mechanism, which re-installs the guard
//       before each test FILE's imports (so overrides in one file cannot
//       leak into another file).
//
// The runtime beforeEach here is a defense-in-depth backup for the
// describe block it protects. It is NOT a suite-wide invariant.

describe('EM-STRAT-009 §2 — guard is active at the start of every test in this describe block', () => {
  // This beforeEach runs before every test in THIS describe block only.
  // See the SCOPE LIMITATION comment above for why this is not suite-wide.
  beforeEach(async () => {
    await assertFetchIsGuarded(fetch, 'https://em-strat-009-beforeEach-check.example.com/');
  });

  it('test A: guard is active at start (verifies beforeEach works)', () => {
    // If we got here, the beforeEach passed — the guard is active.
    expect(true).toBe(true);
  });

  it('test B: guard is still active after test A (no leak)', () => {
    expect(true).toBe(true);
  });

  it('test C: guard is still active after test B (no leak)', () => {
    expect(true).toBe(true);
  });
});
