import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FundingDivergenceScanner, formatFundingDegradation } from '../src/strategies/funding-divergence-scanner.js';
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

// ─── EM-STRAT-014-E11-Cluster2-R1 — VOOI OI from openInterest × price ───

describe('Cluster2-R1: VOOI OI parsed from actual response fields (openInterest × price)', () => {
  function makeVooiResponse(legOverrides: Record<string, unknown>): any {
    const leg = {
      exchange: 'hyperliquid',
      fundingRate: 0.02, // 0.02/h → 175.2%/yr (≥ 50 threshold)
      ...legOverrides,
    };
    return {
      items: [
        {
          asset: 'BTC',
          pairs: [{ long: leg, short: { exchange: 'binance', fundingRate: 0.0001, openInterest: '10', price: '100' } }],
        },
      ],
    };
  }

  it('openInterest=100, price=50000 → OI $5,000,000 → EXTREME_FUNDING reachable', async () => {
    const scanner = new FundingDivergenceScanner(PARAMS, { fetchImpl: fakeFetch({ hl: makeHlResponse([]), vooi: makeVooiResponse({ openInterest: '100', price: '50000' }) }), now: () => FIXED_NOW });
    const { alerts } = await scanner.scanWithDegradation();
    const extreme = alerts.find(a => a.type === 'EXTREME_FUNDING');
    expect(extreme).toBeDefined();
    expect(extreme!.oi).toBe(5_000_000);
    // +175.2%/yr funding → SHORT_HARVEST: the high-funding venue is the short leg.
    expect(extreme!.direction).toBe('SHORT_HARVEST');
    expect(extreme!.shortVenue).toBe('hyperliquid');
  });

  it('numeric openInterest/price fields also parse (schema-strict, not string-only)', async () => {
    const scanner = new FundingDivergenceScanner(PARAMS, { fetchImpl: fakeFetch({ hl: makeHlResponse([]), vooi: makeVooiResponse({ openInterest: 200, price: 25000 }) }), now: () => FIXED_NOW });
    const { alerts } = await scanner.scanWithDegradation();
    const extreme = alerts.find(a => a.type === 'EXTREME_FUNDING');
    expect(extreme).toBeDefined();
    expect(extreme!.oi).toBe(5_000_000);
  });

  it('missing openInterest → oi null → NO extreme alert (row still usable for DIVERGENCE, per item-5 design)', async () => {
    const scanner = new FundingDivergenceScanner(PARAMS, { fetchImpl: fakeFetch({ hl: makeHlResponse([]), vooi: makeVooiResponse({ price: '50000' }) }), now: () => FIXED_NOW });
    const { alerts, degradation } = await scanner.scanWithDegradation();
    expect(alerts.find(a => a.type === 'EXTREME_FUNDING')).toBeUndefined();
    // Not a skip: the row still carries a valid funding rate for divergence
    // detection — only EXTREME_FUNDING excludes null-OI rows.
    expect(degradation.vooiSkipped).toBe(0);
  });

  it('NaN openInterest / zero price / negative fields → oi null → NO extreme alert', async () => {
    for (const bad of [{ openInterest: 'not-a-number', price: '50000' }, { openInterest: '100', price: '0' }, { openInterest: '-5', price: '50000' }, { openInterest: NaN, price: '50000' }]) {
      const scanner = new FundingDivergenceScanner(PARAMS, { fetchImpl: fakeFetch({ hl: makeHlResponse([]), vooi: makeVooiResponse(bad) }), now: () => FIXED_NOW });
      const { alerts } = await scanner.scanWithDegradation();
      expect(alerts.find(a => a.type === 'EXTREME_FUNDING'), `case ${JSON.stringify(bad)}`).toBeUndefined();
    }
  });

  it('precomputed oiUsd field alone does NOT satisfy OI (not part of provider schema)', async () => {
    // A payload carrying only a dead `oiUsd` field (no openInterest/price)
    // must NOT produce a non-null OI.
    const scanner = new FundingDivergenceScanner(PARAMS, { fetchImpl: fakeFetch({ hl: makeHlResponse([]), vooi: makeVooiResponse({ oiUsd: 9_999_999 }) }), now: () => FIXED_NOW });
    const { alerts } = await scanner.scanWithDegradation();
    expect(alerts.find(a => a.type === 'EXTREME_FUNDING')).toBeUndefined();
  });
});

// ─── EM-STRAT-014-E11-Cluster2-R2 — strict full-string numeric grammar ──

