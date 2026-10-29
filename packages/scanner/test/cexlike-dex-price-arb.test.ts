import { describe, it, expect } from 'vitest';
import { CexLikeDexPriceArbStrategy, type PriceArbAlert } from '../src/strategies/cexlike-dex-price-arb.js';
import { VooiClient } from '@edge/vooi-client';

// ─── Test fixtures ─────────────────────────────────────────────────────
//
// CexLikeDexPriceArbStrategy consumes VooiClient.scanArbitrage(). We mock
// the underlying fetchImpl to return canned VOOI responses.

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
  asset?: string;
  longExchange?: string;
  shortExchange?: string;
  longPrice?: number;
  shortPrice?: number;
  priceSpread?: number;        // decimal (e.g., 0.02 = 2%)
  priceSpreadAtSize?: number | null;
  fundingSpread1h?: number | null;  // decimal
  longVolume24h?: number;
  shortVolume24h?: number;
  longOpenInterest?: number;
  shortOpenInterest?: number;
}) {
  // Use explicit undefined check so `null` is preserved (don't default null to 0.0001).
  const fundingSpread1h = opts.fundingSpread1h !== undefined ? opts.fundingSpread1h : 0.0001;
  return {
    asset: opts.asset ?? 'ETH',
    long: {
      exchange: opts.longExchange ?? 'hyperliquid',
      fundingRate: '0.001',
      price: String(opts.longPrice ?? 100),
      volume24h: opts.longVolume24h ?? 500_000,
      openInterest: String(opts.longOpenInterest ?? 1000),
    },
    short: {
      exchange: opts.shortExchange ?? 'lighter',
      fundingRate: '0.001',
      price: String(opts.shortPrice ?? 102),
      volume24h: opts.shortVolume24h ?? 500_000,
      openInterest: String(opts.shortOpenInterest ?? 1000),
    },
    fundingSpread1h: fundingSpread1h as number,
    priceSpread: opts.priceSpread ?? 0.02,
    priceSpreadAtSize: opts.priceSpreadAtSize ?? null,
    maxFundingSpread1h: (fundingSpread1h as number) ?? 0.0001,
    maxFundingSpread24h: (fundingSpread1h as number) ?? 0.0001,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('CexLikeDexPriceArbStrategy — EM-STRAT-005 §1 monitoring-only convergence model', () => {

  describe('estimatedProfitUsd is ALWAYS null (EM-STRAT-005 §1)', () => {
    it('estimatedProfitUsd is null even when funding is present', async () => {
      // EM-STRAT-005 §1: the previous code computed estimatedProfitUsd when
      // fundingSpread1h was non-null, but did not actually incorporate
      // funding into the profit estimate — it used an unverified 4 bps fee.
      // The new implementation keeps estimatedProfitUsd ALWAYS null until
      // a complete convergence model is implemented.
      const pair = makePair({
        longPrice: 100,
        shortPrice: 105,
        priceSpread: 0.05,
        fundingSpread1h: 0.0001, // funding present
      });
      const vooi = new VooiClient({
        apiToken: 'test',
        fetchImpl: makeVooiFetch({ items: [{ asset: 'ETH', pairs: [pair] }], total: 1 }),
      });
      const strat = new CexLikeDexPriceArbStrategy(vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts.length).toBe(1);
      expect(alerts[0].estimatedProfitUsd).toBeNull();
    });

    it('estimatedProfitUsd is null when funding is null', async () => {
      const pair = makePair({ fundingSpread1h: null });
      const vooi = new VooiClient({
        apiToken: 'test',
        fetchImpl: makeVooiFetch({ items: [{ asset: 'ETH', pairs: [pair] }], total: 1 }),
      });
      const strat = new CexLikeDexPriceArbStrategy(vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts.length).toBe(1);
      expect(alerts[0].estimatedProfitUsd).toBeNull();
    });

    it('estimatedProfitUsd is null when funding is adverse (negative)', async () => {
      // EM-STRAT-005 §1: adverse funding must not produce a verified profit
      // estimate. The previous code would have computed a positive profit
      // when |spread| > 4 bps, ignoring the adverse funding entirely.
      const pair = makePair({
        longPrice: 100,
        shortPrice: 102,
        priceSpread: 0.02,
        fundingSpread1h: -0.001, // adverse: -0.1% per hour
      });
      const vooi = new VooiClient({
        apiToken: 'test',
        fetchImpl: makeVooiFetch({ items: [{ asset: 'ETH', pairs: [pair] }], total: 1 }),
      });
      const strat = new CexLikeDexPriceArbStrategy(vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts.length).toBe(1);
      expect(alerts[0].estimatedProfitUsd).toBeNull();
      expect(alerts[0].fundingSpread1h).toBe(-0.001);
    });

    it('estimatedProfitUsd is null when fee inputs are missing', async () => {
      // EM-STRAT-005 §1: venue-specific fees are not in the VOOI response.
      // The previous code used an unverified 4 bps assumption; the new
      // implementation refuses to estimate profit until a verified
      // per-venue fee schedule is provided.
      const pair = makePair({
        longPrice: 100,
        shortPrice: 102,
        priceSpread: 0.02,
        fundingSpread1h: 0.0001,
        // No fee fields available in VOOI response.
      });
      const vooi = new VooiClient({
        apiToken: 'test',
        fetchImpl: makeVooiFetch({ items: [{ asset: 'ETH', pairs: [pair] }], total: 1 }),
      });
      const strat = new CexLikeDexPriceArbStrategy(vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts[0].estimatedProfitUsd).toBeNull();
    });

    it('estimatedProfitUsd is null when exit/close-out assumption is unavailable', async () => {
      // EM-STRAT-005 §1: a verified convergence-economics model requires
      // an explicit close-out assumption. The current implementation has
      // no model for this, so profit must remain null.
      const pair = makePair({
        longPrice: 100,
        shortPrice: 102,
        priceSpread: 0.02,
        priceSpreadAtSize: 0.018,
        fundingSpread1h: 0.0001,
      });
      const vooi = new VooiClient({
        apiToken: 'test',
        fetchImpl: makeVooiFetch({ items: [{ asset: 'ETH', pairs: [pair] }], total: 1 }),
      });
      const strat = new CexLikeDexPriceArbStrategy(vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts[0].estimatedProfitUsd).toBeNull();
    });

    it('estimatedProfitUsd is null when holding-period assumption is absent', async () => {
      // EM-STRAT-005 §1: a verified convergence-economics model requires
      // an explicit holding-period assumption (funding accrues per hour).
      // The current implementation has no holding-period model, so profit
      // must remain null even if all other inputs are present.
      const pair = makePair({
        longPrice: 100,
        shortPrice: 102,
        priceSpread: 0.02,
        fundingSpread1h: 0.0001,
      });
      const vooi = new VooiClient({
        apiToken: 'test',
        fetchImpl: makeVooiFetch({ items: [{ asset: 'ETH', pairs: [pair] }], total: 1 }),
      });
      const strat = new CexLikeDexPriceArbStrategy(vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts[0].estimatedProfitUsd).toBeNull();
    });
  });

  describe('actionable is ALWAYS false (EM-STRAT-005 §1)', () => {
    it('actionable is false when funding is present', async () => {
      const pair = makePair({
        longPrice: 100,
        shortPrice: 105,
        priceSpread: 0.05,
        fundingSpread1h: 0.0001,
      });
      const vooi = new VooiClient({
        apiToken: 'test',
        fetchImpl: makeVooiFetch({ items: [{ asset: 'ETH', pairs: [pair] }], total: 1 }),
      });
      const strat = new CexLikeDexPriceArbStrategy(vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts[0].actionable).toBe(false);
    });

    it('actionable is false when funding is null', async () => {
      const pair = makePair({ fundingSpread1h: null });
      const vooi = new VooiClient({
        apiToken: 'test',
        fetchImpl: makeVooiFetch({ items: [{ asset: 'ETH', pairs: [pair] }], total: 1 }),
      });
      const strat = new CexLikeDexPriceArbStrategy(vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts[0].actionable).toBe(false);
    });

    it('actionable is false when funding is adverse', async () => {
      const pair = makePair({
        longPrice: 100,
        shortPrice: 102,
        priceSpread: 0.02,
        fundingSpread1h: -0.001,
      });
      const vooi = new VooiClient({
        apiToken: 'test',
        fetchImpl: makeVooiFetch({ items: [{ asset: 'ETH', pairs: [pair] }], total: 1 }),
      });
      const strat = new CexLikeDexPriceArbStrategy(vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts[0].actionable).toBe(false);
    });
  });

  describe('monitoringOnly flag (EM-STRAT-005 §1)', () => {
    it('monitoringOnly is true on every alert', async () => {
      const pair = makePair({});
      const vooi = new VooiClient({
        apiToken: 'test',
        fetchImpl: makeVooiFetch({ items: [{ asset: 'ETH', pairs: [pair] }], total: 1 }),
      });
      const strat = new CexLikeDexPriceArbStrategy(vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts.length).toBeGreaterThan(0);
      for (const a of alerts) {
        expect(a.monitoringOnly).toBe(true);
      }
    });

    it('economicsComplete is false on every alert (convergence model incomplete)', async () => {
      const pair = makePair({
        longPrice: 100,
        shortPrice: 105,
        priceSpread: 0.05,
        fundingSpread1h: 0.0001,
      });
      const vooi = new VooiClient({
        apiToken: 'test',
        fetchImpl: makeVooiFetch({ items: [{ asset: 'ETH', pairs: [pair] }], total: 1 }),
      });
      const strat = new CexLikeDexPriceArbStrategy(vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      // EM-STRAT-005 §1: economicsComplete is ALWAYS false — `fundingSpread1h !== null`
      // does NOT make economics complete (need entry/exit, fees, funding with units/sign,
      // holding period, position/margin costs).
      expect(alerts[0].economicsComplete).toBe(false);
    });
  });

  describe('convergence-trade labeling (EM-STRAT-004 §4, retained)', () => {
    it('all alerts carry tradeType=convergence (never "instant")', async () => {
      const pair = makePair({});
      const vooi = new VooiClient({
        apiToken: 'test',
        fetchImpl: makeVooiFetch({ items: [{ asset: 'ETH', pairs: [pair] }], total: 1 }),
      });
      const strat = new CexLikeDexPriceArbStrategy(vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      for (const a of alerts) {
        expect(a.tradeType).toBe('convergence');
      }
    });

    it('separates headlineSpreadPct, atSizeSpreadPct, and effectiveSpreadPct', async () => {
      const pair = makePair({
        priceSpread: 0.03,        // 3% headline
        priceSpreadAtSize: 0.02,  // 2% at-size
      });
      const vooi = new VooiClient({
        apiToken: 'test',
        fetchImpl: makeVooiFetch({ items: [{ asset: 'ETH', pairs: [pair] }], total: 1 }),
      });
      const strat = new CexLikeDexPriceArbStrategy(vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts.length).toBe(1);
      const a = alerts[0] as PriceArbAlert;
      expect(a.headlineSpreadPct).toBeCloseTo(3, 5);
      expect(a.atSizeSpreadPct).toBeCloseTo(2, 5);
      expect(a.effectiveSpreadPct).toBeCloseTo(2, 5);
    });

    it('uses headline spread when at-size is unavailable', async () => {
      const pair = makePair({
        priceSpread: 0.03,
        priceSpreadAtSize: null,
      });
      const vooi = new VooiClient({
        apiToken: 'test',
        fetchImpl: makeVooiFetch({ items: [{ asset: 'ETH', pairs: [pair] }], total: 1 }),
      });
      const strat = new CexLikeDexPriceArbStrategy(vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts[0].atSizeSpreadPct).toBeNull();
      expect(alerts[0].effectiveSpreadPct).toBeCloseTo(3, 5);
    });
  });

  describe('null preservation in alert fields (EM-STRAT-004 §3, retained)', () => {
    it('fundingSpread1h is null in alert when source omits it', async () => {
      const pair = makePair({ fundingSpread1h: null });
      const vooi = new VooiClient({
        apiToken: 'test',
        fetchImpl: makeVooiFetch({ items: [{ asset: 'ETH', pairs: [pair] }], total: 1 }),
      });
      const strat = new CexLikeDexPriceArbStrategy(vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts[0].fundingSpread1h).toBeNull();
    });
  });

  describe('strategy interface compliance', () => {
    it('implements Strategy interface', () => {
      const vooi = new VooiClient({ apiToken: 'test', fetchImpl: makeVooiFetch({ items: [], total: 0 }) });
      const strat = new CexLikeDexPriceArbStrategy(vooi, DEFAULT_PARAMS);
      expect(strat.id).toBe('cexlike_dex_price_arb');
      expect(strat.landscape).toBe('B_cex_cex');
    });

    it('scan returns array (empty when no pairs)', async () => {
      const vooi = new VooiClient({ apiToken: 'test', fetchImpl: makeVooiFetch({ items: [], total: 0 }) });
      const strat = new CexLikeDexPriceArbStrategy(vooi, DEFAULT_PARAMS);
      const results = await strat.scan();
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(0);
    });
  });
});
