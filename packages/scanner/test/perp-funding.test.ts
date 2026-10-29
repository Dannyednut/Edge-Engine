import { describe, it, expect } from 'vitest';
import { PerpFundingStrategy, type PerpFundingAlert, type PerpFundingParams } from '../src/strategies/perp-funding.js';
import type { SharpeClient } from '@edge/sharpe-client';
import type { VooiClient, VooiArbitragePair } from '@edge/vooi-client';

// ─── EM-STRAT-014-E11-Cluster1-R1 — Sharpe freshness propagation ────────
//
// Offline, deterministic tests for the perp_funding consumer's freshness
// contract:
//   - A server-provided asOf is preserved end-to-end (sharpeAsOf verbatim,
//     freshness 'server-asof').
//   - An absent/null/malformed server asOf is labeled freshness 'unknown'
//     — never fabricated from local scan time, never guessed fresh/stale
//     (no freshness SLA is configured for this provider).
//   - VOOI agreement must NOT silently upgrade confidence for Sharpe data
//     whose freshness is unknown (cross-validated confidence 0.9 requires
//     a server-verified asOf; unknown caps at 0.7).
//   - VOOI-only alerts (no Sharpe row) are always freshness 'unknown'.
//
// All clients are recording stubs — zero network, zero I/O, no clock use.

const FIXED_NOW = 1_700_000_000_000;
const SERVER_ASOF = 1_699_999_500_000; // server observation time (≠ scan time)

const PARAMS: PerpFundingParams = {
  // E-12: canonical unit is DECIMAL-FRACTION APR — 0.08 = 8%/yr (matches
  // the production min_spread_apr default). The former test value (8) was
  // calibrated against the VOOI branch's ×100-inflated pct-points output.
  minSpreadApr: 0.08,
  longVenues: ['hyperliquid'],
  shortVenues: ['binance'],
  useVooiExecutor: false,
  vooiVenueSet: ['hyperliquid', 'binance'],
};

interface SharpeRowLike {
  coin?: string; asset?: string; symbol?: string;
  longExchange?: string; shortExchange?: string;
  netApr?: number; grossApr?: number;
  longOiUsd?: number; shortOiUsd?: number;
}

function makeSharpeClient(
  rows: SharpeRowLike[],
  meta: { asOf?: number | null } | undefined,
): SharpeClient {
  return {
    crossExchangeFunding: async () => ({ data: rows as any[], meta: meta as any }),
  } as unknown as SharpeClient;
}

function makeVooiPair(overrides: Partial<VooiArbitragePair> = {}): VooiArbitragePair {
  return {
    asset: 'BTC',
    long: {
      exchange: 'hyperliquid',
      fundingRate: '-0.00010',
      price: '50000',
      volume24h: 1e6,
      openInterest: '1000',
    },
    short: {
      exchange: 'binance',
      fundingRate: '0.00020',
      price: '50000',
      volume24h: 1e6,
      openInterest: '2000',
    },
    fundingSpread1h: 0.0003,
    maxFundingSpread1h: 0.0003,
    maxFundingSpread24h: 0.0003,
    priceSpread: 0.0005,
    priceSpreadAtSize: 0.0006,
    ...overrides,
  } as VooiArbitragePair;
}

function makeVooiClient(pairs: VooiArbitragePair[]): VooiClient {
  const items = pairs.length > 0 ? [{ asset: pairs[0].asset, pairs }] : [];
  return {
    scanArbitrage: async () => ({ items, total: items.length }),
  } as unknown as VooiClient;
}

const SHARPE_ROW: SharpeRowLike = {
  coin: 'BTC',
  longExchange: 'hyperliquid',
  shortExchange: 'binance',
  netApr: 0.12, // E-12 decimal-fraction APR = 12%/yr
  longOiUsd: 5_000_000,
  shortOiUsd: 5_000_000,
};

