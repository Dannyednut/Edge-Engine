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
      return {
        ok, status: ok ? 200 : 500,
        json: async () => (ok ? responses.hl : {}),
      } as any;
    }
    if (u.includes('perps-api.vooi.io')) {
      const ok = responses.vooiOk ?? true;
      return {
        ok, status: ok ? 200 : 500,
        json: async () => (ok ? responses.vooi : { items: [] }),
      } as any;
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

describe('FundingDivergenceScanner', () => {
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

  // ── EM-STRAT-014-E11 item 1: scanTs / venueTs integrity ──────────────

  it('T1h: alert carries scanTs = injected now, venueTs = null (no fabricated venue timestamp)', async () => {
    // HL: one perp with extreme funding (fundingHourly=0.01 → annual=87.6%)
    const hl = makeHlResponse([
      { name: 'BTC', funding: '0.01', openInterest: '100', markPx: '50000' }, // OI = 100*50000 = 5,000,000
    ]);
    const scanner = new FundingDivergenceScanner(PARAMS, {
      fetchImpl: fakeFetch({ hl, vooi: { items: [] } }),
      now: () => FIXED_NOW,
    });
    const alerts = await scanner.scan();
    // 1 extreme-funding alert (87.6% >= 50% threshold, OI 5M >= 1M)
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    for (const a of alerts) {
      expect(a.scanTs).toBe(FIXED_NOW);
      expect(a.venueTs).toBeNull(); // EM-STRAT-014-E11 item 1: never fabricated
      expect(a.ts).toBe(FIXED_NOW); // deprecated alias = scanTs
    }
  });

  it('T1i: scanTs is NOT Date.now() — it is the injected clock value', async () => {
    const hl = makeHlResponse([
      { name: 'ETH', funding: '0.02', openInterest: '200', markPx: '3000' }, // annual=175%, OI=600,000 → <1M, no extreme
    ]);
    const scanner = new FundingDivergenceScanner(PARAMS, {
      fetchImpl: fakeFetch({ hl, vooi: { items: [] } }),
      now: () => FIXED_NOW,
    });
    const realNow = Date.now();
    const alerts = await scanner.scan();
    for (const a of alerts) {
      expect(a.scanTs).toBe(FIXED_NOW);
      expect(a.scanTs).not.toBe(realNow); // not the real clock
    }
  });
});
