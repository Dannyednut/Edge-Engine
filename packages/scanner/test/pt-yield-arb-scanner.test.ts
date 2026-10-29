import { describe, it, expect } from 'vitest';
import { PtYieldArbScanner } from '../src/strategies/pt-yield-arb-scanner.js';
import { PendleClient } from '../src/lib/pendle-client.js';
import './_setup/offline-mocks.js';

const PARAMS = {
  minYieldSpreadPct: 3.0,
  minTvlUsd: 500_000,
  maxImpliedApyPct: 50,
  khypeFloatingYieldApr: 2.37,
};

const FUTURE_EXPIRY = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10);

function makePendleClient(markets: any[]): PendleClient {
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ results: markets }),
  })) as unknown as typeof fetch;
  return new PendleClient({ fetchImpl });
}

function validMarket(overrides: Partial<any> = {}): any {
  return {
    name: 'stHYPE',
    protocol: 'Pendle',
    address: '0xabc',
    expiry: FUTURE_EXPIRY,
    pt: '999-0xpt',
    yt: '999-0xyt',
    sy: '999-0xsy',
    underlyingAsset: '0xu',
    chainId: 999,
    details: {
      liquidity: 1_000_000,
      totalTvl: 2_000_000,
      tradingVolume: 500_000,
      underlyingApy: 0.0256,   // 2.56%
      impliedApy: 0.1796,     // 17.96%
      aggregatedApy: 0.15,
      totalPt: 1_000_000,
      totalSy: 1_000_000,
      totalSupply: 2_000_000,
    },
    ...overrides,
  };
}

describe('PtYieldArbScanner', () => {
  it('implements Strategy interface', () => {
    const scanner = new PtYieldArbScanner(PARAMS);
    expect(scanner.id).toBe('pt_yield_arb');
    expect(scanner.landscape).toBe('F_perps_funding');
  });

  it('riskParams returns valid params', () => {
    const scanner = new PtYieldArbScanner(PARAMS);
    const rp = scanner.riskParams();
    expect(rp.maxSizeUsd).toBe(5_000);
    expect(rp.maxConcurrent).toBe(3);
  });

  it('scan returns array', async () => {
    const scanner = new PtYieldArbScanner(PARAMS);
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
  });

  // ── EM-STRAT-014-E11 item 3: underlyingApy rejection ─────────────────
  //
  // Reject missing / non-finite / non-positive underlyingApy. Do NOT default
  // to 0 (which would fabricate a false spread). Do NOT invent payload age
  // (the 90-day fallback for missing expiry is removed).

  it('T3a: valid market with positive underlyingApy produces an alert (positive control)', async () => {
    const pc = makePendleClient([validMarket()]);
    const scanner = new PtYieldArbScanner(PARAMS, { pendle: pc });
    const alerts = await scanner.scan();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].underlyingApyPct).toBeCloseTo(2.56, 2);
  });

  it('T3b: missing underlyingApy (undefined) → market rejected, no alert', async () => {
    const m = validMarket();
    delete m.details.underlyingApy;
    const scanner = new PtYieldArbScanner(PARAMS, { pendle: makePendleClient([m]) });
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  it('T3c: null underlyingApy → market rejected', async () => {
    const m = validMarket({ details: { ...validMarket().details, underlyingApy: null as any } });
    const scanner = new PtYieldArbScanner(PARAMS, { pendle: makePendleClient([m]) });
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  it('T3d: non-finite underlyingApy (NaN) → market rejected', async () => {
    const m = validMarket({ details: { ...validMarket().details, underlyingApy: NaN } });
    const scanner = new PtYieldArbScanner(PARAMS, { pendle: makePendleClient([m]) });
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  it('T3e: non-finite underlyingApy (Infinity) → market rejected', async () => {
    const m = validMarket({ details: { ...validMarket().details, underlyingApy: Infinity } });
    const scanner = new PtYieldArbScanner(PARAMS, { pendle: makePendleClient([m]) });
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  it('T3f: non-positive underlyingApy (0) → market rejected', async () => {
    const m = validMarket({ details: { ...validMarket().details, underlyingApy: 0 } });
    const scanner = new PtYieldArbScanner(PARAMS, { pendle: makePendleClient([m]) });
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  it('T3g: non-positive underlyingApy (negative, e.g. stale -1 sentinel) → market rejected', async () => {
    const m = validMarket({ details: { ...validMarket().details, underlyingApy: -1 } });
    const scanner = new PtYieldArbScanner(PARAMS, { pendle: makePendleClient([m]) });
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  // ── EM-STRAT-014-E11 item 3: do NOT invent payload age ───────────────

  it('T3h: missing expiry → market rejected (no fabricated 90-day fallback)', async () => {
    const m = validMarket();
    delete m.expiry;
    const scanner = new PtYieldArbScanner(PARAMS, { pendle: makePendleClient([m]) });
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  it('T3i: empty-string expiry → market rejected', async () => {
    const m = validMarket({ expiry: '' });
    const scanner = new PtYieldArbScanner(PARAMS, { pendle: makePendleClient([m]) });
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  it('T3j: malformed expiry string → market rejected', async () => {
    const m = validMarket({ expiry: 'not-a-date' });
    const scanner = new PtYieldArbScanner(PARAMS, { pendle: makePendleClient([m]) });
    const alerts = await scanner.scan();
    expect(alerts).toEqual([]);
  });

  it('T3k: invalid underlyingApy in one market does NOT block other valid markets', async () => {
    const bad = validMarket({ name: 'badHYPE', details: { ...validMarket().details, underlyingApy: -1 } });
    const good = validMarket({ name: 'stHYPE2' });
    const scanner = new PtYieldArbScanner(PARAMS, { pendle: makePendleClient([bad, good]) });
    const alerts = await scanner.scan();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].lst).toBe('stHYPE2');
  });
});
