/**
 * Offline guard for the @edge/scanner test suite (EM-STRAT-006 §2).
 *
 * This setup file is loaded by vitest BEFORE any test file runs. It installs
 * a global fetch interceptor that:
 *
 *   1. By default, REJECTS any external network request with a clear error
 *      explaining that the test suite runs offline. This catches regressions
 *      where a scanner's `scan()` method accidentally hits a live API.
 *
 *   2. Allows tests to register deterministic mock responses for specific
 *      URL patterns via `mockFetch.register(pattern, response)`. When a
 *      fetch matches a registered pattern, the mock response is served
 *      instead of rejecting.
 *
 *   3. Resets the mock registry between tests so mocks don't leak across
 *      test boundaries.
 *
 * The offline guard applies to ALL test files in the default test/CI path.
 * Integration tests that genuinely require network access must be explicitly
 * opt-in via a separate vitest project/config that does NOT load this setup
 * file. No such integration tests exist in the current repository.
 *
 * EM-STRAT-006 §2 requirement:
 *   "The default test/CI path must fail if an unexpected external network
 *    request is attempted."
 */

//
// Type definitions
//

type MockResponse = {
  ok?: boolean;
  status?: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
  headers?: Record<string, string>;
};

type MockEntry = {
  /** Regex or string pattern to match against the fetch URL. */
  pattern: RegExp | string;
  /** The mock response to serve, OR a function that returns one. */
  response: MockResponse | ((url: string, init?: RequestInit) => MockResponse | Promise<MockResponse>);
  /** Optional call counter for assertion. */
  callCount: number;
};

interface MockFetchApi {
  /**
   * Register a deterministic mock response for a URL pattern.
   * Patterns are checked in registration order; first match wins.
   */
  register(
    pattern: RegExp | string,
    response: MockResponse | ((url: string, init?: RequestInit) => MockResponse | Promise<MockResponse>),
  ): void;
  /** Clear all registered mocks. Called automatically between tests. */
  clear(): void;
  /** Get the number of times a pattern was matched (for assertion). */
  callCount(pattern: RegExp | string): number;
  /** All recorded fetch calls (URL + init) for debugging. */
  calls: Array<{ url: string; init?: RequestInit }>;
  /** Disable the offline guard entirely (for explicit opt-in integration tests). */
  disable(): void;
  /** Re-enable the offline guard (default state). */
  enable(): void;
}

//
// Implementation
//

const entries: MockEntry[] = [];
const calls: Array<{ url: string; init?: RequestInit }> = [];
let guardEnabled = true;

function matchUrl(url: string, pattern: RegExp | string): boolean {
  if (typeof pattern === 'string') {
    return url.includes(pattern);
  }
  return pattern.test(url);
}

function findEntry(url: string): MockEntry | undefined {
  return entries.find(e => matchUrl(url, e.pattern));
}

function makeOfflineError(url: string): Error {
  const err = new Error(
    `[EM-STRAT-006 offline guard] External network request blocked:\n` +
    `  URL: ${url}\n` +
    `  The default test/CI path runs OFFLINE. If this test genuinely requires\n` +
    `  network access, register a mock via \`mockFetch.register(pattern, response)\`\n` +
    `  in the test setup. If this is an integration test, move it to a separate\n` +
    `  vitest project that does NOT load the offline guard.\n` +
    `  See packages/scanner/test/_setup/offline-guard.ts for details.`,
  );
  return err;
}

const originalFetch = globalThis.fetch;

const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

  // Always record the call for debugging.
  calls.push({ url, init });

  if (!guardEnabled) {
    // Guard explicitly disabled — pass through to real fetch.
    return originalFetch(input as any, init);
  }

  const entry = findEntry(url);
  if (entry) {
    entry.callCount++;
    const resolved = typeof entry.response === 'function'
      ? await entry.response(url, init)
      : entry.response;
    const status = resolved.status ?? 200;
    const ok = resolved.ok ?? (status >= 200 && status < 300);
    const responseBody = resolved.json
      ? JSON.stringify(await resolved.json())
      : resolved.text
        ? await resolved.text()
        : '{}';
    return new Response(responseBody, {
      status,
      headers: resolved.headers,
      // @ts-expect-error: ok is read-only on ResponseInit but we set it for compat.
      ok,
    });
  }

  // No mock registered — block the request.
  throw makeOfflineError(url);
};

// Install the wrapped fetch BEFORE any test imports scanner modules.
(globalThis as any).fetch = wrappedFetch;
(globalThis as any).originalFetch = originalFetch;

// Export the mock API for tests to use.
const mockFetchApi: MockFetchApi = {
  register(pattern, response) {
    entries.push({ pattern, response, callCount: 0 });
  },
  clear() {
    entries.length = 0;
    calls.length = 0;
  },
  callCount(pattern) {
    const e = entries.find(e => matchUrl('', pattern) || e.pattern === pattern);
    return e?.callCount ?? 0;
  },
  calls,
  disable() { guardEnabled = false; },
  enable() { guardEnabled = true; },
};

// Expose globally so test files can access without import.
(globalThis as any).mockFetch = mockFetchApi;

// Reset between tests so mocks don't leak across boundaries.
// Note: setupFiles run once per test file; we use beforeEach via the
// globalThis mockFetch.clear() — test files that register mocks should
// call mockFetch.clear() in a beforeEach hook.