describe('EM-STRAT-014-E11-Cluster1-R1 — perp_funding Sharpe freshness propagation', () => {
  it('server asOf present → preserved verbatim end-to-end, freshness server-asof, full cross-validated confidence', async () => {
    const strat = new PerpFundingStrategy(
      makeSharpeClient([SHARPE_ROW], { asOf: SERVER_ASOF }),
      makeVooiClient([makeVooiPair()]),
      PARAMS,
    );
    const alerts = await strat.scan();
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    const a = alerts.find(x => x.source === 'sharpe+vooi');
    expect(a).toBeDefined();
    expect(a!.sharpeAsOf).toBe(SERVER_ASOF);           // verbatim, not scan time
    expect(a!.sharpeAsOf).not.toBe(FIXED_NOW);
    expect(a!.freshness).toBe('server-asof');
    expect(a!.confidence).toBe(0.9);                    // verified asOf → full confidence allowed
  });

  it('server asOf null → freshness unknown, sharpeAsOf null (never fabricated from scan time), confidence capped at 0.7 despite VOOI agreement', async () => {
    const strat = new PerpFundingStrategy(
      makeSharpeClient([SHARPE_ROW], { asOf: null }),
      makeVooiClient([makeVooiPair()]),
      PARAMS,
    );
    const alerts = await strat.scan();
    const a: PerpFundingAlert | undefined = alerts.find(x => x.source === 'sharpe+vooi');
    expect(a).toBeDefined();
    expect(a!.sharpeAsOf).toBeNull();
    expect(a!.freshness).toBe('unknown');
    // VOOI agreement must NOT upgrade unverified data to 0.9.
    expect(a!.confidence).toBe(0.7);
    expect(a!.confidence).toBeLessThan(0.9);
  });

  it('meta absent entirely → freshness unknown (defensive; no invention)', async () => {
    const strat = new PerpFundingStrategy(
      makeSharpeClient([SHARPE_ROW], undefined),
      makeVooiClient([makeVooiPair()]),
      PARAMS,
    );
    const alerts = await strat.scan();
    const a = alerts.find(x => x.source === 'sharpe+vooi');
    expect(a).toBeDefined();
    expect(a!.sharpeAsOf).toBeNull();
    expect(a!.freshness).toBe('unknown');
  });

  it('malformed asOf through a misbehaving client → treated as absent (defensive), freshness unknown', async () => {
    // The SharpeClient normalizes malformed values to null (covered in
    // sharpe-client asof-integrity tests). This proves the CONSUMER also
    // fails safe if a malformed value (NaN / string) ever reaches it.
    for (const malformed of [Number.NaN, 'not-a-number', {}, 0]) {
      const strat = new PerpFundingStrategy(
        makeSharpeClient([SHARPE_ROW], { asOf: malformed as any }),
        makeVooiClient([makeVooiPair()]),
        PARAMS,
      );
      const alerts = await strat.scan();
      const a = alerts.find(x => x.source === 'sharpe+vooi');
      expect(a, `malformed case: ${String(malformed)}`).toBeDefined();
      expect(a!.freshness, `malformed case: ${String(malformed)}`).toBe('unknown');
      // 0 is a finite number but not a plausible observation timestamp;
      // the consumer treats non-positive as absent too? — 0 IS finite, so
      // a strict finite check alone would carry it. We additionally require
      // positive values below.
      if (malformed === 0) {
        expect(a!.sharpeAsOf).toBeNull();
        expect(a!.freshness).toBe('unknown');
      }
    }
  });

  it('VOOI-only alert (no Sharpe row) → freshness unknown, sharpeAsOf null — a VOOI row never upgrades Sharpe freshness', async () => {
    const strat = new PerpFundingStrategy(
      makeSharpeClient([], { asOf: SERVER_ASOF }), // server asOf present but NO rows
      makeVooiClient([makeVooiPair()]),
      PARAMS,
    );
    const alerts = await strat.scan();
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    const vooiOnly = alerts.find(x => x.source === 'vooi');
    expect(vooiOnly).toBeDefined();
    expect(vooiOnly!.sharpeAsOf).toBeNull();
    expect(vooiOnly!.freshness).toBe('unknown');
  });

  it('no freshness fabrication: with asOf absent, sharpeAsOf stays null while the scan clock advances', async () => {
    const before = Date.now();
    const strat = new PerpFundingStrategy(
      makeSharpeClient([SHARPE_ROW], { asOf: null }),
      makeVooiClient([]),
      PARAMS,
    );
    const alerts = await strat.scan();
    const after = Date.now();
    for (const a of alerts) {
      expect(a.freshness).toBe('unknown');
      if (a.sharpeAsOf !== null) {
        // Any non-null value must be a server timestamp we injected —
        // it must NEVER fall inside the local scan window.
        expect(a.sharpeAsOf >= before && a.sharpeAsOf <= after).toBe(false);
      }
    }
  });

  it('no freshness SLA is invented: present asOf is carried as data, never judged fresh/stale', async () => {
    // A very old server timestamp must still be labeled 'server-asof' —
    // without a configured SLA the consumer has no basis to call it stale,
    // and it must never silently relabel it fresh either.
    const ancient = 1_000_000_000; // ~1970-01-12
    const strat = new PerpFundingStrategy(
      makeSharpeClient([SHARPE_ROW], { asOf: ancient }),
      makeVooiClient([makeVooiPair()]),
      PARAMS,
    );
    const alerts = await strat.scan();
    const a = alerts.find(x => x.source === 'sharpe+vooi');
    expect(a).toBeDefined();
    expect(a!.sharpeAsOf).toBe(ancient);
    expect(a!.freshness).toBe('server-asof');
  });
});

