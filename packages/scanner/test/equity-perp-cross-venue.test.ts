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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EquityPerpCrossVenueScanner, formatEquityPerpDegradation } from '../src/strategies/equity-perp-cross-venue.js';
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

  it('T6c (Cluster3-R1 REWRITTEN): empty dexScopes → FAIL CLOSED — zero HL queries, degradation reason hip3_scope_roster_unverified', async () => {
    const noDexParams = { minSpreadPct: 0.5, maxSizeUsd: 2000 };
    const ff = fakeFetch({ hl: makeHlResponse([]) });
    const scanner = new EquityPerpCrossVenueScanner(noDexParams, {
      fetchImpl: ff,
      backpackClient: mockBackpackClient({}),
    });
    const { alerts, degradation } = await scanner.scanWithDegradation();
    // No HL query may be issued at all — the legacy unscoped fallback is gone.
    const calls = (ff as any).__calls as { body: any }[];
    expect(calls.length).toBe(0);
    expect(alerts).toEqual([]);
    expect(degradation.reason).toBe('hip3_scope_roster_unverified');
    expect(degradation.issuedQueries).toBe(0);
    // The Strategy-interface scan() still works (discards degradation).
    expect(await scanner.scan()).toEqual([]);
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

// ─── EM-STRAT-014-E11-Cluster3-R1 — fail-closed HIP-3 scoping ───────────

describe('EquityPerpCrossVenueScanner — Cluster3-R1 fail-closed scoping', () => {
  const SCOPES = ['0x' + 'a1'.repeat(20), '0x' + 'b2'.repeat(20)];

  it('configured scopes are sent verbatim — one scoped query per deployer, dex field present', async () => {
    const ff = fakeFetch({ hl: makeHlResponse([{ name: 'AAPL', markPx: '150.00' }]) });
    const scanner = new EquityPerpCrossVenueScanner(
      { minSpreadPct: 0.5, maxSizeUsd: 2000, dexScopes: SCOPES },
      { fetchImpl: ff, backpackClient: mockBackpackClient({}) },
    );
    await scanner.scanWithDegradation();
    const calls = (ff as any).__calls as { body: any }[];
    expect(calls.length).toBe(2);
    expect(calls[0].body).toEqual({ type: 'metaAndAssetCtxs', dex: SCOPES[0] });
    expect(calls[1].body).toEqual({ type: 'metaAndAssetCtxs', dex: SCOPES[1] });
  });

  it('missing dexScopes field (undefined) → fail-closed, no query, roster-unverified reason', async () => {
    const ff = fakeFetch({ hl: makeHlResponse([]) });
    const scanner = new EquityPerpCrossVenueScanner(
      { minSpreadPct: 0.5, maxSizeUsd: 2000 } as any,
      { fetchImpl: ff, backpackClient: mockBackpackClient({}) },
    );
    const { degradation } = await scanner.scanWithDegradation();
    expect(((ff as any).__calls as unknown[]).length).toBe(0);
    expect(degradation.reason).toBe('hip3_scope_roster_unverified');
  });

  it('format-invalid scopes are rejected fail-closed (never sent), counted, reason hip3_scope_invalid_format', async () => {
    const ff = fakeFetch({ hl: makeHlResponse([]) });
    const scanner = new EquityPerpCrossVenueScanner(
      { minSpreadPct: 0.5, maxSizeUsd: 2000, dexScopes: ['not-an-address', '0x1234'] },
      { fetchImpl: ff, backpackClient: mockBackpackClient({}) },
    );
    const { degradation } = await scanner.scanWithDegradation();
    expect(((ff as any).__calls as unknown[]).length).toBe(0);
    expect(degradation.reason).toBe('hip3_scope_invalid_format');
    expect(degradation.failedScopes).toBe(2);
    expect(degradation.issuedQueries).toBe(0);
  });

  it('exact-symbol matching excludes XNVDA2 / NVDAx variants inside scoped universes', async () => {
    const ff = fakeFetch({ hl: makeHlResponse([
      { name: 'NVDA', markPx: '500.00' },
      { name: 'XNVDA2', markPx: '999.00' },
      { name: 'NVDAx', markPx: '888.00' },
      { name: 'MyNVDA', markPx: '777.00' },
    ]) });
    const scanner = new EquityPerpCrossVenueScanner(
      { minSpreadPct: 0.5, maxSizeUsd: 2000, dexScopes: [SCOPES[0]] },
      { fetchImpl: ff, backpackClient: mockBackpackClient({}) },
    );
    const { alerts } = await scanner.scanWithDegradation();
    // Only exact 'NVDA' enters the price map; the variants cannot produce
    // alerts (no Backpack prices configured here anyway) — prove via the
    // scan result plus direct behavior: no crash, no variant-based alert.
    expect(alerts).toEqual([]);
    // Rerun with a Backpack NVDA price: the ONLY HL price available must be
    // the exact 'NVDA' 500.00, so the spread is computed against 500.00.
    const ff2 = fakeFetch({ hl: makeHlResponse([
      { name: 'NVDA', markPx: '500.00' },
      { name: 'NVDAx', markPx: '888.00' },
    ]) });
    const scanner2 = new EquityPerpCrossVenueScanner(
      { minSpreadPct: 0.5, maxSizeUsd: 2000, dexScopes: [SCOPES[0]] },
      { fetchImpl: ff2, backpackClient: mockBackpackClient({ NVDA: '504.00' }) },
    );
    const r2 = await scanner2.scanWithDegradation();
    expect(r2.alerts.length).toBe(1);
    expect(r2.alerts[0].hlPrice).toBe(500.00); // exact match only
    expect(r2.alerts[0].priceBasisMismatch).toBe(true);
  });

  it('missing scoped responses (non-ok) → visible degradation hip3_scoped_queries_failed', async () => {
    const ff = fakeFetch({ hl: makeHlResponse([]), hlOk: false });
    const scanner = new EquityPerpCrossVenueScanner(
      { minSpreadPct: 0.5, maxSizeUsd: 2000, dexScopes: [SCOPES[0]] },
      { fetchImpl: ff, backpackClient: mockBackpackClient({}) },
    );
    const { alerts, degradation } = await scanner.scanWithDegradation();
    expect(alerts).toEqual([]);
    expect(degradation.reason).toBe('hip3_scoped_queries_failed');
    expect(degradation.failedScopes).toBe(1);
    expect(degradation.issuedQueries).toBe(1);
    expect(formatEquityPerpDegradation(degradation)).toContain('DEGRADED');
  });

  it('partial scoped failures → hip3_scoped_queries_partial; formatter ok-form has no DEGRADED', async () => {
    let call = 0;
    const fn = (async (_u: string | URL | Request, _i?: RequestInit) => {
      call++;
      const ok = call === 1; // first scope ok, second fails
      return { ok, status: ok ? 200 : 500, json: async () => (ok ? makeHlResponse([]) : {}) } as any;
    }) as unknown as typeof fetch;
    const scanner = new EquityPerpCrossVenueScanner(
      { minSpreadPct: 0.5, maxSizeUsd: 2000, dexScopes: SCOPES },
      { fetchImpl: fn, backpackClient: mockBackpackClient({}) },
    );
    const { degradation } = await scanner.scanWithDegradation();
    expect(degradation.reason).toBe('hip3_scoped_queries_partial');
    expect(degradation.failedScopes).toBe(1);
    expect(degradation.issuedQueries).toBe(2);

    const okDeg = { reason: null, failedScopes: 0, issuedQueries: 2 };
    expect(formatEquityPerpDegradation(okDeg)).not.toContain('DEGRADED');
  });

  it('all-runner.ts wiring (static source): scanWithDegradation + formatEquityPerpDegradation + info/monitoring presenter', () => {
    const src = readFileSync(resolve(__dirname, '..', 'src', 'runners', 'all-runner.ts'), 'utf8');
    expect(src).toMatch(/equityPerpCrossVenue\.scanWithDegradation\(\)/);
    expect(src).not.toMatch(/equityPerpCrossVenue\.scan\(\)/);
    expect(src).toContain('formatEquityPerpDegradation(equityPerpDegradation)');
    // Monitoring-only presenter: severity 'info', explicit monitor title.
    expect(src).toContain("severity: 'info',\n          strategyId: 'equity_perp_cross_venue'");
    expect(src).toContain('[EQXV-MONITOR]');
  });

  it('strategy-configs.ts wiring (static source): dex_scopes config key exists with fail-closed default []', () => {
    const src = readFileSync(resolve(__dirname, '..', 'src', 'runners', 'strategy-configs.ts'), 'utf8');
    expect(src).toMatch(/dexScopes: strArr\(s, 'dex_scopes', \[\]\)/);
  });
});
