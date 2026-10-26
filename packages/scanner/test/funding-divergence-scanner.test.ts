import { describe, it, expect } from 'vitest';
import { FundingDivergenceScanner } from '../src/strategies/funding-divergence-scanner.js';
import './_setup/offline-mocks.js';

const PARAMS = {
  minDivergencePct: 20,
  minExtremeOiUsd: 1_000_000,
  extremeFundingThreshold: 50,
};

const FIXED_NOW = 1_700_000_000_000;

function fakeFetch(responses: { hl?: any; vooi?: any; hlOk?: boolean; vooiOk?: boolean }): typeof fetch {
  return (async (url: string | URL | Request, _init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('api.hyperliquid.xyz')) {
      const ok = responses.hlOk ?? true;
      return { ok, status: ok ? 200 : 500, json: async () => (ok ? responses.hl : {}) } as any;
    }
    if (u.includes('perps-api.vooi.io')) {
      const ok = responses.vooiOk ?? true;
      return { ok, status: ok ? 200 : 500, json: async () => (ok ? responses.vooi : { items: [] }) } as any;
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;
}

function makeHlResponse(perps: Array<{ name: string; funding: string; openInterest: string; markPx: string }>): any {
  return [
    { universe: perps.map(p => ({ name: p.name })) },
    perps.map(p => ({ funding: p.funding, openInterest: p.openInterest, markPx: p.markPx })),
  ];
}

describe('FundingDivergenceScanner — EM-STRAT-014-E11 items 4 + 5', () => {
  it('implements Strategy interface', () => {
    const scanner = new FundingDivergenceScanner(PARAMS);
    expect(scanner.id).toBe('funding_divergence');
    expect(scanner.landscape).toBe('F_perps_funding');
  });

  it('riskParams returns valid params', () => {
    const scanner = new FundingDivergenceScanner(PARAMS);
    const rp = scanner.riskParams();
    expect(rp.maxSizeUsd).toBe(10_000);
    expect(rp.maxConcurrent).toBe(5);
  });

  it('scan returns array', async () => {
    const scanner = new FundingDivergenceScanner(PARAMS);
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
  });

  // ── Item 5: HL res.ok check ──────────────────────────────────────────

  it('T5a: HL non-ok response → degradation.hlFailed = true, no crash', async () => {
    const scanner = new FundingDivergenceScanner(PARAMS, {
      fetchImpl: fakeFetch({ hlOk: false, vooi: { items: [] } }),
      now: () => FIXED_NOW,
    });
    const result = await scanner.scanWithDegradation();
    expect(result.degradation.hlFailed).toBe(true);
    expect(result.alerts).toEqual([]);
  });

  // ── Item 5: VOOI degradation marker (silent {items:[]} → visible) ────

  it('T5b: VOOI returns {items:[]} → degradation.vooiFailed = true (visible, not silent)', async () => {
    const scanner = new FundingDivergenceScanner(PARAMS, {
      fetchImpl: fakeFetch({ hl: makeHlResponse([]), vooi: { items: [] } }),
      now: () => FIXED_NOW,
    });
    const result = await scanner.scanWithDegradation();
    expect(result.degradation.vooiFailed).toBe(true);
  });

  it('T5c: VOOI non-ok response → degradation.vooiFailed = true', async () => {
    const scanner = new FundingDivergenceScanner(PARAMS, {
      fetchImpl: fakeFetch({ hl: makeHlResponse([]), vooiOk: false }),
      now: () => FIXED_NOW,
    });
    const result = await scanner.scanWithDegradation();
    expect(result.degradation.vooiFailed).toBe(true);
  });

  // ── Item 5: null OI excluded from EXTREME_FUNDING ────────────────────

  it('T5d: HL perp with extreme funding but missing OI (NaN) → oi=null, excluded from EXTREME_FUNDING', async () => {
    // funding=0.02 → annual=175% (above 50% threshold); openInterest=NaN → oi=null
    const hl = makeHlResponse([
      { name: 'BTC', funding: '0.02', openInterest: 'NaN', markPx: '50000' },
    ]);
    const scanner = new FundingDivergenceScanner(PARAMS, {
      fetchImpl: fakeFetch({ hl, vooi: { items: [] } }),
      now: () => FIXED_NOW,
    });
    const result = await scanner.scanWithDegradation();
    // No EXTREME_FUNDING alert because OI is null
    expect(result.alerts.filter(a => a.type === 'EXTREME_FUNDING')).toEqual([]);
  });

  it('T5e: HL perp with extreme funding and valid OI → EXTREME_FUNDING alert with non-null oi', async () => {
    // funding=0.02 → annual=175%; openInterest=100, markPx=50000 → OI=5,000,000
    const hl = makeHlResponse([
      { name: 'BTC', funding: '0.02', openInterest: '100', markPx: '50000' },
    ]);
    const scanner = new FundingDivergenceScanner(PARAMS, {
      fetchImpl: fakeFetch({ hl, vooi: { items: [] } }),
      now: () => FIXED_NOW,
    });
    const result = await scanner.scanWithDegradation();
    const extremes = result.alerts.filter(a => a.type === 'EXTREME_FUNDING');
    expect(extremes).toHaveLength(1);
    expect(extremes[0].oi).toBe(5_000_000);
    expect(extremes[0].oi).not.toBeNull();
  });

  // ── Item 5: scanTs / venueTs ────────────────────────────────────────

  it('T5f: alert carries scanTs = injected now, venueTs = null', async () => {
    const hl = makeHlResponse([
      { name: 'BTC', funding: '0.02', openInterest: '100', markPx: '50000' },
    ]);
    const scanner = new FundingDivergenceScanner(PARAMS, {
      fetchImpl: fakeFetch({ hl, vooi: { items: [] } }),
      now: () => FIXED_NOW,
    });
    const result = await scanner.scanWithDegradation();
    for (const a of result.alerts) {
      expect(a.scanTs).toBe(FIXED_NOW);
      expect(a.venueTs).toBeNull();
    }
  });

  // ── Item 4: alias canonicalization in funding join ──────────────────

  it('T5g: 1000PEPE (VOOI) and PEPE (HL) canonicalize to the same asset key → divergence detected', async () => {
    // HL: PEPE with 30% funding; VOOI: 1000PEPE with 60% funding → divergence=30%
    const hl = makeHlResponse([
      { name: 'PEPE', funding: '0.0034247', openInterest: '0', markPx: '0' }, // annual≈30%, OI=0 (won't trigger EXTREME)
    ]);
    const vooi = {
      items: [{
        asset: '1000PEPE',
        pairs: [{
          long: { exchange: 'Binance', fundingRate: 0.0068493 }, // annual≈60%
          short: { exchange: 'HL', fundingRate: 0 },
        }],
      }],
    };
    const scanner = new FundingDivergenceScanner(PARAMS, {
      fetchImpl: fakeFetch({ hl, vooi }),
      now: () => FIXED_NOW,
    });
    const result = await scanner.scanWithDegradation();
    const divergences = result.alerts.filter(a => a.type === 'DIVERGENCE');
    // Should find a PEPE divergence (30% ≥ 20% threshold) — alias match worked
    expect(divergences.length).toBeGreaterThanOrEqual(1);
    expect(divergences[0].asset).toBe('PEPE');
  });

  it('T5h: unmapped asset identities do NOT match (no false join)', async () => {
    // HL: FOOBAR with 30% funding; VOOI: DIFFERENTCOIN with 60% funding → no join
    const hl = makeHlResponse([
      { name: 'FOOBAR', funding: '0.0034247', openInterest: '0', markPx: '0' },
    ]);
    const vooi = {
      items: [{
        asset: 'DIFFERENTCOIN',
        pairs: [{
          long: { exchange: 'Binance', fundingRate: 0.0068493 },
          short: { exchange: 'HL', fundingRate: 0 },
        }],
      }],
    };
    const scanner = new FundingDivergenceScanner(PARAMS, {
      fetchImpl: fakeFetch({ hl, vooi }),
      now: () => FIXED_NOW,
    });
    const result = await scanner.scanWithDegradation();
    const divergences = result.alerts.filter(a => a.type === 'DIVERGENCE');
    // No divergence — FOOBAR ≠ DIFFERENTCOIN, no false match
    expect(divergences).toEqual([]);
  });

  // ── Item 5: VOOI ordering by funding spread (URL check) ─────────────

  it('T5i: VOOI fetch URL uses orderBy=fundingSpread1h (not priceSpread)', async () => {
    let capturedUrl = '';
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('perps-api.vooi.io')) capturedUrl = u;
      return { ok: true, status: 200, json: async () => ({ items: [] }) } as any;
    }) as unknown as typeof fetch;
    const scanner = new FundingDivergenceScanner(PARAMS, {
      fetchImpl,
      now: () => FIXED_NOW,
    });
    await scanner.scanWithDegradation();
    expect(capturedUrl).toContain('orderBy=fundingSpread1h');
    expect(capturedUrl).not.toContain('orderBy=priceSpread');
  });
});
