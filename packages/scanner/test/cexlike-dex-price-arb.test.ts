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

describe('CexLikeDexPriceArbStrategy — EM-STRAT-004 signal-integrity regressions', () => {

  describe('actionable flag (EM-STRAT-004 §4)', () => {
    it('sets actionable=false when fundingSpread1h is null (economics incomplete)', async () => {
      const pair = makePair({ fundingSpread1h: null });
      const vooi = new VooiClient({
        apiToken: 'test',
        fetchImpl: makeVooiFetch({ items: [{ asset: 'ETH', pairs: [pair] }], total: 1 }),
      });
      const strat = new CexLikeDexPriceArbStrategy(vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts.length).toBe(1);
      const a = alerts[0] as PriceArbAlert;
      expect(a.economicsComplete).toBe(false);
      expect(a.estimatedProfitUsd).toBeNull();
      // EM-STRAT-004 §4: actionable must be false when economics are incomplete.
      expect(a.actionable).toBe(false);
      // Trade type is convergence (not instant profit).
      expect(a.tradeType).toBe('convergence');
    });

    it('sets actionable=true when funding is present AND estimated profit is positive', async () => {
      const pair = makePair({
        longPrice: 100,
        shortPrice: 105,
        priceSpread: 0.05,        // 5% headline
        priceSpreadAtSize: 0.045, // 4.5% at-size
        fundingSpread1h: 0.0001,  // 0.01% per hour
      });
      const vooi = new VooiClient({
        apiToken: 'test',
        fetchImpl: makeVooiFetch({ items: [{ asset: 'ETH', pairs: [pair] }], total: 1 }),
      });
      const strat = new CexLikeDexPriceArbStrategy(vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts.length).toBe(1);
      const a = alerts[0] as PriceArbAlert;
      expect(a.economicsComplete).toBe(true);
      expect(a.estimatedProfitUsd).not.toBeNull();
      expect(a.estimatedProfitUsd!).toBeGreaterThan(0);
      expect(a.actionable).toBe(true);
    });

    it('sets actionable=false when economics are complete but profit is non-positive', async () => {
      // Spread below fee threshold (4 bps round-trip = 0.04%).
      // Effective spread = 0.03% < 0.04% fee → grossProfit < 0.
      // Use a low minPriceSpreadPct so the alert is not pre-filtered.
      const pair = makePair({
        longPrice: 100,
        shortPrice: 100.03,
        priceSpread: 0.0003, // 0.03%
        fundingSpread1h: 0.0001,
      });
      const vooi = new VooiClient({
        apiToken: 'test',
        fetchImpl: makeVooiFetch({ items: [{ asset: 'ETH', pairs: [pair] }], total: 1 }),
      });
      const strat = new CexLikeDexPriceArbStrategy(vooi, {
        ...DEFAULT_PARAMS,
        minPriceSpreadPct: 0.01, // 0.01% — let the 0.03% spread through
      });
      const alerts = await strat.scan();
      expect(alerts.length).toBe(1);
      const a = alerts[0] as PriceArbAlert;
      expect(a.economicsComplete).toBe(true);
      expect(a.estimatedProfitUsd).not.toBeNull();
      expect(a.estimatedProfitUsd!).toBeLessThanOrEqual(0);
      expect(a.actionable).toBe(false);
    });
  });

  describe('convergence-trade labeling (EM-STRAT-004 §4)', () => {
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
      // Effective spread = at-size when available.
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

  describe('null preservation in alert fields (EM-STRAT-004 §3)', () => {
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

    it('estimatedProfitUsd is null when funding is unavailable', async () => {
      const pair = makePair({ fundingSpread1h: null });
      const vooi = new VooiClient({
        apiToken: 'test',
        fetchImpl: makeVooiFetch({ items: [{ asset: 'ETH', pairs: [pair] }], total: 1 }),
      });
      const strat = new CexLikeDexPriceArbStrategy(vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts[0].estimatedProfitUsd).toBeNull();
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
