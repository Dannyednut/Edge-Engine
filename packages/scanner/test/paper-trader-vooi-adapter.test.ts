/**
 * paper-trader-vooi-adapter.test.ts — Direct adapter tests for the
 * fail-closed VOOI adapter (supervisor follow-up #2 on PR #3).
 *
 * Before this change, `vooiScan()` in the live script converted EVERY
 * non-2xx response into `{ items: [], total: 0 }`, so a 429/500 looked
 * like "no opportunities". The adapter now:
 *   - throws `VooiScanError('http', …, status)` on non-2xx
 *   - throws `VooiScanError('shape', …)` on invalid JSON / malformed shape
 *   - passes valid empty results (`{ items: [], total: 0 }`) through
 *     unchanged — an empty result is only ever a REAL empty result
 *
 * ALL tests use an injected mock fetch. No test touches the network
 * (the vitest offline guard also blocks any accidental external call).
 *
 * Coverage:
 *   1. Non-2xx HTTP statuses throw (429, 500, 403) with status preserved
 *   2. Invalid JSON body throws VooiScanError kind 'shape'
 *   3. Malformed response shapes throw VooiScanError kind 'shape'
 *   4. Valid empty results pass through (no throw)
 *   5. Valid non-empty results pass through unchanged
 *   6. Query params are serialized correctly; only the injected fetch is used
 *   7. runScan records VooiScanError failures in result.errors (both scans)
 */

import { describe, it, expect } from 'vitest';
import {
  vooiScan,
  validateVooiResponse,
  VooiScanError,
  runScan,
  SCAN_INTERVAL_MS,
} from '../src/lib/paper-trader-engine.js';
import type { VooiResponse } from '../src/lib/paper-trader-engine.js';
import type { AccountingState } from '../src/lib/paper-trader-accounting.js';

// ─── Mock fetch helpers ───────────────────────────────────────────────

/** Minimal Response-like object (no network, no real Response needed). */
function makeResponse(opts: {
  ok: boolean;
  status: number;
  statusText?: string;
  body?: string;
}): Response {
  return {
    ok: opts.ok,
    status: opts.status,
    statusText: opts.statusText ?? '',
    json: async () => {
      if (opts.body === undefined) {
        throw new TypeError('Unexpected end of JSON input');
      }
      return JSON.parse(opts.body) as unknown;
    },
  } as unknown as Response;
}

function makeMockFetch(res: Response | Error): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input));
    if (res instanceof Error) throw res;
    return res;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const BASE = 'https://vooi.test';

// ─── 1. Non-2xx HTTP statuses are visible failures ────────────────────

describe('vooiScan: non-2xx responses throw VooiScanError (never empty-result)', () => {
  it('HTTP 429 rate-limit throws VooiScanError kind http with status 429', async () => {
    const { fetchImpl } = makeMockFetch(makeResponse({ ok: false, status: 429, statusText: 'Too Many Requests' }));

    await expect(vooiScan(BASE, { limit: 10 }, fetchImpl)).rejects.toThrow(VooiScanError);
    await expect(vooiScan(BASE, { limit: 10 }, fetchImpl)).rejects.toMatchObject({
      kind: 'http',
      status: 429,
    });
  });

  it('HTTP 500 server error throws VooiScanError kind http with status 500', async () => {
    const { fetchImpl } = makeMockFetch(makeResponse({ ok: false, status: 500, statusText: 'Internal Server Error' }));

    const err = await vooiScan(BASE, {}, fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VooiScanError);
    expect((err as VooiScanError).kind).toBe('http');
    expect((err as VooiScanError).status).toBe(500);
    expect((err as VooiScanError).message).toContain('500');
  });

  it('HTTP 403 forbidden throws VooiScanError kind http', async () => {
    const { fetchImpl } = makeMockFetch(makeResponse({ ok: false, status: 403 }));

    await expect(vooiScan(BASE, {}, fetchImpl)).rejects.toMatchObject({
      kind: 'http',
      status: 403,
    });
  });

  it('error message is non-empty and mentions the endpoint', async () => {
    const { fetchImpl } = makeMockFetch(makeResponse({ ok: false, status: 502 }));

    const err = await vooiScan(BASE, {}, fetchImpl).catch((e: unknown) => e);
    expect((err as VooiScanError).message).toContain('arbitrage-scanner');
    expect((err as VooiScanError).message.length).toBeGreaterThan(10);
  });
});