describe('Cluster2-R2: strict full-string numeric validation (parseFloat prefix parsing removed)', () => {
  function makeVooiResponse(legOverrides: Record<string, unknown>): any {
    const leg = {
      exchange: 'hyperliquid',
      fundingRate: 0.02, // 0.02/h → 175.2%/yr (≥ 50 threshold)
      ...legOverrides,
    };
    return {
      items: [
        {
          asset: 'BTC',
          pairs: [{ long: leg, short: { exchange: 'binance', fundingRate: 0.0001, openInterest: '10', price: '100' } }],
        },
      ],
    };
  }

  /**
   * Work-order-mandated prefix traps. Under the R1 parseFloat helper each of
   * these converts to a number that CROSSES the $1M EXTREME_FUNDING OI gate
   * (100 × 50,000 = $5,000,000 or 50,000 × 100 = $5,000,000) — the exact
   * fabrication R2 closes. Under the strict full-string grammar each must
   * yield oi=null: no EXTREME_FUNDING, the row stays usable for DIVERGENCE
   * (R1 semantics preserved), and nothing is silently skipped.
   */
  const GATE_CROSSING_PREFIX_TRAPS: Array<[string, Record<string, unknown>]> = [
    ['openInterest numeric suffix', { openInterest: '100garbage', price: '50000' }],
    ['price currency suffix', { openInterest: '100', price: '50000USD' }],
    ['malformed exponent with trailing junk', { openInterest: '1e2JUNK', price: '50000' }],
  ];

  for (const [name, bad] of GATE_CROSSING_PREFIX_TRAPS) {
    it(`prefix trap rejected → NO EXTREME_FUNDING (${name}; permissive parse would fabricate OI $5,000,000)`, async () => {
      const scanner = new FundingDivergenceScanner(PARAMS, { fetchImpl: fakeFetch({ hl: makeHlResponse([]), vooi: makeVooiResponse(bad) }), now: () => FIXED_NOW });
      const { alerts, degradation } = await scanner.scanWithDegradation();
      expect(alerts.find(a => a.type === 'EXTREME_FUNDING'), `case ${JSON.stringify(bad)}`).toBeUndefined();
      // Row remains usable for DIVERGENCE with null OI (R1 design intact).
      const div = alerts.find(a => a.type === 'DIVERGENCE');
      expect(div, `DIVERGENCE still emitted for ${JSON.stringify(bad)}`).toBeDefined();
      expect(div!.oi).toBeNull();
      expect(degradation.vooiSkipped).toBe(0);
    });
  }

  /**
   * Broader grammar rejections. Each of these strings is either mis-parsed
   * to a numeric prefix by parseFloat ('1.2.3' → 1.2, '1e' → 1, '1e+' → 1,
   * '1 00' → 1, '1,000' → 1) or would be mis-accepted by a naive `Number()`
   * swap ('0x64' → 100 → $5,000,000). The strict grammar rejects them all,
   * so none may satisfy the EXTREME_FUNDING OI gate.
   */
  const OTHER_REJECTED_FORMS: Array<[string, unknown]> = [
    ['doubled decimal point', '1.2.3'],
    ['bare exponent', '1e'],
    ['dangling exponent sign', '1e+'],
    ['embedded whitespace', '1 00'],
    ['thousands separator', '1,000'],
    ['hex form', '0x64'],
    ['Infinity literal', 'Infinity'],
    ['NaN literal', 'NaN'],
    ['empty string', '   '],
  ];

  for (const [name, badOi] of OTHER_REJECTED_FORMS) {
    it(`non-grammar openInterest rejected → NO EXTREME_FUNDING (${name})`, async () => {
      const scanner = new FundingDivergenceScanner(PARAMS, { fetchImpl: fakeFetch({ hl: makeHlResponse([]), vooi: makeVooiResponse({ openInterest: badOi, price: '50000' }) }), now: () => FIXED_NOW });
      const { alerts } = await scanner.scanWithDegradation();
      expect(alerts.find(a => a.type === 'EXTREME_FUNDING'), `case ${JSON.stringify(badOi)}`).toBeUndefined();
    });
  }

  it('valid grammar forms remain ACCEPTED: trimmed whitespace, scientific notation, leading +', async () => {
    // Each triple below multiplies to exactly $5,000,000 (≥ $1M gate) and
    // 175.2%/yr (≥ 50 threshold) — EXTREME_FUNDING must fire with exact OI.
    const cases: Array<[unknown, unknown]> = [
      ['  100  ', '50000'], // surrounding whitespace trimmed, then full match
      ['1e2', '50000'], // scientific notation
      ['1E2', '5e4'], // uppercase exponent + exponent on price
      ['+100', '50000.0'], // explicit sign + trailing-dot decimal
      ['100.000', '50000'], // trailing fraction zeros
    ];
    for (const [oi, px] of cases) {
      const scanner = new FundingDivergenceScanner(PARAMS, { fetchImpl: fakeFetch({ hl: makeHlResponse([]), vooi: makeVooiResponse({ openInterest: oi, price: px }) }), now: () => FIXED_NOW });
      const { alerts } = await scanner.scanWithDegradation();
      const extreme = alerts.find(a => a.type === 'EXTREME_FUNDING');
      expect(extreme, `case openInterest=${JSON.stringify(oi)} price=${JSON.stringify(px)}`).toBeDefined();
      expect(extreme!.oi).toBe(5_000_000);
    }
  });

  it('exponent-form string whose VALUE is finite but grammar-broken stays null (e.g. "1e2 " with inner junk)', async () => {
    // '1e2 ' trims to '1e2' (accepted); but ' 1e2 JUNK' does not. Prove the
    // trim-then-full-match order with a suffix case that would parse to 100
    // under parseFloat.
    const scanner = new FundingDivergenceScanner(PARAMS, { fetchImpl: fakeFetch({ hl: makeHlResponse([]), vooi: makeVooiResponse({ openInterest: '1e2 JUNK', price: '50000' }) }), now: () => FIXED_NOW });
    const { alerts } = await scanner.scanWithDegradation();
    expect(alerts.find(a => a.type === 'EXTREME_FUNDING')).toBeUndefined();
  });
});

