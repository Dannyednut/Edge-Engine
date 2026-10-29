/**
 * Test helpers for the EM-STRAT-006/007 offline guard.
 *
 * These helpers register deterministic mock responses for the external APIs
 * that scanners call. Tests that exercise `scanner.scan()` should import
 * the relevant helper to ensure the test runs offline.
 *
 * Mocks are registered via the global `mockFetch` API exposed by the
 * offline-guard setup file. Tests should call `mockFetch.clear()` in a
 * `beforeEach` to prevent mocks from leaking across test boundaries.
 *
 * EM-STRAT-007 §1: the mockFetch API has NO disable/enable escape hatch.
 * The guard is unconditionally fail-closed for the default test suite.
 */

import { beforeEach, afterEach } from 'vitest';

// Re-export the global mockFetch for ergonomic test access.
// EM-STRAT-007 §1: no disable/enable methods on the type.
export const mockFetch = (globalThis as any).mockFetch as {
  register(
    pattern: RegExp | string,
    response:
      | { ok?: boolean; status?: number; json?: () => Promise<unknown>; text?: () => Promise<string>; headers?: Record<string, string> }
      | ((url: string, init?: RequestInit) => any),
  ): void;
  clear(): void;
  callCount(pattern: RegExp | string): number;
  calls: Array<{ url: string; init?: RequestInit }>;
};

// ─── Default mock responses ────────────────────────────────────────────
//
// These are minimal valid responses that allow scanner.scan() to complete
// without throwing and return a deterministic result (typically []).

const EMPTY_DATA_RESPONSE = {
  status: 200,
  json: async () => ({ data: [] }),
};

const EMPTY_ARRAY_RESPONSE = {
  status: 200,
  json: async () => [],
};

const EMPTY_OBJECT_RESPONSE = {
  status: 200,
  json: async () => ({}),
};

/**
 * Register all default offline mocks. Call this in a `beforeEach` if the
 * test file exercises any scanner's `scan()` method. The mocks return
 * minimal valid responses that cause scanners to return empty arrays.
 */
export function registerDefaultOfflineMocks() {
  // DeFiLlama yields API — used by defillama-yield-scanner and rwa-treasury-scanner.
  mockFetch.register('yields.llama.fi', EMPTY_DATA_RESPONSE);
  // DeFiLlama protocols API — used by whale-signal-scanner.
  mockFetch.register('api.llama.fi/protocols', EMPTY_ARRAY_RESPONSE);

  // Pendle Boros API — used by pendle-boros-scanner.
  mockFetch.register('api-boros.pendle.finance', EMPTY_ARRAY_RESPONSE);
  // Pendle core API — used by pt-yield-arb-scanner (via PendleClient).
  mockFetch.register('api-v2.pendle.finance', { status: 200, json: async () => ({ markets: [] }) });

  // Hyperliquid info API — used by funding-divergence, liquidation-backrun,
  // orderbook-imbalance, whale-signal, cex-dex-bridge scanners.
  mockFetch.register('api.hyperliquid.xyz/info', EMPTY_OBJECT_RESPONSE);

  // VOOI API — used by funding-divergence-scanner.
  mockFetch.register('perps-api.vooi.io', { status: 200, json: async () => ({ items: [], total: 0 }) });

  // CoinGecko API — used by cex-dex-bridge-scanner.
  mockFetch.register('api.coingecko.com', EMPTY_OBJECT_RESPONSE);

  // Binance API — used by gold-arb-scanner.
  mockFetch.register('api.binance.com', EMPTY_OBJECT_RESPONSE);
}

// Auto-register default mocks + clear between tests. Every test file that
// imports from this helper gets the default mocks automatically. Tests
// that need custom responses can call `mockFetch.register(...)` to override
// (registered mocks are checked in order; first match wins, so a custom
// mock registered BEFORE the defaults would win. Since `beforeEach` runs
// before each test and clears, custom registrations inside a test body
// happen AFTER defaults — but `register` adds to the end of the list, so
// defaults (registered first in beforeEach) take precedence. To override
// a default, tests should call `mockFetch.clear()` first, then register
// their custom mocks, then re-register any other defaults they need.
beforeEach(() => {
  mockFetch.clear();
  registerDefaultOfflineMocks();
});

afterEach(() => {
  mockFetch.clear();
});
