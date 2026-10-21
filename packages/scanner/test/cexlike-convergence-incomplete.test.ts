import { describe, it, expect } from 'vitest';
import { CexLikeDexPriceArbStrategy, type PriceArbAlert } from '../src/strategies/cexlike-dex-price-arb.js';
import { VooiClient } from '@edge/vooi-client';

// ─── EM-STRAT-005 §1 regression tests ──────────────────────────────────
//
// These tests verify that the CEX-like convergence-trade scanner NEVER
// produces a verified profit estimate or actionable signal under any
// input combination, until a complete convergence-economics model is
// implemented.
//
// OLD BEHAVIOR (PR #5 head 4aba073, EM-STRAT-004):
//   - estimatedProfitUsd was computed as (|effectiveSpreadPct| - 0.04) × maxSizeUsd
//     when fundingSpread1h !== null.
//   - actionable was true when economicsComplete && estimatedProfitUsd > 0.
//   - The 4 bps fee was an unverified assumption; funding was NOT incorporated
//     into the profit estimate.
//
// NEW BEHAVIOR (EM-STRAT-005 §1):
//   - estimatedProfitUsd is ALWAYS null.
//   - actionable is ALWAYS false.
//   - monitoringOnly is ALWAYS true.
//   - economicsComplete is ALWAYS false.
//
// Each test below would have FAILED on the old behavior (produced a
// non-null profit or actionable=true) and PASSES on the new behavior.

function makeVooiFetch(resp: any) {
  return async (_url: string | URL | Request, _init?: any) => ({
    ok: true,
    status: 200,
    json: async () => resp,
    text: async () => JSON.stringify(resp),
  }) as any;
}

const DEFAULT_PARAMS = {
  minPriceSpreadPct: 0.5,
  maxSizeUsd: 5_000,
  minOpenInterest: 10_000,
  minVolume24h: 100_000,
  venues: [],
  minSpreadPersistence: 1,
};

function makePair(opts: {
  longPrice?: number;
  shortPrice?: number;
  priceSpread?: number;
  priceSpreadAtSize?: number | null;
  fundingSpread1h?: number | null;
} = {}) {
  const fundingSpread1h = opts.fundingSpread1h !== undefined ? opts.fundingSpread1h : 0.0001;
  return {
    asset: 'ETH',
    long: {
      exchange: 'hyperliquid',
      fundingRate: '0.001',
      price: String(opts.longPrice ?? 100),
      volume24h: 500_000,
      openInterest: '1000',
    },
    short: {
      exchange: 'lighter',
      fundingRate: '0.001',
      price: String(opts.shortPrice ?? 102),
      volume24h: 500_000,
      openInterest: '1000',
    },
    fundingSpread1h: fundingSpread1h as number,
    priceSpread: opts.priceSpread ?? 0.02,
    priceSpreadAtSize: opts.priceSpreadAtSize ?? null,
    maxFundingSpread1h: (fundingSpread1h as number) ?? 0.0001,
    maxFundingSpread24h: (fundingSpread1h as number) ?? 0.0001,
  };
}

function makeScanner(pair: any) {
  const vooi = new VooiClient({
    apiToken: 'test',
    fetchImpl: makeVooiFetch({ items: [{ asset: 'ETH', pairs: [pair] }], total: 1 }),
  });
  return new CexLikeDexPriceArbStrategy(vooi, DEFAULT_PARAMS);
}

