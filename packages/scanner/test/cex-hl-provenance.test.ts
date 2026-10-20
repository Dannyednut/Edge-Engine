import { describe, it, expect } from 'vitest';
import { CexHlFundingArbStrategy, type CexHlFundingAlert, type CexHlFundingProvenance } from '../src/strategies/cex-hl-funding-arb.js';
import { SharpeClient } from '@edge/sharpe-client';
import { VooiClient } from '@edge/vooi-client';

// ─── EM-STRAT-005 §2 regression tests ──────────────────────────────────
//
// These tests verify the CEX-HL funding provenance model:
//   - Sharpe /funding/rates is the SAME provider as cross-exchange — NOT
//     independent corroboration.
//   - Per-leg raw rates are third-party-sourced until venue-native public
//     endpoints are wired.
//   - Until then, every alert is non-actionable with provenance label
//     'third-party-sourced'.
//   - Provider failure, stale/invalid rates, sign changes, and missing
//     data all result in non-actionable alerts with explicit labels.
//
// OLD BEHAVIOR (PR #5 head 4aba073, EM-STRAT-004):
//   - actionable was true when both raw rates were present AND netSpreadApr
//     >= minNetApr AND hlFundingApr >= minHlFundingApr.
//   - The /funding/rates endpoint was treated as "independently verified".
//
// NEW BEHAVIOR (EM-STRAT-005 §2):
//   - provenance is ALWAYS 'third-party-sourced' (current implementation).
//   - actionable is ALWAYS false (provenance gating).
//   - netSpreadApr is still computed for diagnostic visibility but is
//     labeled as third-party-sourced, NOT independently verified.

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
  minNetApr: 0.05,
  cexVenues: ['binance', 'okx', 'bybit', 'mexc', 'gate'],
  hlVenueName: 'Hyperliquid',
  useVooiExecutor: false,
  vooiVenueSet: [],
  autoExecute: false,
  maxNotionalUsd: 5000,
  minHlFundingApr: 0.02,
};

function makeFixture(opts: {
  crossExchange?: any;
  fundingRates?: any;
  vooi?: any;
}): { sharpe: SharpeClient; vooi: VooiClient; log: FetchLog } {
  const log: FetchLog = [];
  const fetchImpl = makeMockFetch(log, opts);
  const sharpe = new SharpeClient({ apiKey: 'test-key', fetchImpl: fetchImpl as any });
  const vooi = new VooiClient({ apiToken: 'test', fetchImpl: fetchImpl as any });
  return { sharpe, vooi, log };
}

