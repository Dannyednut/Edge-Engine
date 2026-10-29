import { describe, it, expect, vi } from 'vitest';
import { PendleBorosScanner } from '../src/strategies/pendle-boros-scanner.js';
import './_setup/offline-mocks.js';

const PARAMS = {
  minSpreadApr: 0.5,
  maxSizeUsd: 5_000,
  minNotionalOI: 50_000,
  platforms: [],
  minVolume24h: 100_000,
  minDaysToMaturity: 7,
  minSpreadPersistence: 1, // disable persistence for deterministic single-scan tests
};

const FUTURE_MATURITY_SEC = Math.floor((Date.now() + 90 * 86400000) / 1000);

function fakeFetch(markets: any[]): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ results: markets }),
  })) as unknown as typeof fetch;
}

function validMarket(overrides: Partial<any> = {}): any {
  return {
    marketId: 1,
    address: '0xabc',
    imData: { name: 'BTC-HL', symbol: 'BTC', maturity: FUTURE_MATURITY_SEC },
    metadata: { underlyingSymbol: 'BTC', maxLeverage: 3 },
    platform: { name: 'Hyperliquid' },
    data: {
      markApr: 0.05,        // 5% fixed
      floatingApr: 0.15,    // 15% floating → spread = 10% (well above 0.5% threshold)
      lastTradedApr: 0.08,
      midApr: 0.08,
      volume24h: 500_000,
      notionalOI: 100_000,
      nextSettlementTime: FUTURE_MATURITY_SEC,
    },
    ...overrides,
  };
}

describe('PendleBorosScanner', () => {
  it('implements Strategy interface', () => {
    const scanner = new PendleBorosScanner(PARAMS);
    expect(scanner.id).toBe('pendle_boros');
    expect(scanner.landscape).toBe('F_perps_funding');
  });

  it('riskParams flows maxSizeUsd from constructor', () => {
    const scanner = new PendleBorosScanner(PARAMS);
    const rp = scanner.riskParams();
    expect(rp.maxSizeUsd).toBe(5_000);
    expect(rp.maxConcurrent).toBe(3);
  });

  it('scan returns array', async () => {
    const scanner = new PendleBorosScanner(PARAMS);
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
  });

  // ── EM-STRAT-014-E11 item 2: markApr rejection ───────────────────────
  //
  // The scanner must reject markets where markApr is absent, null,
  // non-numeric, non-finite, or non-positive. Do NOT default to 0 (which
  // would fabricate a false spread and direction).

  it('T2a: valid market with positive markApr produces an alert (positive control)', async () => {
    const scanner = new PendleBorosScanner(PARAMS, { fetchImpl: fakeFetch([validMarket()]) } as any);
    const alerts = await scanner.scan();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].market.markApr).toBeCloseTo(0.05, 6);
  });

  it('T2b: absent markApr (undefined) → market rejected, no alert', async () => {
    const m = validMarket({ marketId: 2 });
    delete m.data.markApr;
    const scanner = new PendleBorosScanner(PARAMS, { fetchImpl: fakeFetch([m]) } as any);
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  it('T2c: null markApr → market rejected, no alert', async () => {
    const m = validMarket({ marketId: 3, data: { ...validMarket().data, markApr: null } });
    const scanner = new PendleBorosScanner(PARAMS, { fetchImpl: fakeFetch([m]) } as any);
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  it('T2d: non-numeric markApr (string) → market rejected', async () => {
    const m = validMarket({ marketId: 4, data: { ...validMarket().data, markApr: '10.76%' } });
    const scanner = new PendleBorosScanner(PARAMS, { fetchImpl: fakeFetch([m]) } as any);
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  it('T2e: non-finite markApr (NaN) → market rejected', async () => {
    const m = validMarket({ marketId: 5, data: { ...validMarket().data, markApr: NaN } });
    const scanner = new PendleBorosScanner(PARAMS, { fetchImpl: fakeFetch([m]) } as any);
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  it('T2f: non-finite markApr (Infinity) → market rejected', async () => {
    const m = validMarket({ marketId: 6, data: { ...validMarket().data, markApr: Infinity } });
    const scanner = new PendleBorosScanner(PARAMS, { fetchImpl: fakeFetch([m]) } as any);
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  it('T2g: non-positive markApr (0) → market rejected', async () => {
    const m = validMarket({ marketId: 7, data: { ...validMarket().data, markApr: 0 } });
    const scanner = new PendleBorosScanner(PARAMS, { fetchImpl: fakeFetch([m]) } as any);
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  it('T2h: non-positive markApr (negative) → market rejected', async () => {
    const m = validMarket({ marketId: 8, data: { ...validMarket().data, markApr: -0.05 } });
    const scanner = new PendleBorosScanner(PARAMS, { fetchImpl: fakeFetch([m]) } as any);
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  it('T2i: invalid markApr in one market does NOT block other valid markets', async () => {
    const bad = validMarket({ marketId: 9, data: { ...validMarket().data, markApr: null } });
    const good = validMarket({ marketId: 10 });
    const scanner = new PendleBorosScanner(PARAMS, { fetchImpl: fakeFetch([bad, good]) } as any);
    const alerts = await scanner.scan();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].market.marketId).toBe(10);
  });
});
