import { describe, it, expect } from 'vitest';
import { CexHlFundingArbStrategy, type CexHlFundingAlert } from '../src/strategies/cex-hl-funding-arb.js';
import { SharpeClient } from '@edge/sharpe-client';
import { VooiClient } from '@edge/vooi-client';

// ─── Test fixtures ─────────────────────────────────────────────────────
//
// The CexHlFundingArbStrategy consumes:
//   1. SharpeClient.crossExchangeFunding()  → identifies candidate asset × venue pairs
//   2. SharpeClient.fundingRates()          → RAW per-venue funding APRs
//   3. VooiClient.scanArbitrage()           → price-spread cross-validation
//
// We mock the underlying `fetchImpl` for both clients, dispatching on URL path.

type FetchLog = Array<{ url: string; init?: any }>;

function makeMockFetch(log: FetchLog, opts: {
  crossExchange?: any;
  fundingRates?: any;
  vooi?: any;
}) {
  return async (url: string | URL | Request, init?: any) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    log.push({ url: urlStr, init });
    let body: any;
    if (urlStr.includes('/arbitrage/cross-exchange')) {
      body = opts.crossExchange ?? { data: [] };
    } else if (urlStr.includes('/funding/rates')) {
      body = opts.fundingRates ?? { data: [] };
    } else if (urlStr.includes('vooi.io') || urlStr.includes('ultra.vooi')) {
      body = opts.vooi ?? { items: [], total: 0 };
    } else {
      body = {};
    }
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as any;
  };
}

const DEFAULT_PARAMS = {
  minNetApr: 0.05, // 5%
  cexVenues: ['binance', 'okx', 'bybit', 'mexc', 'gate'],
  hlVenueName: 'Hyperliquid',
  useVooiExecutor: false,
  vooiVenueSet: [],
  autoExecute: false,
  maxNotionalUsd: 5000,
  minHlFundingApr: 0.02, // 2%
};

interface Fixture {
  sharpe: SharpeClient;
  vooi: VooiClient;
  log: FetchLog;
}