describe('EM-STRAT-005 §2 — CEX-HL provenance and non-actionable fallback regressions', () => {

  describe('provenance is ALWAYS third-party-sourced (current implementation)', () => {
    it('provenance = "third-party-sourced" even when both raw rates are present', async () => {
      // OLD BEHAVIOR: would have set actionable=true here.
      // NEW BEHAVIOR: provenance is 'third-party-sourced', actionable is false.
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
      const a = alerts[0] as CexHlFundingAlert;
      expect(a.provenance).toBe('third-party-sourced');
      expect(a.actionable).toBe(false);
      // netSpreadApr is still computed for diagnostic visibility.
      expect(a.netSpreadApr).toBeCloseTo(10.5, 5);
    });
  });

  describe('provider failure → non-actionable fallback', () => {
    it('/funding/rates returns empty (provider failure): all rates null, actionable false', async () => {
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
        fundingRates: { data: [] }, // provider failure
      });
      const strat = new CexHlFundingArbStrategy(sharpe, vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts.length).toBe(1);
      const a = alerts[0];
      expect(a.hlFundingApr).toBeNull();
      expect(a.cexFundingApr).toBeNull();
      expect(a.netSpreadApr).toBeNull();
      expect(a.provenance).toBe('third-party-sourced');
      expect(a.actionable).toBe(false);
    });

    it('/funding/rates throws (network error): non-actionable fallback, no crash', async () => {
      // SharpeClient will throw on fetch error; we simulate by returning
      // a 500 status. The scanner catches the error and continues with
      // empty funding rows.
      const log: FetchLog = [];
      const fetchImpl = async (url: string | URL | Request, _init?: any) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        log.push({ url: urlStr });
        if (urlStr.includes('/funding/rates')) {
          return { ok: false, status: 500, json: async () => ({ error: 'server error' }), text: async () => '' } as any;
        }
        let body: any;
        if (urlStr.includes('/arbitrage/cross-exchange')) {
          body = {
            data: [{
              coin: 'ETH', longExchange: 'binance', shortExchange: 'Hyperliquid',
              netApr: 10, longOiUsd: 5_000_000, shortOiUsd: 5_000_000,
            }],
          };
        } else {
          body = { items: [], total: 0 };
        }
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as any;
      };
      const sharpe = new SharpeClient({ apiKey: 'test-key', fetchImpl: fetchImpl as any });
      const vooi = new VooiClient({ apiToken: 'test', fetchImpl: fetchImpl as any });
      const strat = new CexHlFundingArbStrategy(sharpe, vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      // Non-actionable fallback: alert still emitted (cross-exchange data present),
      // but rates are null and actionable is false.
      expect(alerts.length).toBe(1);
      expect(alerts[0].hlFundingApr).toBeNull();
      expect(alerts[0].cexFundingApr).toBeNull();
      expect(alerts[0].netSpreadApr).toBeNull();
      expect(alerts[0].actionable).toBe(false);
    });
  });

  describe('stale / invalid raw rates → non-actionable', () => {
    it('raw rate with NaN annualized is treated as missing', async () => {
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
      expect(alerts[0].hlFundingApr).toBeNull();
      expect(alerts[0].cexFundingApr).toBe(0.5);
      expect(alerts[0].netSpreadApr).toBeNull();
      expect(alerts[0].actionable).toBe(false);
    });

    it('raw rate with Infinity annualized is treated as missing', async () => {
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
            { coin: 'ETH', exchange: 'Hyperliquid', rate: 0.001, annualized: Infinity },
            { coin: 'ETH', exchange: 'binance', rate: 0.0001, annualized: 0.5 },
          ],
        },
      });
      const strat = new CexHlFundingArbStrategy(sharpe, vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      expect(alerts[0].hlFundingApr).toBeNull();
      expect(alerts[0].netSpreadApr).toBeNull();
      expect(alerts[0].actionable).toBe(false);
    });
  });

  describe('source provenance labeling', () => {
    it('alert body exposes provenance field for downstream presenters', async () => {
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
      const a = alerts[0] as CexHlFundingAlert;
      // EM-STRAT-005 §2: provenance field is present and labeled.
      expect(a).toHaveProperty('provenance');
      expect(typeof a.provenance).toBe('string');
      const validProvenanceValues: CexHlFundingProvenance[] = ['third-party-sourced', 'independently-corroborated'];
      expect(validProvenanceValues).toContain(a.provenance);
    });

    it('sharpeNetApr is stored separately from hlFundingApr (NOT used as raw rate)', async () => {
      // EM-STRAT-005 §2: Sharpe netApr/grossApr are third-party references.
      // They MUST NOT appear in hlFundingApr or cexFundingApr.
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
      const a = alerts[0];
      expect(a.sharpeNetApr).toBe(10);       // third-party reference
      expect(a.hlFundingApr).toBe(11);       // raw HL rate (different from sharpeNetApr)
      expect(a.cexFundingApr).toBe(0.5);     // raw CEX rate
      expect(a.hlFundingApr).not.toBe(a.sharpeNetApr);
    });
  });

  describe('funding sign changes', () => {
    it('HL funding negative (HYPE -6.88% case): net spread computable but actionable false', async () => {
      // HYPE funding flipped to -6.88% on Sep 28 2026. Even though the
      // computed net spread (HL - CEX) might be positive, shorts on HL
      // would PAY funding. Combined with the provenance gate, the alert
      // is non-actionable.
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
      expect(a.cexFundingApr).toBe(-10.0);
      // netSpreadApr = -6.88 - (-10.0) = 3.12 — positive, but HL funding is negative.
      expect(a.netSpreadApr).toBeCloseTo(3.12, 2);
      // EM-STRAT-005 §2: provenance gating + HL funding negative → actionable false.
      expect(a.actionable).toBe(false);
      expect(a.provenance).toBe('third-party-sourced');
    });

    it('CEX funding negative (CEX shorts pay): net spread still computable but actionable false', async () => {
      const { sharpe, vooi } = makeFixture({
        crossExchange: {
          data: [{
            coin: 'ETH',
            longExchange: 'binance',
            shortExchange: 'Hyperliquid',
            netApr: 12,
            longOiUsd: 5_000_000,
            shortOiUsd: 5_000_000,
          }],
        },
        fundingRates: {
          data: [
            { coin: 'ETH', exchange: 'Hyperliquid', rate: 0.001, annualized: 11 },
            { coin: 'ETH', exchange: 'binance', rate: -0.0005, annualized: -5.0 },
          ],
        },
      });
      const strat = new CexHlFundingArbStrategy(sharpe, vooi, DEFAULT_PARAMS);
      const alerts = await strat.scan();
      const a = alerts[0];
      // netSpreadApr = 11 - (-5) = 16 — very favorable, but provenance gating.
      expect(a.netSpreadApr).toBeCloseTo(16, 5);
      expect(a.actionable).toBe(false);
      expect(a.provenance).toBe('third-party-sourced');
    });
  });

  describe('documentation correctness (EM-STRAT-005 §2)', () => {
    it('strategy source describes BOTH legs as perpetuals (not spot + perp)', async () => {
      // EM-STRAT-005 §2: previous documentation said "CEX spot (long) + HL perp (short)"
      // while subtracting a CEX perp funding rate — internally inconsistent.
      // The corrected documentation must describe both legs as perps.
      const fs = await import('node:fs');
      const path = await import('node:path');
      const src = fs.readFileSync(
        path.resolve(__dirname, '..', 'src', 'strategies', 'cex-hl-funding-arb.ts'),
        'utf8',
      );
      // The TRADE STRUCTURE section must describe both legs as perps.
      const tradeStructureMatch = src.match(/TRADE STRUCTURE[\s\S]*?(?=\n \*\/|\n \* [A-Z])/);
      expect(tradeStructureMatch, 'TRADE STRUCTURE section not found').not.toBeNull();
      const tradeStructure = tradeStructureMatch![0];
      // The actual LONG/SHORT lines must say "perp".
      // Format: "LONG  perp ETH on a CEX venue" / "SHORT perp ETH on Hyperliquid"
      const longLine = tradeStructure.match(/LONG\s+\w+\s+\w+\s+on/i);
      const shortLine = tradeStructure.match(/SHORT\s+\w+\s+\w+\s+on/i);
      expect(longLine, 'LONG line not found').not.toBeNull();
      expect(shortLine, 'SHORT line not found').not.toBeNull();
      expect(longLine![0]).toMatch(/perp/i);
      expect(shortLine![0]).toMatch(/perp/i);
      // The section must explicitly call out BOTH legs as perpetuals.
      // The phrase spans a comment-wrapped line, so use [\s\S] to cross newlines.
      expect(tradeStructure).toMatch(/BOTH legs[\s\S]*?are perpetuals/i);
    });
  });
});
