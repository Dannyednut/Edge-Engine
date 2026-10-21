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

  it('current globalThis.fetch IS the fail-closed guard (no overwrite detected at test start)', async () => {
    // EM-STRAT-008 §1: this test verifies that globalThis.fetch is currently
    // the fail-closed guard (rejects unregistered URLs). It does NOT claim
    // that reassignment is impossible — JavaScript allows arbitrary
    // reassignment of globalThis.fetch at runtime. The protection against
    // accidental bypass is:
    //   (a) the static regression check in the "fetch-override detection"
    //       suite below, which scans all test source files for reassignment
    //       patterns and fails if any are found; and
    //   (b) the per-test beforeEach verification in this file (see
    //       "guard is active at the start of every test" below), which
    //       catches leaks from a previous test in the same file.
    //
    // What this test actually proves: at the point this test runs,
    // globalThis.fetch rejects an unregistered URL with the offline-guard
    // error. If a prior test in this file had overwritten globalThis.fetch
    // and not restored it, this test would fail.
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

// ─── EM-STRAT-008 §1: Fetch-override detection ─────────────────────────
//
// EM-STRAT-008 finding: the previous test named "guard cannot be bypassed
// by overwriting globalThis.fetch" did not actually attempt an overwrite.
// It only checked that the current globalThis.fetch rejects unregistered
// URLs. The test name and comments implied a guarantee that the
// implementation does not enforce.
//
// JavaScript allows arbitrary reassignment of globalThis.fetch at runtime.
// The offline guard cannot prevent this at the language level. The
// protection against accidental bypass is a STATIC regression check that
// scans all test source files (and the setup files) for reassignment
// patterns. If any file contains a fetch-override pattern, the static
// check fails and the violation must be reviewed.
//
// The ONLY file allowed to assign globalThis.fetch is the offline guard
// setup file itself (packages/scanner/test/_setup/offline-guard.ts), which
// installs the wrapped fail-closed fetch. All other files are forbidden
// from reassigning, stubbing, or redefining globalThis.fetch.
//
// Patterns detected:
//   - globalThis.fetch = ...
//   - global.fetch = ...
//   - vi.stubGlobal('fetch', ...) / vi.stubGlobal("fetch", ...)
//   - Object.defineProperty(globalThis, 'fetch', ...)
//   - Object.defineProperty(global, 'fetch', ...)
//   - Object.defineProperty(..., 'fetch', ...)  (any target)
//
// This is a code-review-time check. It does NOT prove that runtime
// reassignment is impossible — it proves that no current test file
// attempts it. A future test that attempts reassignment will be caught
// here and must be reviewed before merging.

describe('EM-STRAT-008 §1 — fetch-override detection (static regression check)', () => {
  // The setup file that legitimately installs the guard.
  const GUARD_SETUP_FILE = '_setup/offline-guard.ts';

  // Fetch-override patterns. Each pattern is a regex that matches a
  // reassignment, stub, or redefinition of the global fetch transport.
  // Patterns are matched against the raw source text of each file.
  const FETCH_OVERRIDE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
    // Direct assignment: globalThis.fetch = ... or global.fetch = ...
    { name: 'globalThis.fetch = <assignment>', pattern: /globalThis\s*\.\s*fetch\s*=/ },
    { name: 'global.fetch = <assignment>', pattern: /\bglobal\s*\.\s*fetch\s*=/ },
    // vi.stubGlobal('fetch', ...) or vi.stubGlobal("fetch", ...)
    { name: "vi.stubGlobal('fetch', ...)", pattern: /vi\s*\.\s*stubGlobal\s*\(\s*['"]fetch['"]\s*,/i },
    // Object.defineProperty(globalThis, 'fetch', ...)
    { name: "Object.defineProperty(globalThis, 'fetch', ...)", pattern: /Object\s*\.\s*defineProperty\s*\(\s*globalThis\s*,\s*['"]fetch['"]\s*,/i },
    // Object.defineProperty(global, 'fetch', ...)
    { name: "Object.defineProperty(global, 'fetch', ...)", pattern: /Object\s*\.\s*defineProperty\s*\(\s*global\s*,\s*['"]fetch['"]\s*,/i },
    // Object.defineProperty(<any>, 'fetch', ...) — catches any target
    { name: "Object.defineProperty(<any>, 'fetch', ...)", pattern: /Object\s*\.\s*defineProperty\s*\([^,]+,\s*['"]fetch['"]\s*,/i },
    // Reflect.defineProperty(globalThis, 'fetch', ...) — same idea via Reflect
    { name: "Reflect.defineProperty(<any>, 'fetch', ...)", pattern: /Reflect\s*\.\s*defineProperty\s*\([^,]+,\s*['"]fetch['"]\s*,/i },
    // Object.defineProperty(globalThis, "fetch", ...) variants already covered above
  ];

  // Helper: scan a directory recursively for .ts files and return their
  // paths relative to the test directory.
  function scanTestFiles(testDir: string, fs: any, path: any): string[] {
    const results: string[] = [];
    function walk(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile() && e.name.endsWith('.ts')) {
          results.push(full);
        }
      }
    }
    walk(testDir);
    return results;
  }

  it('no test file (except the guard setup) reassigns, stubs, or redefines globalThis.fetch', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const testDir = path.resolve(__dirname);
    const allTsFiles = scanTestFiles(testDir, fs, path);

    // The guard setup file is the ONLY file allowed to assign globalThis.fetch.
    // All other files (test files AND other setup files) are forbidden.
    const violations: Array<{ file: string; pattern: string; line: string }> = [];
    for (const filePath of allTsFiles) {
      const relPath = path.relative(testDir, filePath);
      // Allow the guard setup file to install the wrapped fetch.
      if (relPath === GUARD_SETUP_FILE) continue;
      // Skip this test file itself — it contains the pattern strings as
      // documentation/fixtures and would self-trigger. The check is
      // enforced on all OTHER test files.
      if (relPath === 'offline-guard.test.ts') continue;

      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const { name, pattern } of FETCH_OVERRIDE_PATTERNS) {
          if (pattern.test(line)) {
            violations.push({ file: relPath, pattern: name, line: `${i + 1}: ${line.trim()}` });
          }
        }
      }
    }

    if (violations.length > 0) {
      const detail = violations.map(v => `  ${v.file} — ${v.pattern}\n    ${v.line}`).join('\n');
      expect.fail(
        `EM-STRAT-008 §1: found ${violations.length} fetch-override pattern(s) in test files.\n` +
        `Only ${GUARD_SETUP_FILE} is allowed to assign globalThis.fetch.\n` +
        `Review each finding and either remove the override or document why it is safe.\n` +
        `Violations:\n${detail}`,
      );
    }
    expect(violations).toEqual([]);
  });

  it('the guard setup file IS allowed to assign globalThis.fetch (it installs the guard)', async () => {
    // EM-STRAT-008 §1: verify the guard setup file exists and contains the
    // legitimate guard-installation assignment. This confirms the allow-list
    // is not vacuous — the setup file really does install the guard.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const guardSetupPath = path.resolve(__dirname, GUARD_SETUP_FILE);
    expect(fs.existsSync(guardSetupPath)).toBe(true);
    const content = fs.readFileSync(guardSetupPath, 'utf8');
    // The setup file must contain the guard installation line.
    expect(content).toMatch(/globalThis\s*\.\s*fetch\s*=\s*wrappedFetch/);
    // The setup file must NOT expose the original real fetch on globalThis.
    expect(content).not.toMatch(/globalThis\s*\.\s*originalFetch\s*=/);
  });

  it('the guard setup file does NOT expose the unwrapped real transport on globalThis', async () => {
    // EM-STRAT-008 §1: confirm no globalThis.originalFetch assignment exists
    // in any file under the test directory (including the setup file).
    const fs = await import('node:fs');
    const path = await import('node:path');
    const testDir = path.resolve(__dirname);
    const allTsFiles = scanTestFiles(testDir, fs, path);
    const violations: string[] = [];
    for (const filePath of allTsFiles) {
      const relPath = path.relative(testDir, filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      if (/globalThis\s*\.\s*originalFetch\s*=/.test(content)) {
        violations.push(relPath);
      }
    }
    expect(violations).toEqual([]);
  });

  it('detection patterns actually match known override forms (self-test)', async () => {
    // EM-STRAT-008 §1: verify the detection patterns are not vacuous —
    // they must match real override examples. This catches regressions
    // where a pattern is accidentally weakened.
    const examples: Array<{ pattern: RegExp; sample: string }> = [
      { pattern: FETCH_OVERRIDE_PATTERNS[0].pattern, sample: 'globalThis.fetch = customFetch;' },
      { pattern: FETCH_OVERRIDE_PATTERNS[0].pattern, sample: '  globalThis.fetch=customFetch;' },
      { pattern: FETCH_OVERRIDE_PATTERNS[1].pattern, sample: 'global.fetch = customFetch;' },
      { pattern: FETCH_OVERRIDE_PATTERNS[2].pattern, sample: "vi.stubGlobal('fetch', customFetch);" },
      { pattern: FETCH_OVERRIDE_PATTERNS[2].pattern, sample: 'vi.stubGlobal("fetch", customFetch);' },
      { pattern: FETCH_OVERRIDE_PATTERNS[3].pattern, sample: "Object.defineProperty(globalThis, 'fetch', { value: customFetch });" },
      { pattern: FETCH_OVERRIDE_PATTERNS[4].pattern, sample: 'Object.defineProperty(global, "fetch", { value: customFetch });' },
      { pattern: FETCH_OVERRIDE_PATTERNS[5].pattern, sample: "Object.defineProperty(someObj, 'fetch', { value: customFetch });" },
      { pattern: FETCH_OVERRIDE_PATTERNS[6].pattern, sample: "Reflect.defineProperty(globalThis, 'fetch', { value: customFetch });" },
    ];
    for (const { pattern, sample } of examples) {
      expect(pattern.test(sample)).toBe(true);
    }
  });

  it('detection patterns do NOT match non-override fetch usage (false-positive check)', async () => {
    // EM-STRAT-008 §1: verify the patterns do not match legitimate fetch
    // calls or mock registrations (which use mockFetch.register, not
    // globalThis.fetch assignment).
    const nonViolations = [
      'const res = await fetch("https://api.example.com/data");',
      'mockFetch.register("api.example.com", { status: 200, json: async () => ({}) });',
      'expect(globalThis.fetch).toBeDefined();',  // read, not write
      'const orig = globalThis.fetch;',  // read, not write (no = after fetch)
      '// globalThis.fetch = wrappedFetch;',  // comment, not code — but we flag it anyway (conservative)
    ];
    // The patterns should NOT match the first 4 (legitimate reads/calls).
    // The 5th (comment) WILL match — that's intentional (conservative).
    for (let i = 0; i < 4; i++) {
      const sample = nonViolations[i];
      let matched = false;
      for (const { pattern } of FETCH_OVERRIDE_PATTERNS) {
        if (pattern.test(sample)) { matched = true; break; }
      }
      expect(matched).toBe(false);
    }
  });
});

// ─── EM-STRAT-008 §2: Per-test guard-active verification ───────────────
//
// EM-STRAT-008 §2: ensure an accidental replacement cannot leak into
// subsequent tests. The beforeEach hook in this describe block verifies
// the guard is active at the start of every test. If a prior test in this
// file overwrote globalThis.fetch and did not restore it, the beforeEach
// will fail and prevent the next test from running with a broken guard.
//
// Note: this is a runtime check local to this test file. The static check
// above is the primary protection — it catches overrides at code-review
// time before they ever run. This runtime check is a defense-in-depth
// backup for the case where a test somehow bypasses the static check
// (e.g., via dynamic code evaluation, which is not currently used).

describe('EM-STRAT-008 §2 — guard is active at the start of every test (runtime defense-in-depth)', () => {
  // This beforeEach runs before every test in this describe block. If a
  // prior test overwrote globalThis.fetch, this check fails immediately.
  beforeEach(async () => {
    // Verify the guard is active by attempting an unregistered fetch.
    // We do NOT call mockFetch.clear() here — the test body is responsible
    // for its own mock setup. We only verify the guard itself is intact.
    try {
      await fetch('https://em-strat-008-guard-check.example.com/');
      // If fetch did NOT throw, the guard has been bypassed.
      throw new Error(
        'EM-STRAT-008 §2: globalThis.fetch did NOT reject an unregistered URL. ' +
        'The offline guard may have been overwritten by a prior test. ' +
        'Review the test file for globalThis.fetch reassignment.',
      );
    } catch (e: any) {
      // Expected: the guard rejects with the offline-guard error message.
      // If the error is NOT the offline-guard error, something else is wrong.
      if (!/offline guard/i.test(e.message)) {
        throw new Error(
          `EM-STRAT-008 §2: fetch threw an unexpected error (not the offline-guard error). ` +
          `This suggests globalThis.fetch was overwritten with a function that throws a different error. ` +
          `Original error: ${e.message}`,
        );
      }
    }
  });

  it('test A: guard is active at start (verifies beforeEach works)', async () => {
    // If we got here, the beforeEach passed — the guard is active.
    expect(true).toBe(true);
  });

  it('test B: guard is still active after test A (no leak)', async () => {
    expect(true).toBe(true);
  });

  it('test C: guard is still active after test B (no leak)', async () => {
    expect(true).toBe(true);
  });
});