// ─── 2. Invalid JSON is a visible failure ─────────────────────────────

describe('vooiScan: invalid JSON throws VooiScanError kind shape', () => {
  it('malformed JSON body throws shape error, not a raw SyntaxError', async () => {
    const { fetchImpl } = makeMockFetch(
      makeResponse({ ok: true, status: 200, body: '{"items": [NOT VALID JSON' }),
    );

    const err = await vooiScan(BASE, {}, fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VooiScanError);
    expect((err as VooiScanError).kind).toBe('shape');
    expect((err as VooiScanError).message).toContain('invalid JSON');
  });

  it('empty body (unexpected end of JSON input) throws shape error', async () => {
    const { fetchImpl } = makeMockFetch(makeResponse({ ok: true, status: 200 }));

    const err = await vooiScan(BASE, {}, fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VooiScanError);
    expect((err as VooiScanError).kind).toBe('shape');
  });
});

// ─── 3. Malformed shapes are visible failures ─────────────────────────

describe('vooiScan: malformed response shape throws VooiScanError kind shape', () => {
  const cases: Array<{ name: string; body: unknown }> = [
    { name: 'body is an array', body: [] },
    { name: 'body is null', body: null },
    { name: 'body is a string', body: 'hello' },
    { name: 'items is a string', body: { items: 'not-an-array' } },
    { name: 'items entry is null', body: { items: [null] } },
    { name: 'items entry lacks string asset', body: { items: [{ pairs: [] }] } },
    { name: 'items entry asset is a number', body: { items: [{ asset: 42 }] } },
    { name: 'item.pairs is a string', body: { items: [{ asset: 'BTC', pairs: 'nope' }] } },
    { name: 'item.pairs entry is null', body: { items: [{ asset: 'BTC', pairs: [null] }] } },
    { name: 'total is a string', body: { items: [], total: 'many' } },
    { name: 'total is NaN-like garbage object', body: { items: [], total: { n: 1 } } },
  ];

  for (const c of cases) {
    it(`rejects: ${c.name}`, async () => {
      const { fetchImpl } = makeMockFetch(
        makeResponse({ ok: true, status: 200, body: JSON.stringify(c.body) }),
      );
      const err = await vooiScan(BASE, {}, fetchImpl).catch((e: unknown) => e);
      expect(err, `expected VooiScanError for case: ${c.name}`).toBeInstanceOf(VooiScanError);
      expect((err as VooiScanError).kind).toBe('shape');
    });
  }

  it('validateVooiResponse rejects non-finite total directly', () => {
    expect(() => validateVooiResponse({ items: [], total: Number.NaN })).toThrow(VooiScanError);
    expect(() => validateVooiResponse({ items: [], total: Number.POSITIVE_INFINITY })).toThrow(VooiScanError);
  });
});

// ─── 4/5. Valid payloads pass through unchanged ───────────────────────

describe('vooiScan: valid results (including empty) pass through', () => {
  it('valid empty result { items: [], total: 0 } does NOT throw', async () => {
    const { fetchImpl } = makeMockFetch(
      makeResponse({ ok: true, status: 200, body: JSON.stringify({ items: [], total: 0 }) }),
    );

    const resp = await vooiScan(BASE, { limit: 10 }, fetchImpl);
    expect(resp).toEqual({ items: [], total: 0 });
  });

  it('valid result with missing items key passes (items optional)', async () => {
    const { fetchImpl } = makeMockFetch(
      makeResponse({ ok: true, status: 200, body: JSON.stringify({ total: 0 }) }),
    );

    const resp = await vooiScan(BASE, {}, fetchImpl);
    expect(resp).toEqual({ total: 0 });
  });

  it('valid non-empty result passes through unchanged', async () => {
    const payload = {
      items: [
        {
          asset: 'BTC',
          pairs: [
            {
              priceSpread: 0.008,
              fundingSpread1h: 0.0004,
              long: { exchange: 'binance', price: '100' },
              short: { exchange: 'bybit', price: '99' },
            },
          ],
        },
      ],
      total: 1,
    };
    const { fetchImpl } = makeMockFetch(
      makeResponse({ ok: true, status: 200, body: JSON.stringify(payload) }),
    );

    const resp = await vooiScan(BASE, { limit: 10, orderBy: 'priceSpread' }, fetchImpl);
    expect(resp).toEqual(payload);
    expect(resp.items?.[0]?.pairs?.[0]?.priceSpread).toBe(0.008);
  });

  it('item with pairs absent passes (pairs optional per VooiItem)', async () => {
    const payload = { items: [{ asset: 'ETH' }], total: 1 };
    const { fetchImpl } = makeMockFetch(
      makeResponse({ ok: true, status: 200, body: JSON.stringify(payload) }),
    );

    const resp = await vooiScan(BASE, {}, fetchImpl);
    expect(resp).toEqual(payload);
  });
});