// ─── EM-STRAT-014-E11-Cluster2-R1 — production-visible degradation ──────

describe('Cluster2-R1: degradation reaches production observability', () => {
  it('formatFundingDegradation: ok form lists counts without failure flags', () => {
    const s = formatFundingDegradation({ hlFailed: false, vooiFailed: false, hlSkipped: 2, vooiSkipped: 3 });
    expect(s).toContain('[funding_divergence] ok');
    expect(s).toContain('hlSkipped=2');
    expect(s).toContain('vooiSkipped=3');
    expect(s).not.toContain('DEGRADED');
  });

  it('formatFundingDegradation: failed APIs → explicit DEGRADED flags', () => {
    const s = formatFundingDegradation({ hlFailed: true, vooiFailed: true, hlSkipped: 0, vooiSkipped: 0 });
    expect(s).toContain('DEGRADED');
    expect(s).toContain('HL_FETCH_FAILED');
    expect(s).toContain('VOOI_FETCH_FAILED');
  });

  it('empty VOOI ({items:[]}) → vooiFailed flag → formatter renders DEGRADED (never confusable with "no opportunities")', async () => {
    const scanner = new FundingDivergenceScanner(PARAMS, { fetchImpl: fakeFetch({ hl: makeHlResponse([]), vooi: { items: [] } }), now: () => FIXED_NOW });
    const { alerts, degradation } = await scanner.scanWithDegradation();
    expect(alerts).toEqual([]);
    expect(degradation.vooiFailed).toBe(true);
    expect(formatFundingDegradation(degradation)).toContain('VOOI_FETCH_FAILED');
  });

  it('all-runner.ts wiring (static source): calls scanWithDegradation and logs formatFundingDegradation on every scan', () => {
    // Static-source assertion mirroring the execution-containment pattern:
    // the production runner must consume the degradation API (not scan(),
    // which discards it) and must log the formatted marker.
    const src = readFileSync(resolve(__dirname, '..', 'src', 'runners', 'all-runner.ts'), 'utf8');
    expect(src).toMatch(/fundingDivergence\.scanWithDegradation\(\)/);
    expect(src).not.toMatch(/fundingDivergence\.scan\(\)/);
    expect(src).toContain('formatFundingDegradation(fundingDivDegradation)');
  });
});

// ─── E-12 (Issue #17) — interval-aware annualization + gross/net honesty ──

import { annualizeFundingRate, ASSUMED_FUNDING_INTERVAL_HOURS } from '../src/strategies/funding-divergence-scanner.js';