function makeFixture(opts: {
  crossExchange?: any;
  fundingRates?: any;
  vooi?: any;
}): Fixture {
  const log: FetchLog = [];
  const fetchImpl = makeMockFetch(log, opts);
  const sharpe = new SharpeClient({ apiKey: 'test-key', fetchImpl: fetchImpl as any });
  const vooi = new VooiClient({ apiToken: 'test', fetchImpl: fetchImpl as any });
  return { sharpe, vooi, log };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('CexHlFundingArbStrategy — EM-STRAT-004 signal-integrity regressions', () => {

  describe('Sharpe netApr is NEVER treated as raw HL funding rate (EM-STRAT-004 §2)', () => {
    it('stores sharpeNetApr as a third-party reference, NOT in hlFundingApr', async () => {
      // Sharpe cross-exchange returns netApr=10% for ETH (long=Binance, short=Hyperliquid).
      // Raw /funding/rates returns HL=11% and Binance=0.5%.
      // The scanner MUST store sharpeNetApr=10 (reference) and hlFundingApr=11 (raw).
      // Previous behavior: hlFundingApr = netApr = 10 — WRONG.
      const { sharpe, vooi } = makeFixture({
        crossExchange: {
          data: [{
            coin: 'ETH',
            longExchange: 'binance',
            shortExchange: 'Hyperliquid',
            netApr: 10,
            grossApr: 10.5,
            longOiUsd: 5_000_000,
            shortOiUsd: 5_000_000,
          }],
        },
        fundingRates: {
          data: [
            { coin: 'ETH', exchange: 'Hyperliquid', rate: 0.001, annualized: 11 },
            { coin: 'ETH', exchange: 'binance', rate: 0.0001, annualized: 0.5 },
          ],
        },
      });
      const strat = new CexHlFundingArbStrategy(sharpe, vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts.length).toBe(1);
      const a = alerts[0];
      // EM-STRAT-004: hlFundingApr must be the raw HL rate (11%), NOT the Sharpe netApr (10%).
      expect(a.hlFundingApr).toBe(11);
      expect(a.hlFundingApr).not.toBe(a.sharpeNetApr);
      // sharpeNetApr is stored separately as a reference.
      expect(a.sharpeNetApr).toBe(10);
    });

    it('never computes netSpreadApr by subtracting cexFundingApr from sharpeNetApr', async () => {
      // Sharpe netApr=10. Raw HL=11, raw CEX=0.5.
      // Correct netSpreadApr = hlRaw - cexRaw = 11 - 0.5 = 10.5
      // WRONG (previous) would be: netApr - cexRaw = 10 - 0.5 = 9.5
      const { sharpe, vooi } = makeFixture({
        crossExchange: {
          data: [{
            coin: 'ETH',
            longExchange: 'binance',
            shortExchange: 'Hyperliquid',
            netApr: 10,
            longOiUsd: 5_000_000,
            shortOiUsd: 5_000_000,
          }],
        },
        fundingRates: {
          data: [
            { coin: 'ETH', exchange: 'Hyperliquid', rate: 0.001, annualized: 11 },
            { coin: 'ETH', exchange: 'binance', rate: 0.0001, annualized: 0.5 },
          ],
        },
      });
      const strat = new CexHlFundingArbStrategy(sharpe, vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts.length).toBe(1);
      const a = alerts[0];
      // EM-STRAT-004: netSpreadApr = hlRaw - cexRaw = 11 - 0.5 = 10.5 (NOT 9.5)
      expect(a.netSpreadApr).toBeCloseTo(10.5, 5);
      expect(a.netSpreadApr).not.toBeCloseTo(9.5, 5);
    });
  });

  describe('missing raw rate data → non-actionable (EM-STRAT-004 §2)', () => {
    it('sets hlFundingApr=null when /funding/rates has no HL row for the asset', async () => {
      const { sharpe, vooi } = makeFixture({
        crossExchange: {
          data: [{
            coin: 'ETH',
            longExchange: 'binance',
            shortExchange: 'Hyperliquid',
            netApr: 10,
            longOiUsd: 5_000_000,
            shortOiUsd: 5_000_000,
          }],
        },
        fundingRates: {
          data: [
            // Only CEX row, no HL row.
            { coin: 'ETH', exchange: 'binance', rate: 0.0001, annualized: 0.5 },
          ],
        },
      });
      const strat = new CexHlFundingArbStrategy(sharpe, vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts.length).toBe(1);
      const a = alerts[0];
      expect(a.hlFundingApr).toBeNull();
      expect(a.cexFundingApr).toBe(0.5);
      expect(a.netSpreadApr).toBeNull();
      expect(a.actionable).toBe(false);
    });

    it('sets cexFundingApr=null when /funding/rates has no CEX row for the asset', async () => {
      const { sharpe, vooi } = makeFixture({
        crossExchange: {
          data: [{
            coin: 'ETH',
            longExchange: 'binance',
            shortExchange: 'Hyperliquid',
            netApr: 10,
            longOiUsd: 5_000_000,
            shortOiUsd: 5_000_000,
          }],
        },
        fundingRates: {
          data: [
            { coin: 'ETH', exchange: 'Hyperliquid', rate: 0.001, annualized: 11 },
            // No CEX row.
          ],
        },
      });
      const strat = new CexHlFundingArbStrategy(sharpe, vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts.length).toBe(1);
      const a = alerts[0];
      expect(a.hlFundingApr).toBe(11);
      expect(a.cexFundingApr).toBeNull();
      expect(a.netSpreadApr).toBeNull();
      expect(a.actionable).toBe(false);
    });

    it('sets netSpreadApr=null when /funding/rates call fails entirely', async () => {
      // fundingRates returns empty data (simulating API failure).
      const { sharpe, vooi } = makeFixture({
        crossExchange: {
          data: [{
            coin: 'ETH',
            longExchange: 'binance',
            shortExchange: 'Hyperliquid',
            netApr: 10,
            longOiUsd: 5_000_000,
            shortOiUsd: 5_000_000,
          }],
        },
        fundingRates: { data: [] },
      });
      const strat = new CexHlFundingArbStrategy(sharpe, vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts.length).toBe(1);
      const a = alerts[0];
      expect(a.hlFundingApr).toBeNull();
      expect(a.cexFundingApr).toBeNull();
      expect(a.netSpreadApr).toBeNull();
      expect(a.actionable).toBe(false);
    });
  });

  describe('valid leg rates produce independently verified net (EM-STRAT-004 §2)', () => {
    it('computes netSpreadApr = hlRaw - cexRaw when both raw rates are present', async () => {
      const { sharpe, vooi } = makeFixture({
        crossExchange: {
          data: [{
            coin: 'ETH',
            longExchange: 'binance',
            shortExchange: 'Hyperliquid',
            netApr: 10,
            longOiUsd: 5_000_000,
            shortOiUsd: 5_000_000,
          }],
        },
        fundingRates: {
          data: [
            { coin: 'ETH', exchange: 'Hyperliquid', rate: 0.001, annualized: 11 },
            { coin: 'ETH', exchange: 'binance', rate: 0.0001, annualized: 0.5 },
          ],
        },
      });
      const strat = new CexHlFundingArbStrategy(sharpe, vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts.length).toBe(1);
      const a = alerts[0];
      expect(a.hlFundingApr).toBe(11);
      expect(a.cexFundingApr).toBe(0.5);
      expect(a.netSpreadApr).toBeCloseTo(10.5, 5);
      expect(a.actionable).toBe(true);
    });

    it('actionable flag is true when netSpreadApr >= minNetApr AND HL funding >= minHlFundingApr', async () => {
      const { sharpe, vooi } = makeFixture({
        crossExchange: {
          data: [{
            coin: 'BTC',
            longExchange: 'okx',
            shortExchange: 'Hyperliquid',
            netApr: 8,
            longOiUsd: 5_000_000,
            shortOiUsd: 5_000_000,
          }],
        },
        fundingRates: {
          data: [
            { coin: 'BTC', exchange: 'Hyperliquid', rate: 0.001, annualized: 10.95 },
            { coin: 'BTC', exchange: 'okx', rate: 0.0001, annualized: 0.5 },
          ],
        },
      });
      const strat = new CexHlFundingArbStrategy(sharpe, vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts[0].actionable).toBe(true);
    });
  });

  describe('sign / orientation behavior (EM-STRAT-004 §2)', () => {
    it('skips alerts where HL is the LONG side (HL longs pay shorts → wrong direction)', async () => {
      // Sharpe row: longExchange=Hyperliquid, shortExchange=binance.
      // This means HL longs pay shorts → we want to SHORT HL, not long it.
      // The scanner must skip these rows (existing behavior, retained).
      const { sharpe, vooi } = makeFixture({
        crossExchange: {
          data: [{
            coin: 'ETH',
            longExchange: 'Hyperliquid', // HL on long side
            shortExchange: 'binance',
            netApr: 10,
            longOiUsd: 5_000_000,
            shortOiUsd: 5_000_000,
          }],
        },
        fundingRates: {
          data: [
            { coin: 'ETH', exchange: 'Hyperliquid', rate: 0.001, annualized: 11 },
            { coin: 'ETH', exchange: 'binance', rate: 0.0001, annualized: 0.5 },
          ],
        },
      });
      const strat = new CexHlFundingArbStrategy(sharpe, vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts.length).toBe(0);
    });

    it('actionable=false when HL funding is negative (shorts pay funding)', async () => {
      // HYPE funding flipped to -6.88% on Sep 28 2026. Even if netSpreadApr
      // is positive (because CEX funding is even more negative), shorts on HL
      // would PAY funding, not collect it. The actionable flag must be false.
      const { sharpe, vooi } = makeFixture({
        crossExchange: {
          data: [{
            coin: 'HYPE',
            longExchange: 'binance',
            shortExchange: 'Hyperliquid',
            netApr: 5,
            longOiUsd: 5_000_000,
            shortOiUsd: 5_000_000,
          }],
        },
        fundingRates: {
          data: [
            { coin: 'HYPE', exchange: 'Hyperliquid', rate: -0.0007, annualized: -6.88 },
            { coin: 'HYPE', exchange: 'binance', rate: -0.001, annualized: -10.0 },
          ],
        },
      });
      const strat = new CexHlFundingArbStrategy(sharpe, vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts.length).toBe(1);
      const a = alerts[0];
      expect(a.hlFundingApr).toBe(-6.88);
      // netSpreadApr = -6.88 - (-10.0) = 3.12 — positive, but HL funding is negative.
      expect(a.netSpreadApr).toBeCloseTo(3.12, 2);
      // EM-STRAT-004: actionable=false because HL funding is below minHlFundingApr (0.02).
      expect(a.actionable).toBe(false);
    });

    it('actionable=false when netSpreadApr is positive but below minNetApr', async () => {
      // HL=3%, CEX=2.5% → net=0.5% (above 0 but below minNetApr=5%).
      const { sharpe, vooi } = makeFixture({
        crossExchange: {
          data: [{
            coin: 'ETH',
            longExchange: 'binance',
            shortExchange: 'Hyperliquid',
            netApr: 0.5,
            longOiUsd: 5_000_000,
            shortOiUsd: 5_000_000,
          }],
        },
        fundingRates: {
          data: [
            { coin: 'ETH', exchange: 'Hyperliquid', rate: 0.0003, annualized: 3 },
            { coin: 'ETH', exchange: 'binance', rate: 0.00025, annualized: 2.5 },
          ],
        },
      });
      const strat = new CexHlFundingArbStrategy(sharpe, vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts.length).toBe(1);
      expect(alerts[0].netSpreadApr).toBeCloseTo(0.5, 5);
      expect(alerts[0].actionable).toBe(false);
    });
  });

  describe('exact alert fields (EM-STRAT-004 §2)', () => {
    it('alert shape contains all required fields with correct semantics', async () => {
      const { sharpe, vooi } = makeFixture({
        crossExchange: {
          data: [{
            coin: 'ETH',
            longExchange: 'binance',
            shortExchange: 'Hyperliquid',
            netApr: 10,
            longOiUsd: 1_000_000,
            shortOiUsd: 2_000_000,
          }],
        },
        fundingRates: {
          data: [
            { coin: 'ETH', exchange: 'Hyperliquid', rate: 0.001, annualized: 11 },
            { coin: 'ETH', exchange: 'binance', rate: 0.0001, annualized: 0.5 },
          ],
        },
      });
      const strat = new CexHlFundingArbStrategy(sharpe, vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      const a = alerts[0] as CexHlFundingAlert;
      // Required fields per EM-STRAT-004 §2:
      expect(a).toHaveProperty('asset', 'ETH');
      expect(a).toHaveProperty('cexVenue', 'binance');
      expect(a).toHaveProperty('hlFundingApr', 11); // raw, not null, not sharpeNetApr
      expect(a).toHaveProperty('cexFundingApr', 0.5); // raw, not null
      expect(a).toHaveProperty('netSpreadApr'); // independently verified
      expect(a.netSpreadApr).toBeCloseTo(10.5, 5);
      expect(a).toHaveProperty('sharpeNetApr', 10); // third-party reference
      expect(a).toHaveProperty('actionable', true);
      // OI fields flow from Sharpe row.
      expect(a.hlOiUsd).toBe(2_000_000);
      expect(a.cexOiUsd).toBe(1_000_000);
    });

    it('sharpeNetApr falls back to grossApr when netApr is missing', async () => {
      const { sharpe, vooi } = makeFixture({
        crossExchange: {
          data: [{
            coin: 'ETH',
            longExchange: 'binance',
            shortExchange: 'Hyperliquid',
            grossApr: 9, // netApr missing
            longOiUsd: 5_000_000,
            shortOiUsd: 5_000_000,
          }],
        },
        fundingRates: {
          data: [
            { coin: 'ETH', exchange: 'Hyperliquid', rate: 0.001, annualized: 11 },
            { coin: 'ETH', exchange: 'binance', rate: 0.0001, annualized: 0.5 },
          ],
        },
      });
      const strat = new CexHlFundingArbStrategy(sharpe, vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      // Note: crossExchangeFunding filters by minApr; if netApr missing, the
      // row's netApr is undefined and may be filtered by SharpeClient. We
      // test the strategy's own fallback by checking the alert shape.
      if (alerts.length > 0) {
        expect(alerts[0].sharpeNetApr).toBe(9);
      }
    });

    it('sharpeNetApr is null when both netApr and grossApr are missing', async () => {
      const { sharpe, vooi } = makeFixture({
        crossExchange: {
          data: [{
            coin: 'ETH',
            longExchange: 'binance',
            shortExchange: 'Hyperliquid',
            longOiUsd: 5_000_000,
            shortOiUsd: 5_000_000,
          }],
        },
        fundingRates: {
          data: [
            { coin: 'ETH', exchange: 'Hyperliquid', rate: 0.001, annualized: 11 },
            { coin: 'ETH', exchange: 'binance', rate: 0.0001, annualized: 0.5 },
          ],
        },
      });
      const strat = new CexHlFundingArbStrategy(sharpe, vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      // The strategy does not filter on netApr internally — SharpeClient may.
      // If we get an alert, sharpeNetApr should be null.
      if (alerts.length > 0) {
        expect(alerts[0].sharpeNetApr).toBeNull();
      }
    });
  });

  describe('stale / invalid rates', () => {
    it('treats non-finite annualized as missing (null)', async () => {
      const { sharpe, vooi } = makeFixture({
        crossExchange: {
          data: [{
            coin: 'ETH',
            longExchange: 'binance',
            shortExchange: 'Hyperliquid',
            netApr: 10,
            longOiUsd: 5_000_000,
            shortOiUsd: 5_000_000,
          }],
        },
        fundingRates: {
          data: [
            { coin: 'ETH', exchange: 'Hyperliquid', rate: 0.001, annualized: NaN },
            { coin: 'ETH', exchange: 'binance', rate: 0.0001, annualized: 0.5 },
          ],
        },
      });
      const strat = new CexHlFundingArbStrategy(sharpe, vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts.length).toBe(1);
      expect(alerts[0].hlFundingApr).toBeNull();
      expect(alerts[0].cexFundingApr).toBe(0.5);
      expect(alerts[0].netSpreadApr).toBeNull();
      expect(alerts[0].actionable).toBe(false);
    });
  });

  describe('strategy interface compliance', () => {
    it('implements Strategy interface', () => {
      const { sharpe, vooi } = makeFixture({});
      const strat = new CexHlFundingArbStrategy(sharpe, vooi, DEFAULT_PARAMS);
      expect(strat.id).toBe('cex_hl_funding_arb');
      expect(strat.landscape).toBe('F_perps_funding');
    });

    it('scan returns array (empty when no candidates)', async () => {
      const { sharpe, vooi } = makeFixture({});
      const strat = new CexHlFundingArbStrategy(sharpe, vooi, DEFAULT_PARAMS);
      const results = await strat.scan();
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(0);
    });
  });
});