// ─── 6. Query serialization + transport isolation ────────────────────

describe('vooiScan: request construction and offline transport', () => {
  it('serializes defined params into the query string, skipping null/undefined', async () => {
    const { fetchImpl, calls } = makeMockFetch(
      makeResponse({ ok: true, status: 200, body: JSON.stringify({ items: [], total: 0 }) }),
    );

    await vooiScan(
      BASE,
      { limit: 10, orderBy: 'priceSpread', orderDirection: 'desc', minPriceSpread: 0.005, skip: undefined, drop: null },
      fetchImpl,
    );

    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(
      `${BASE}/arbitrage-scanner?limit=10&orderBy=priceSpread&orderDirection=desc&minPriceSpread=0.005`,
    );
  });

  it('empty params produce a bare endpoint URL', async () => {
    const { fetchImpl, calls } = makeMockFetch(
      makeResponse({ ok: true, status: 200, body: JSON.stringify({ items: [], total: 0 }) }),
    );

    await vooiScan(BASE, {}, fetchImpl);
    expect(calls[0]).toBe(`${BASE}/arbitrage-scanner?`);
  });

  it('transport errors (network layer) propagate — runScan records them', async () => {
    const { fetchImpl } = makeMockFetch(new Error('ECONNREFUSED'));
    await expect(vooiScan(BASE, {}, fetchImpl)).rejects.toThrow('ECONNREFUSED');
  });
});

// ─── 7. runScan records adapter failures in result.errors ────────────

describe('runScan integration: VooiScanError surfaces in result.errors', () => {
  function makeDeps(opts: {
    priceSpreadArbs?: () => Promise<VooiResponse>;
    fundingArbs?: () => Promise<VooiResponse>;
  }): Parameters<typeof runScan>[0] {
    return {
      fetchPriceSpreadArbs: opts.priceSpreadArbs ?? (async () => ({ items: [], total: 0 })),
      fetchFundingArbs: opts.fundingArbs ?? (async () => ({ items: [], total: 0 })),
      now: () => 1_000_000,
      loadState: () => null,
      saveState: (_state: AccountingState) => {},
      logTrade: (_entry: Record<string, unknown>) => {},
      creditUnverified: false,
      scanIntervalMs: SCAN_INTERVAL_MS,
    };
  }

  it('price-spread scan failure (HTTP 429) is recorded, arbTradesExecuted = 0, no fabricated P&L', async () => {
    const deps = makeDeps({
      priceSpreadArbs: () => vooiScan(BASE, { limit: 10 }, makeMockFetch(
        makeResponse({ ok: false, status: 429 }),
      ).fetchImpl),
    });

    const result = await runScan(deps);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('Price-spread scan failed');
    expect(result.errors[0]).toContain('429');
    expect(result.arbTradesExecuted).toBe(0);
    expect(result.summary.pnl.arb).toBe(0);
  });

  it('funding scan failure (HTTP 500) is recorded, fundingPositionsOpened = 0', async () => {
    const deps = makeDeps({
      fundingArbs: () => vooiScan(BASE, { limit: 10 }, makeMockFetch(
        makeResponse({ ok: false, status: 500 }),
      ).fetchImpl),
    });

    const result = await runScan(deps);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('Funding-rate scan failed');
    expect(result.errors[0]).toContain('500');
    expect(result.fundingPositionsOpened).toBe(0);
  });

  it('shape failure (malformed payload) is recorded as a scan failure', async () => {
    const deps = makeDeps({
      priceSpreadArbs: () => vooiScan(BASE, {}, makeMockFetch(
        makeResponse({ ok: true, status: 200, body: JSON.stringify({ items: 'garbage' }) }),
      ).fetchImpl),
    });

    const result = await runScan(deps);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('Price-spread scan failed');
    expect(result.errors[0]).toContain('shape invalid');
  });
});