describe('E-12 — annualizeFundingRate (interval-aware, fail-closed)', () => {
  it('1h interval: 0.0001/h → 0.876 decimal APR (87.6%/yr)', () => {
    expect(annualizeFundingRate(0.0001, 1)).toBeCloseTo(0.876, 12);
  });

  it('8h interval: 0.0008/8h → 0.876 decimal APR (same annual, different interval)', () => {
    expect(annualizeFundingRate(0.0008, 8)).toBeCloseTo(0.876, 12);
  });

  it('1h and 8h representations of the SAME economics annualize identically', () => {
    // 0.01%/h ≡ 0.08%/8h — interval-aware normalization must not confuse them
    expect(annualizeFundingRate(0.0008, 8)).toBeCloseTo(annualizeFundingRate(0.0001, 1), 12);
  });

  it('24h interval: 0.01/day → 3.65 decimal APR (365%/yr — daily rate × 365)', () => {
    expect(annualizeFundingRate(0.01, 24)).toBeCloseTo(3.65, 12);
  });

  it('negative rates annualize sign-preserving (short-harvest detection depends on it)', () => {
    expect(annualizeFundingRate(-0.0001, 1)).toBeCloseTo(-0.876, 12);
  });

  it('fails closed on malformed rates (NaN / Infinity / non-number)', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '0.01' as unknown as number, null as unknown as number]) {
      expect(() => annualizeFundingRate(bad, 1), `rate ${String(bad)}`).toThrow(/ratePerInterval/);
    }
  });

  it('fails closed on missing/invalid intervals (0, negative, NaN, Infinity) — never silently annualizes as hourly', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '8' as unknown as number]) {
      expect(() => annualizeFundingRate(0.0001, bad), `interval ${String(bad)}`).toThrow(/intervalHours/);
    }
  });

  it('ASSUMED_FUNDING_INTERVAL_HOURS is the documented 1h basis', () => {
    expect(ASSUMED_FUNDING_INTERVAL_HOURS).toBe(1);
  });
});

describe('E-12 — funding_divergence alerts are gross-indicative, never net', () => {
  it('DIVERGENCE alert carries dailyGrossIndicativeOn5k = deprecated dailyProfitOn5k = gross value; netEconomics unavailable; 1h-assumed', async () => {
    // HL PEPE 30%/yr gross, VOOI 1000PEPE 60%/yr gross → divergence 30 pct-points/yr
    const hl = makeHlResponse([
      { name: 'PEPE', funding: '0.0034247', openInterest: '0', markPx: '0' },
    ]);
    const vooi = {
      items: [{
        asset: '1000PEPE',
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
    const { alerts } = await scanner.scanWithDegradation();
    const div = alerts.find(a => a.type === 'DIVERGENCE');
    expect(div).toBeDefined();
    // Gross daily figure: 5000 × 30/100 / 365 ≈ $4.11 — INDICATIVE ONLY
    expect(div!.dailyGrossIndicativeOn5k).toBeCloseTo(5000 * div!.divergence / 100 / 365, 10);
    // The deprecated alias carries the SAME value and nothing more
    expect(div!.dailyProfitOn5k).toBe(div!.dailyGrossIndicativeOn5k);
    // Net economics are explicitly UNAVAILABLE (no fee/holding/basis model)
    expect(div!.netEconomics).toBe('unavailable');
    expect(div!.fundingIntervalAssumption).toBe('1h-assumed');
  });

  it('EXTREME_FUNDING alert is equally labeled gross-indicative with net unavailable', async () => {
    const hl = makeHlResponse([
      { name: 'BTC', funding: '0.02', openInterest: '100', markPx: '50000' },
    ]);
    const scanner = new FundingDivergenceScanner(PARAMS, {
      fetchImpl: fakeFetch({ hl, vooi: { items: [] } }),
      now: () => FIXED_NOW,
    });
    const { alerts } = await scanner.scanWithDegradation();
    const extreme = alerts.find(a => a.type === 'EXTREME_FUNDING');
    expect(extreme).toBeDefined();
    expect(extreme!.dailyGrossIndicativeOn5k).toBeCloseTo(5000 * extreme!.divergence / 100 / 365, 10);
    expect(extreme!.dailyProfitOn5k).toBe(extreme!.dailyGrossIndicativeOn5k);
    expect(extreme!.netEconomics).toBe('unavailable');
    expect(extreme!.fundingIntervalAssumption).toBe('1h-assumed');
  });

  it('malformed VOOI fundingRate strings are skipped with vooiSkipped degradation (failure behavior)', async () => {
    const hl = makeHlResponse([]);
    const vooi = {
      items: [{
        asset: 'BTC',
        pairs: [{
          long: { exchange: 'Binance', fundingRate: 'not-a-number' },
          short: { exchange: 'HL', fundingRate: 0.001 },
        }],
      }],
    };
    const scanner = new FundingDivergenceScanner(PARAMS, {
      fetchImpl: fakeFetch({ hl, vooi }),
      now: () => FIXED_NOW,
    });
    const { degradation } = await scanner.scanWithDegradation();
    expect(degradation.vooiSkipped).toBeGreaterThanOrEqual(1);
  });
});