// ─── EM-STRAT-014-E11-Cluster2-R1 — canonical perp_funding join ─────────

describe('EM-STRAT-014-E11-Cluster2-R1 — perp_funding join normalized on BOTH sides', () => {
  it('case difference: Sharpe "Hyperliquid" vs VOOI "hyperliquid" → cross-validation matches', async () => {
    const row = { ...SHARPE_ROW, longExchange: 'Hyperliquid', shortExchange: 'Binance' };
    const pair = makeVooiPair(); // long.exchange 'hyperliquid', short 'binance'
    const strat = new PerpFundingStrategy(
      makeSharpeClient([row], { asOf: SERVER_ASOF }),
      makeVooiClient([pair]),
      PARAMS,
    );
    const alerts = await strat.scan();
    const a = alerts.find(x => x.source === 'sharpe+vooi');
    expect(a).toBeDefined(); // join must succeed despite case difference
    expect(a!.priceSpreadPct).toBeCloseTo(0.06, 6); // VOOI priceSpreadAtSize × 100
  });

  it('approved venue alias: Sharpe "hyperliquid" vs VOOI "HL" → matches; unmapped venue spelling never matches', async () => {
    const pair = makeVooiPair({ long: { ...makeVooiPair().long, exchange: 'HL' } } as Partial<VooiArbitragePair>);
    const strat = new PerpFundingStrategy(
      makeSharpeClient([SHARPE_ROW], { asOf: SERVER_ASOF }),
      makeVooiClient([pair]),
      PARAMS,
    );
    const alerts = await strat.scan();
    expect(alerts.find(x => x.source === 'sharpe+vooi')).toBeDefined();

    // Unmapped venue spelling ('mynewvenue') must NOT join (no guesswork).
    const unmapPair = makeVooiPair({ long: { ...makeVooiPair().long, exchange: 'mynewvenue' } } as Partial<VooiArbitragePair>);
    const strat2 = new PerpFundingStrategy(
      makeSharpeClient([SHARPE_ROW], { asOf: SERVER_ASOF }),
      makeVooiClient([unmapPair]),
      PARAMS,
    );
    const alerts2 = await strat2.scan();
    expect(alerts2.find(x => x.source === 'sharpe+vooi')).toBeUndefined();
  });

  it('approved asset alias: Sharpe "1000PEPE" vs VOOI "PEPE" → cross-validation matches; unlisted alias never matches', async () => {
    const pepeRow: SharpeRowLike = { coin: '1000PEPE', longExchange: 'hyperliquid', shortExchange: 'binance', netApr: 0.12, longOiUsd: 5_000_000, shortOiUsd: 5_000_000 };
    const pepePair = makeVooiPair({ asset: 'PEPE' } as Partial<VooiArbitragePair>);
    const strat = new PerpFundingStrategy(
      makeSharpeClient([pepeRow], { asOf: SERVER_ASOF }),
      makeVooiClient([pepePair]),
      PARAMS,
    );
    const alerts = await strat.scan();
    // The JOIN is canonical (PEPE↔1000PEPE match); the emitted asset label
    // preserves the provider's own symbol ('1000PEPE'). What matters here is
    // that cross-validation succeeded (source 'sharpe+vooi').
    expect(alerts.find(x => x.source === 'sharpe+vooi' && x.asset === '1000PEPE')).toBeDefined();

    // Unlisted alias ('WIFCOIN' vs 'WIF') must NOT join.
    const wifRow: SharpeRowLike = { coin: 'WIFCOIN', longExchange: 'hyperliquid', shortExchange: 'binance', netApr: 0.12, longOiUsd: 5_000_000, shortOiUsd: 5_000_000 };
    const wifPair = makeVooiPair({ asset: 'WIF' } as Partial<VooiArbitragePair>);
    const strat2 = new PerpFundingStrategy(
      makeSharpeClient([wifRow], { asOf: SERVER_ASOF }),
      makeVooiClient([wifPair]),
      PARAMS,
    );
    const alerts2 = await strat2.scan();
    expect(alerts2.find(x => x.source === 'sharpe+vooi')).toBeUndefined();
  });
});

