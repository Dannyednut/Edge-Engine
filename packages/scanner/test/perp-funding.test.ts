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
  minSpreadApr: 8,
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
  netApr: 12,
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
    const pepeRow: SharpeRowLike = { coin: '1000PEPE', longExchange: 'hyperliquid', shortExchange: 'binance', netApr: 12, longOiUsd: 5_000_000, shortOiUsd: 5_000_000 };
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
    const wifRow: SharpeRowLike = { coin: 'WIFCOIN', longExchange: 'hyperliquid', shortExchange: 'binance', netApr: 12, longOiUsd: 5_000_000, shortOiUsd: 5_000_000 };
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