describe('EM-STRAT-005 §1 — CEX-like convergence economics regressions', () => {

  describe('adverse funding must not produce verified profit', () => {
    it('funding = -0.1%/h (adverse): estimatedProfitUsd is null, actionable is false', async () => {
      // OLD BEHAVIOR: would have computed (|2%| - 0.04%) × 5000 = $98 profit,
      // ignoring the adverse funding. actionable would have been true.
      // NEW BEHAVIOR: estimatedProfitUsd is null; actionable is false.
      const pair = makePair({
        longPrice: 100,
        shortPrice: 102,
        priceSpread: 0.02,
        fundingSpread1h: -0.001, // adverse: -0.1% per hour
      });
      const strat = makeScanner(pair);
      const alerts = await strat.scan();
      expect(alerts.length).toBe(1);
      const a = alerts[0] as PriceArbAlert;
      expect(a.estimatedProfitUsd).toBeNull();
      expect(a.actionable).toBe(false);
      expect(a.monitoringOnly).toBe(true);
      expect(a.fundingSpread1h).toBe(-0.001);
    });

    it('funding = -1%/h (severely adverse): estimatedProfitUsd is null, actionable is false', async () => {
      const pair = makePair({
        longPrice: 100,
        shortPrice: 105,
        priceSpread: 0.05,
        fundingSpread1h: -0.01, // severely adverse: -1% per hour
      });
      const strat = makeScanner(pair);
      const alerts = await strat.scan();
      expect(alerts[0].estimatedProfitUsd).toBeNull();
      expect(alerts[0].actionable).toBe(false);
    });
  });

  describe('missing fee schedule must not produce verified profit', () => {
    it('no per-venue fee fields in VOOI response: estimatedProfitUsd is null', async () => {
      // OLD BEHAVIOR: would have used the unverified 4 bps assumption and
      // computed a profit when |spread| > 0.04%.
      // NEW BEHAVIOR: refuses to estimate without a verified fee schedule.
      const pair = makePair({
        longPrice: 100,
        shortPrice: 102,
        priceSpread: 0.02,
        fundingSpread1h: 0.0001,
        // No fee fields in VOOI response — never were.
      });
      const strat = makeScanner(pair);
      const alerts = await strat.scan();
      expect(alerts[0].estimatedProfitUsd).toBeNull();
      expect(alerts[0].actionable).toBe(false);
    });
  });

  describe('missing exit / close-out assumption must not produce verified profit', () => {
    it('no exit assumption field: estimatedProfitUsd is null', async () => {
      // OLD BEHAVIOR: would have computed profit assuming entry spread = exit spread.
      // NEW BEHAVIOR: refuses to estimate without an explicit close-out model.
      const pair = makePair({
        longPrice: 100,
        shortPrice: 102,
        priceSpread: 0.02,
        priceSpreadAtSize: 0.018, // at-size available
        fundingSpread1h: 0.0001,
      });
      const strat = makeScanner(pair);
      const alerts = await strat.scan();
      expect(alerts[0].estimatedProfitUsd).toBeNull();
      expect(alerts[0].actionable).toBe(false);
    });
  });

  describe('missing holding-period assumption must not produce verified profit', () => {
    it('no holding-period field: estimatedProfitUsd is null', async () => {
      // OLD BEHAVIOR: would have ignored funding accrual entirely (used only
      // |spread| - 4 bps).
      // NEW BEHAVIOR: refuses to estimate without an explicit holding period.
      const pair = makePair({
        longPrice: 100,
        shortPrice: 102,
        priceSpread: 0.02,
        fundingSpread1h: 0.0001,
      });
      const strat = makeScanner(pair);
      const alerts = await strat.scan();
      expect(alerts[0].estimatedProfitUsd).toBeNull();
      expect(alerts[0].actionable).toBe(false);
    });
  });

  describe('all-inputs-present but no convergence model: still null', () => {
    it('funding + at-size spread + headline spread all present: estimatedProfitUsd is STILL null', async () => {
      // This is the key regression: even when ALL VOOI-provided inputs are
      // present, the scanner must NOT produce a profit estimate because the
      // convergence-economics MODEL (entry/exit/fees/funding/holding-period/
      // margin costs) is not yet implemented. The old behavior would have
      // computed (|spread| - 0.04%) × maxSizeUsd here.
      const pair = makePair({
        longPrice: 100,
        shortPrice: 105,
        priceSpread: 0.05,
        priceSpreadAtSize: 0.045,
        fundingSpread1h: 0.0001,
      });
      const strat = makeScanner(pair);
      const alerts = await strat.scan();
      const a = alerts[0] as PriceArbAlert;
      expect(a.estimatedProfitUsd).toBeNull();
      expect(a.actionable).toBe(false);
      expect(a.economicsComplete).toBe(false);
      expect(a.monitoringOnly).toBe(true);
    });
  });

  describe('monitoringOnly flag is always true (EM-STRAT-005 §1)', () => {
    it('monitoringOnly is true regardless of input', async () => {
      const scenarios = [
        makePair({ fundingSpread1h: null }),
        makePair({ fundingSpread1h: 0.0001 }),
        makePair({ fundingSpread1h: -0.001 }),
        makePair({ priceSpread: 0.05, fundingSpread1h: 0.0001 }),
      ];
      for (const pair of scenarios) {
        const strat = makeScanner(pair);
        const alerts = await strat.scan();
        for (const a of alerts) {
          expect(a.monitoringOnly).toBe(true);
          expect(a.actionable).toBe(false);
          expect(a.estimatedProfitUsd).toBeNull();
        }
      }
    });
  });

  describe('alert shape preserves diagnostic fields (EM-STRAT-005 §1)', () => {
    it('fundingSpread1h is preserved when present (for diagnostic visibility)', async () => {
      const pair = makePair({
        longPrice: 100,
        shortPrice: 102,
        priceSpread: 0.02,
        fundingSpread1h: 0.000123,
      });
      const strat = makeScanner(pair);
      const alerts = await strat.scan();
      expect(alerts[0].fundingSpread1h).toBeCloseTo(0.000123, 8);
    });

    it('headlineSpreadPct and atSizeSpreadPct are preserved', async () => {
      const pair = makePair({
        longPrice: 100,
        shortPrice: 103,
        priceSpread: 0.03,
        priceSpreadAtSize: 0.025,
      });
      const strat = makeScanner(pair);
      const alerts = await strat.scan();
      expect(alerts[0].headlineSpreadPct).toBeCloseTo(3, 5);
      expect(alerts[0].atSizeSpreadPct).toBeCloseTo(2.5, 5);
      expect(alerts[0].effectiveSpreadPct).toBeCloseTo(2.5, 5);
    });
  });
});