// ─── E-12 (Issue #17) — APR unit + gross/net integrity ─────────────────

describe('E-12 — perp_funding canonical APR unit and gross/net separation', () => {
  // VOOI hourly spread that annualizes to exactly 8%/yr: 0.08 / (24×365)
  const SPREAD_FOR_8PCT_APR = 0.08 / (24 * 365); // ≈ 9.1324e-6

  it('netApr present → carried as VERIFIED net (basis sharpe-net), never conflated with gross', async () => {
    const strat = new PerpFundingStrategy(
      makeSharpeClient([SHARPE_ROW], { asOf: SERVER_ASOF }),
      makeVooiClient([]),
      PARAMS,
    );
    const alerts = await strat.scan();
    const a = alerts.find(x => x.source === 'sharpe');
    expect(a).toBeDefined();
    expect(a!.netApr).toBe(0.12);
    expect(a!.netAprBasis).toBe('sharpe-net');
    expect(a!.spreadApr).toBe(0.12);
    expect(a!.annualizationBasis).toBe('sharpe-row');
  });

  it('absent netApr but grossApr present → netApr stays NULL (gross is NOT labeled net), row still alerted as indicative', async () => {
    const row = { ...SHARPE_ROW, netApr: undefined, grossApr: 0.10 };
    const strat = new PerpFundingStrategy(
      makeSharpeClient([row], { asOf: null }),
      makeVooiClient([]),
      PARAMS,
    );
    const alerts = await strat.scan();
    const a = alerts.find(x => x.asset === 'BTC');
    expect(a).toBeDefined();
    expect(a!.netApr).toBeNull();
    expect(a!.netAprBasis).toBe('unavailable');
    expect(a!.spreadApr).toBe(0.10); // gross drives only the indicative pre-filter
  });

  it('malformed rates fail closed: NaN net/gross → spread 0 → row below threshold → skipped (no NaN propagation)', async () => {
    for (const bad of [{ netApr: Number.NaN }, { netApr: 'x' as unknown as number }, { netApr: null as unknown as number }, { netApr: Number.POSITIVE_INFINITY }]) {
      const row = { ...SHARPE_ROW, ...bad, grossApr: undefined };
      const strat = new PerpFundingStrategy(
        makeSharpeClient([row], { asOf: null }),
        makeVooiClient([]),
        PARAMS,
      );
      const alerts = await strat.scan();
      expect(alerts.find(x => x.asset === 'BTC'), `case ${JSON.stringify(bad)}`).toBeUndefined();
    }
  });

  it('malformed netApr with valid grossApr → falls back to GROSS-INDICATIVE labeling (never net)', async () => {
    const row = { ...SHARPE_ROW, netApr: Number.NaN, grossApr: 0.30 };
    const strat = new PerpFundingStrategy(
      makeSharpeClient([row], { asOf: null }),
      makeVooiClient([]),
      PARAMS,
    );
    const alerts = await strat.scan();
    const a = alerts.find(x => x.asset === 'BTC');
    expect(a).toBeDefined();
    expect(a!.netApr).toBeNull();
    expect(a!.netAprBasis).toBe('unavailable');
    expect(a!.spreadApr).toBe(0.30);
  });

  it('threshold boundary at 8% APR (decimal 0.08): 0.08 included, 0.0799 excluded', async () => {
    const atBoundary = new PerpFundingStrategy(
      makeSharpeClient([{ ...SHARPE_ROW, netApr: 0.08 }], { asOf: null }),
      makeVooiClient([]),
      PARAMS,
    );
    expect((await atBoundary.scan()).find(x => x.asset === 'BTC')).toBeDefined();

    const belowBoundary = new PerpFundingStrategy(
      makeSharpeClient([{ ...SHARPE_ROW, netApr: 0.0799 }], { asOf: null }),
      makeVooiClient([]),
      PARAMS,
    );
    expect((await belowBoundary.scan()).find(x => x.asset === 'BTC')).toBeUndefined();
  });

  it('VOOI-only rows use the SAME decimal unit: fundingSpread1h annualizes to spreadApr/8760 scale (no ×100)', async () => {
    // 0.0003/h → 0.0003 × 24 × 365 = 2.628 decimal-fraction APR (262.8%/yr)
    const strat = new PerpFundingStrategy(
      makeSharpeClient([], { asOf: null }),
      makeVooiClient([makeVooiPair()]),
      PARAMS,
    );
    const alerts = await strat.scan();
    const vooiOnly = alerts.find(x => x.source === 'vooi');
    expect(vooiOnly).toBeDefined();
    expect(vooiOnly!.spreadApr).toBeCloseTo(0.0003 * 24 * 365, 10);
    expect(vooiOnly!.spreadApr).toBeLessThan(3); // would be ~262.8 under the old ×100 bug
    // Leg APRs share the same decimal unit
    expect(vooiOnly!.longFundingApr).toBeCloseTo(Number('-0.00010') * 24 * 365, 10);
    expect(vooiOnly!.shortFundingApr).toBeCloseTo(Number('0.00020') * 24 * 365, 10);
  });

  it('VOOI threshold boundary: spread annualizing to exactly 0.08 included; just below excluded', async () => {
    const at = new PerpFundingStrategy(
      makeSharpeClient([], { asOf: null }),
      makeVooiClient([makeVooiPair({ fundingSpread1h: SPREAD_FOR_8PCT_APR } as Partial<VooiArbitragePair>)]),
      PARAMS,
    );
    expect((await at.scan()).find(x => x.source === 'vooi')).toBeDefined();

    const below = new PerpFundingStrategy(
      makeSharpeClient([], { asOf: null }),
      makeVooiClient([makeVooiPair({ fundingSpread1h: SPREAD_FOR_8PCT_APR * 0.999 } as Partial<VooiArbitragePair>)]),
      PARAMS,
    );
    expect((await below.scan()).find(x => x.source === 'vooi')).toBeUndefined();
  });

  it('equivalent VOOI and Sharpe rates are represented in the SAME units (scale parity)', async () => {
    // Sharpe row with verified net 2.628 (decimal); VOOI spread 0.0003/h →
    // identical annualized decimal value — they must be directly comparable.
    const targetApr = 0.0003 * 24 * 365;
    const strat = new PerpFundingStrategy(
      makeSharpeClient([
        { coin: 'ETH', longExchange: 'hyperliquid', shortExchange: 'binance', netApr: targetApr, longOiUsd: 5_000_000, shortOiUsd: 5_000_000 },
      ], { asOf: null }),
      makeVooiClient([makeVooiPair()]), // BTC VOOI-only row (ETH in Sharpe set)
      PARAMS,
    );
    const alerts = await strat.scan();
    const sharpeRow = alerts.find(x => x.asset === 'ETH');
    const vooiRow = alerts.find(x => x.source === 'vooi');
    expect(sharpeRow).toBeDefined();
    expect(vooiRow).toBeDefined();
    expect(sharpeRow!.spreadApr).toBeCloseTo(vooiRow!.spreadApr, 10);
  });

  it('VOOI-only rows are GROSS-INDICATIVE: netApr null, basis unavailable, annualization 1h-assumed', async () => {
    const strat = new PerpFundingStrategy(
      makeSharpeClient([], { asOf: null }),
      makeVooiClient([makeVooiPair()]),
      PARAMS,
    );
    const alerts = await strat.scan();
    const vooiOnly = alerts.find(x => x.source === 'vooi');
    expect(vooiOnly).toBeDefined();
    expect(vooiOnly!.netApr).toBeNull();
    expect(vooiOnly!.netAprBasis).toBe('unavailable');
    expect(vooiOnly!.annualizationBasis).toBe('1h-assumed');
  });

  it('sorting: a net-VERIFIED row sorts before a gross-only row even when the gross spread is larger', async () => {
    const strat = new PerpFundingStrategy(
      makeSharpeClient([
        { coin: 'AAA', longExchange: 'hyperliquid', shortExchange: 'binance', netApr: 0.10, longOiUsd: 5_000_000, shortOiUsd: 5_000_000 },
      ], { asOf: null }),
      makeVooiClient([makeVooiPair()]), // gross-only VOOI row: spreadApr ≈ 2.628 ≫ 0.10
      PARAMS,
    );
    const alerts = await strat.scan();
    expect(alerts.length).toBeGreaterThanOrEqual(2);
    // Net-verified AAA (0.10 net) must rank BEFORE the gross-only VOOI row
    // (2.628 indicative) — net economics drive the ordering, gross never does.
    expect(alerts[0].asset).toBe('AAA');
    expect(alerts[0].netAprBasis).toBe('sharpe-net');
    expect(alerts[1].netAprBasis).toBe('unavailable');
  });

  it('output never advertises gross as net: basis and netApr are consistent on every alert', async () => {
    const strat = new PerpFundingStrategy(
      makeSharpeClient([
        SHARPE_ROW,
        { ...SHARPE_ROW, coin: 'GG', netApr: undefined, grossApr: 0.44 },
      ], { asOf: SERVER_ASOF }),
      makeVooiClient([makeVooiPair()]),
      PARAMS,
    );
    const alerts = await strat.scan();
    expect(alerts.length).toBeGreaterThanOrEqual(2);
    for (const a of alerts) {
      if (a.netAprBasis === 'sharpe-net') {
        expect(typeof a.netApr).toBe('number');
      } else {
        expect(a.netApr).toBeNull();
      }
      if (a.source === 'vooi') {
        expect(a.netApr).toBeNull(); // VOOI has no fee model — never net
      }
    }
  });

  it('malformed VOOI funding fields are skipped fail-closed (no NaN in output)', async () => {
    const badPair = makeVooiPair({ fundingSpread1h: Number.NaN } as Partial<VooiArbitragePair>);
    const strat = new PerpFundingStrategy(
      makeSharpeClient([], { asOf: null }),
      makeVooiClient([badPair]),
      PARAMS,
    );
    const alerts = await strat.scan();
    expect(alerts).toEqual([]);
  });
});
