/**
 * EM-STRAT-014-E11 item 6 — HIP-3 equity-perp query integrity tests.
 *
 * Proves:
 *   - HL query includes `dex` scoping when dexScopes is configured.
 *   - Exact symbol match (not substring): 'AAPLx' does NOT match 'AAPL'.
 *   - res.ok checked.
 *   - Mark-vs-last price basis labeled on every alert.
 *   - priceBasisMismatch = true on every alert.
 *
 * Offline: injected fetchImpl + mock BackpackClient. $0.
 */
import { describe, it, expect, vi } from 'vitest';
import { EquityPerpCrossVenueScanner } from '../src/strategies/equity-perp-cross-venue.js';
import './_setup/offline-mocks.js';

const PARAMS = {
  minSpreadPct: 0.5,
  maxSizeUsd: 2000,
  dexScopes: ['0x' + 'a1'.repeat(20)], // documented deployer census (test fixture)
};

function makeHlResponse(perps: Array<{ name: string; markPx: string }>): any {
  return [
    { universe: perps.map(p => ({ name: p.name })) },
    perps.map(p => ({ markPx: p.markPx })),
  ];
}

function fakeFetch(responses: { hl?: any; hlOk?: boolean }): typeof fetch {
  const calls: { url: string; body: any }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('api.hyperliquid.xyz')) {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      calls.push({ url: u, body });
      const ok = responses.hlOk ?? true;
      return { ok, status: ok ? 200 : 500, json: async () => (ok ? responses.hl : {}) } as any;
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;
  (fn as any).__calls = calls;
  return fn;
}

function mockBackpackClient(prices: Record<string, number>): any {
  return {
    getTicker: vi.fn(async (symbol: string) => {
      const asset = symbol.split('.')[0];
      const p = prices[asset];
      if (p === undefined) throw new Error('not listed');
      return { lastPrice: String(p) };
    }),
  };
}

describe('EquityPerpCrossVenueScanner — EM-STRAT-014-E11 item 6', () => {
  it('implements Strategy interface', () => {
    const scanner = new EquityPerpCrossVenueScanner(PARAMS);
    expect(scanner.id).toBe('equity_perp_cross_venue');
    expect(scanner.landscape).toBe('B_cex_cex');
  });

  // ── Item 6: dex scoping ─────────────────────────────────────────────

  it('T6a: HL query includes dex scoping when dexScopes is configured', async () => {
    const ff = fakeFetch({ hl: makeHlResponse([]) });
    const scanner = new EquityPerpCrossVenueScanner(PARAMS, {
      fetchImpl: ff,
      backpackClient: mockBackpackClient({}),
    });
    await scanner.scan();
    const calls = (ff as any).__calls as { body: any }[];
    expect(calls.length).toBe(1);
    expect(calls[0].body.dex).toBe(PARAMS.dexScopes[0]);
    expect(calls[0].body.type).toBe('metaAndAssetCtxs');
  });

  it('T6b: multiple dexScopes produce multiple scoped queries', async () => {
    const multiDexParams = { ...PARAMS, dexScopes: ['0x' + 'a1'.repeat(20), '0x' + 'b2'.repeat(20)] };
    const ff = fakeFetch({ hl: makeHlResponse([]) });
    const scanner = new EquityPerpCrossVenueScanner(multiDexParams, {
      fetchImpl: ff,
      backpackClient: mockBackpackClient({}),
    });
    await scanner.scan();
    const calls = (ff as any).__calls as { body: any }[];
    expect(calls.length).toBe(2);
    expect(calls[0].body.dex).toBe(multiDexParams.dexScopes[0]);
    expect(calls[1].body.dex).toBe(multiDexParams.dexScopes[1]);
  });

  it('T6c: empty dexScopes → unscoped query (legacy, no dex field)', async () => {
    const noDexParams = { minSpreadPct: 0.5, maxSizeUsd: 2000 };
    const ff = fakeFetch({ hl: makeHlResponse([]) });
    const scanner = new EquityPerpCrossVenueScanner(noDexParams, {
      fetchImpl: ff,
      backpackClient: mockBackpackClient({}),
    });
    await scanner.scan();
    const calls = (ff as any).__calls as { body: any }[];
    expect(calls.length).toBe(1);
    expect(calls[0].body.dex).toBeUndefined();
  });

  // ── Item 6: exact symbol match (not substring) ──────────────────────

  it('T6d: exact symbol match — AAPL matches AAPL, AAPLx does NOT match AAPL', async () => {
    const hl = makeHlResponse([
      { name: 'AAPL', markPx: '150.00' },
      { name: 'AAPLx', markPx: '999.00' }, // substring would falsely match
      { name: 'MyAAPL', markPx: '888.00' }, // substring would falsely match
    ]);
    const scanner = new EquityPerpCrossVenueScanner(PARAMS, {
      fetchImpl: fakeFetch({ hl }),
      backpackClient: mockBackpackClient({ AAPL: 151.50 }),
    });
    const alerts = await scanner.scan();
    // Only exact-match AAPL should appear; AAPLx and MyAAPL must NOT
    const assets = alerts.map(a => a.asset);
    expect(assets).toContain('AAPL');
    expect(assets).not.toContain('AAPLx');
    expect(assets).not.toContain('MyAAPL');
  });

  // ── Item 6: res.ok check ────────────────────────────────────────────

  it('T6e: HL non-ok response → no crash, no alerts', async () => {
    const scanner = new EquityPerpCrossVenueScanner(PARAMS, {
      fetchImpl: fakeFetch({ hlOk: false }),
      backpackClient: mockBackpackClient({ AAPL: 150 }),
    });
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  // ── Item 6: mark-vs-last price basis labeling ───────────────────────

  it('T6f: alert labels hlPriceBasis=mark, backpackPriceBasis=last, priceBasisMismatch=true', async () => {
    const hl = makeHlResponse([{ name: 'AAPL', markPx: '150.00' }]);
    const scanner = new EquityPerpCrossVenueScanner(PARAMS, {
      fetchImpl: fakeFetch({ hl }),
      backpackClient: mockBackpackClient({ AAPL: 151.50 }), // 1% spread > 0.5% threshold
    });
    const alerts = await scanner.scan();
    expect(alerts).toHaveLength(1);
    const a = alerts[0];
    expect(a.hlPriceBasis).toBe('mark');
    expect(a.backpackPriceBasis).toBe('last');
    expect(a.priceBasisMismatch).toBe(true);
    expect(a.hlPrice).toBe(150);
    expect(a.backpackPrice).toBe(151.5);
  });

  it('T6g: spread below minSpreadPct → no alert', async () => {
    const hl = makeHlResponse([{ name: 'AAPL', markPx: '150.00' }]);
    const scanner = new EquityPerpCrossVenueScanner(PARAMS, {
      fetchImpl: fakeFetch({ hl }),
      backpackClient: mockBackpackClient({ AAPL: 150.30 }), // 0.2% < 0.5%
    });
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  it('T6h: missing Backpack price → no alert for that asset', async () => {
    const hl = makeHlResponse([{ name: 'AAPL', markPx: '150.00' }]);
    const scanner = new EquityPerpCrossVenueScanner(PARAMS, {
      fetchImpl: fakeFetch({ hl }),
      backpackClient: mockBackpackClient({}), // AAPL not listed
    });
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });
});
