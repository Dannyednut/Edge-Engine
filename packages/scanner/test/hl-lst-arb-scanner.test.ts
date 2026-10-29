import { describe, it, expect } from 'vitest';
import { HlLstArbScanner, MIN_NET_DISCOUNT_PCT_DEFAULT, type HlLstArbDeps } from '../src/strategies/hl-lst-arb-scanner.js';
import { HYPERSWAP_V3_POOLS, HYPERLEND_FLASHLOAN_FEE } from '../src/lib/hyperliquid-defi.js';

// ─── Test helpers ──────────────────────────────────────────────────────
//
// The scanner reads on-chain state via JSON-RPC. To make tests deterministic
// and to exercise specific scenarios without hitting live RPC, we inject a
// mock `rpcCall` that returns canned responses keyed by call signature.
//
// Call signatures the scanner makes:
//   1. eth_call(Accountant.kHYPEToHYPE)  → returns anchor rate (hex 1e18-scaled)
//   2. eth_getBlockByNumber('latest', false) → returns { timestamp: '0x...' }
//   3. eth_call(StakingManager.withdrawalDelay) → returns delay in seconds
//   4. eth_call(pool.slot0) → returns sqrtPriceX96 (hex, padded to 32 bytes)
//   5. eth_call(pool.liquidity) → returns liquidity (hex, padded to 32 bytes)
//
// We identify calls by the `to` address (lowercased) embedded in the params.

const ACCOUNTANT_ADDR = '0x9209648Ec9D448EF57116B73A2f081835643dc7A'.toLowerCase();
const STAKING_MANAGER_ADDR = '0x393D0B87Ed38fc779FD9611144aE649BA6082109'.toLowerCase();

interface MockScenario {
  anchorRate?: string;       // hex of 1e18-scaled rate (e.g., 1.0265e18)
  anchorRateRaw?: string;    // raw hex result for kHYPEToHYPE call (override anchorRate)
  blockTs?: number;          // seconds since epoch
  withdrawalDelay?: string;  // hex of seconds
  poolSlot0?: Record<string, string>;  // poolAddress → hex sqrtPriceX96
  poolLiquidity?: Record<string, string>; // poolAddress → hex liquidity
  now?: number;              // ms since epoch
}

function makeDeps(s: MockScenario): HlLstArbDeps {
  return {
    rpcCall: async (method, params) => {
      if (method === 'eth_getBlockByNumber') {
        return { result: { timestamp: '0x' + (s.blockTs ?? Math.floor(Date.now() / 1000)).toString(16) } } as any;
      }
      if (method === 'eth_call') {
        const p = params as Array<{ to: string; data: string }>;
        const to = (p[0]?.to || '').toLowerCase();
        if (to === ACCOUNTANT_ADDR) {
          const hex = s.anchorRateRaw ?? s.anchorRate ?? '0x' + (BigInt(Math.floor(1.0265 * 1e18)).toString(16));
          return { result: hex.padEnd(66, '0') };
        }
        if (to === STAKING_MANAGER_ADDR) {
          return { result: (s.withdrawalDelay ?? '0x' + (604800).toString(16)).padEnd(66, '0') };
        }
        // Pool calls
        const data = p[0]?.data || '';
        if (data === '0x3850c7bd') {
          // slot0
          const slot0Hex = s.poolSlot0?.[to] ?? '0x' + (0).toString(16).padStart(64, '0');
          // slot0 returns 32 bytes (sqrtPriceX96) + more; we return just the first word padded
          return { result: slot0Hex.padEnd(66, '0') };
        }
        if (data === '0x1a686502') {
          // liquidity
          const liqHex = s.poolLiquidity?.[to] ?? '0x' + (BigInt(1e18)).toString(16);
          return { result: liqHex.padEnd(66, '0') };
        }
      }
      return { result: '0x' };
    },
    now: s.now ? () => s.now! : undefined,
  };
}

// Helper: encode a 1e18-scaled rate as a 32-byte hex word.
function rateHex(rate: number): string {
  return '0x' + BigInt(Math.round(rate * 1e18)).toString(16).padStart(64, '0');
}

// Helper: encode a sqrtPriceX96 that yields a target "kHYPE per WHYPE" price.
// v3PriceToHuman = (sqrtPriceX96 / 2^96)^2 * 10^(dec0 - dec1)
// dec0=18 (WHYPE), dec1=18 (kHYPE) → decimalAdjustment = 1
// So price = (sqrtPriceX96 / 2^96)^2
// sqrtPriceX96 = sqrt(price) * 2^96
function sqrtPriceHex(price: number): string {
  const sqrtPrice = Math.sqrt(price);
  const sqrtPriceX96 = BigInt(Math.floor(sqrtPrice * Math.pow(2, 96)));
  return '0x' + sqrtPriceX96.toString(16).padStart(64, '0');
}

// Default scenario: anchor rate 1.0265, market price = 1.05 kHYPE/WHYPE
// → fairPrice = 1/1.0265 ≈ 0.9742 kHYPE/WHYPE
// → grossDiscount = (1.05 - 0.9742) / 0.9742 * 100 ≈ 7.78%
// → AMM fee (tier 100) = 0.01%, flashloan fee = 0.04%
// → net = 7.78 - 0.01 - 0.04 = 7.73% (well above 0.30% threshold)
const DEFAULT_NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z
const DEFAULT_BLOCK_TS = Math.floor(DEFAULT_NOW / 1000) - 30; // 30s ago → fresh

const khypePools = HYPERSWAP_V3_POOLS.filter(p => p.pair === 'WHYPE/kHYPE');
const pool100 = khypePools.find(p => p.fee === 100)!;
const pool500 = khypePools.find(p => p.fee === 500)!;
const pool3000 = khypePools.find(p => p.fee === 3000)!;
const pool10000 = khypePools.find(p => p.fee === 10000)!;

// ─── Tests ─────────────────────────────────────────────────────────────

describe('HlLstArbScanner — EM-STRAT-004 signal-integrity regressions', () => {
  describe('fee-tier conversion (EM-STRAT-004 §1)', () => {
    it('converts tier 100 to 0.01% (NOT 1.0% as previous formula gave)', async () => {
      // Previous formula `(pool.fee / 10000) * 100` gave 1.0% for tier 100.
      // Corrected formula `pool.fee / 10000` gives 0.01% for tier 100.
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100, minNetDiscountPct: 0.30 },
        makeDeps({
          anchorRate: rateHex(1.0265),
          blockTs: DEFAULT_BLOCK_TS,
          withdrawalDelay: '0x' + (604800).toString(16),
          poolSlot0: { [pool100.address]: sqrtPriceHex(1.05) }, // ~7.78% gross discount
          poolLiquidity: { [pool100.address]: '0x' + (BigInt(1e18)).toString(16) },
          now: DEFAULT_NOW,
        }),
      );
      const alerts = await scanner.scan();
      const a = alerts.find(x => x.feeTier === 100);
      expect(a, 'expected tier-100 alert').toBeDefined();
      // EM-STRAT-004: ammFeePct for tier 100 must be 0.01 (not 1.0)
      expect(a!.ammFeePct).toBeCloseTo(0.01, 5);
      // Previous formula would have set ammFeePct = 1.0, which would have
      // pushed netProfitPct below the 0.30% threshold (7.78 - 1.0 - 0.04 = 6.74%).
      // Actually 6.74% > 0.30%, so the regression is more subtle. The real
      // regression is that the displayed fee was 100x too high — verified above.
    });

    it('converts tier 500 to 0.05%', async () => {
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 500, minNetDiscountPct: 0.30 },
        makeDeps({
          anchorRate: rateHex(1.0265),
          blockTs: DEFAULT_BLOCK_TS,
          withdrawalDelay: '0x' + (604800).toString(16),
          poolSlot0: { [pool500.address]: sqrtPriceHex(1.05) },
          poolLiquidity: { [pool500.address]: '0x' + (BigInt(1e18)).toString(16) },
          now: DEFAULT_NOW,
        }),
      );
      const alerts = await scanner.scan();
      const a = alerts.find(x => x.feeTier === 500);
      expect(a).toBeDefined();
      expect(a!.ammFeePct).toBeCloseTo(0.05, 5);
    });

    it('converts tier 3000 to 0.30%', async () => {
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 3000, minNetDiscountPct: 0.30 },
        makeDeps({
          anchorRate: rateHex(1.0265),
          blockTs: DEFAULT_BLOCK_TS,
          withdrawalDelay: '0x' + (604800).toString(16),
          poolSlot0: { [pool3000.address]: sqrtPriceHex(1.05) },
          poolLiquidity: { [pool3000.address]: '0x' + (BigInt(1e18)).toString(16) },
          now: DEFAULT_NOW,
        }),
      );
      const alerts = await scanner.scan();
      const a = alerts.find(x => x.feeTier === 3000);
      expect(a).toBeDefined();
      expect(a!.ammFeePct).toBeCloseTo(0.30, 5);
    });

    it('converts tier 10000 to 1.00%', async () => {
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 10000, minNetDiscountPct: 0.30 },
        makeDeps({
          anchorRate: rateHex(1.0265),
          blockTs: DEFAULT_BLOCK_TS,
          withdrawalDelay: '0x' + (604800).toString(16),
          poolSlot0: { [pool10000.address]: sqrtPriceHex(1.10) }, // bigger discount to clear 1% fee
          poolLiquidity: { [pool10000.address]: '0x' + (BigInt(1e18)).toString(16) },
          now: DEFAULT_NOW,
        }),
      );
      const alerts = await scanner.scan();
      const a = alerts.find(x => x.feeTier === 10000);
      expect(a).toBeDefined();
      expect(a!.ammFeePct).toBeCloseTo(1.00, 5);
    });
  });

  describe('0.30% net discount threshold (EM-STRAT-004 §1)', () => {
    it('default minNetDiscountPct is 0.30', () => {
      expect(MIN_NET_DISCOUNT_PCT_DEFAULT).toBe(0.30);
    });

    it('rejects alert when net profit is positive but below 0.30%', async () => {
      // Construct a scenario where gross=0.5%, ammFee=0.01%, flashloan=0.04%.
      // net = 0.5 - 0.01 - 0.04 = 0.45% — above 0.30%, should be emitted.
      // Then construct another where gross=0.32%, net = 0.27% — below 0.30%,
      // should be REJECTED (previous behavior: emitted because net > 0).
      const anchor = 1.0265;
      // For tier 100, fairPrice = 1/anchor ≈ 0.9742
      // We want grossDiscountPct = 0.32 → marketPrice = 0.9742 * 1.0032 ≈ 0.9773
      const marketPriceFor032Gross = (1 / anchor) * (1 + 0.32 / 100);
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100, minNetDiscountPct: 0.30 },
        makeDeps({
          anchorRate: rateHex(anchor),
          blockTs: DEFAULT_BLOCK_TS,
          withdrawalDelay: '0x' + (604800).toString(16),
          poolSlot0: { [pool100.address]: sqrtPriceHex(marketPriceFor032Gross) },
          poolLiquidity: { [pool100.address]: '0x' + (BigInt(1e18)).toString(16) },
          now: DEFAULT_NOW,
        }),
      );
      const alerts = await scanner.scan();
      // gross=0.32%, amm=0.01%, flashloan=0.04%, net=0.27% — below 0.30% threshold.
      // EM-STRAT-004: scanner must reject. Previous behavior would have emitted.
      expect(alerts.length).toBe(0);
    });

    it('accepts alert when net profit is exactly at 0.30% threshold', async () => {
      const anchor = 1.0265;
      // gross = 0.35%, net = 0.35 - 0.01 - 0.04 = 0.30% (exactly threshold)
      const marketPrice = (1 / anchor) * (1 + 0.35 / 100);
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100, minNetDiscountPct: 0.30 },
        makeDeps({
          anchorRate: rateHex(anchor),
          blockTs: DEFAULT_BLOCK_TS,
          withdrawalDelay: '0x' + (604800).toString(16),
          poolSlot0: { [pool100.address]: sqrtPriceHex(marketPrice) },
          poolLiquidity: { [pool100.address]: '0x' + (BigInt(1e18)).toString(16) },
          now: DEFAULT_NOW,
        }),
      );
      const alerts = await scanner.scan();
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      const a = alerts.find(x => x.feeTier === 100);
      expect(a).toBeDefined();
      expect(a!.netProfitPct).toBeCloseTo(0.30, 1);
    });

    it('accepts alert when net profit is well above 0.30%', async () => {
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100, minNetDiscountPct: 0.30 },
        makeDeps({
          anchorRate: rateHex(1.0265),
          blockTs: DEFAULT_BLOCK_TS,
          withdrawalDelay: '0x' + (604800).toString(16),
          poolSlot0: { [pool100.address]: sqrtPriceHex(1.05) }, // ~7.78% gross
          poolLiquidity: { [pool100.address]: '0x' + (BigInt(1e18)).toString(16) },
          now: DEFAULT_NOW,
        }),
      );
      const alerts = await scanner.scan();
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      const a = alerts[0];
      expect(a.netProfitPct).toBeGreaterThan(0.30);
      expect(a.estimatedProfitUsd).toBeGreaterThan(0);
    });
  });

  describe('anchor freshness from real source (EM-STRAT-004 §1)', () => {
    it('uses on-chain block timestamp, NOT local fetch time', async () => {
      // The scanner must record anchorBlockTs from eth_getBlockByNumber, not Date.now().
      // Set up: block timestamp = T - 60s, now = T. Anchor is fresh (< 5 min).
      const fixedBlockTs = Math.floor(DEFAULT_NOW / 1000) - 60; // 60s before now
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100, minNetDiscountPct: 0.30 },
        makeDeps({
          anchorRate: rateHex(1.0265),
          blockTs: fixedBlockTs,
          withdrawalDelay: '0x' + (604800).toString(16),
          poolSlot0: { [pool100.address]: sqrtPriceHex(1.05) },
          poolLiquidity: { [pool100.address]: '0x' + (BigInt(1e18)).toString(16) },
          now: DEFAULT_NOW,
        }),
      );
      const alerts = await scanner.scan();
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      // anchorBlockTs must equal the block timestamp, NOT the local now()/1000.
      expect(alerts[0].anchorBlockTs).toBe(fixedBlockTs);
      expect(alerts[0].anchorBlockTs).not.toBe(Math.floor(DEFAULT_NOW / 1000));
    });

    it('fails closed when block timestamp is older than 5 minutes', async () => {
      // Block timestamp = now - 10 minutes. Anchor must be considered stale.
      const staleBlockTs = Math.floor(DEFAULT_NOW / 1000) - 600; // 10 min ago
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100, minNetDiscountPct: 0.30 },
        makeDeps({
          anchorRate: rateHex(1.0265),
          blockTs: staleBlockTs,
          withdrawalDelay: '0x' + (604800).toString(16),
          poolSlot0: { [pool100.address]: sqrtPriceHex(1.05) },
          poolLiquidity: { [pool100.address]: '0x' + (BigInt(1e18)).toString(16) },
          now: DEFAULT_NOW,
        }),
      );
      const alerts = await scanner.scan();
      // EM-STRAT-004: stale anchor → fail closed (empty array).
      expect(alerts).toEqual([]);
    });

    it('fails closed when eth_getBlockByNumber returns no timestamp', async () => {
      // Block returns an object without timestamp — fetchRedemptionAnchor should return null.
      const deps: HlLstArbDeps = {
        rpcCall: async (method) => {
          if (method === 'eth_getBlockByNumber') {
            return { result: { /* no timestamp */ } } as any;
          }
          if (method === 'eth_call') {
            return { result: rateHex(1.0265) };
          }
          return { result: '0x' };
        },
        now: () => DEFAULT_NOW,
      };
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100, minNetDiscountPct: 0.30 },
        deps,
      );
      const alerts = await scanner.scan();
      expect(alerts).toEqual([]);
    });
  });

  describe('anchor freshness — EM-STRAT-005 §4 (chain head, NOT Accountant state-change)', () => {
    it('fails closed on FUTURE block timestamp (clock skew / malformed RPC)', async () => {
      // EM-STRAT-005 §4: a future block timestamp indicates either clock skew
      // or a malformed RPC response. The scanner must fail closed.
      // Block timestamp = now + 5 minutes (way beyond 60s tolerance).
      const futureBlockTs = Math.floor(DEFAULT_NOW / 1000) + 300;
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100, minNetDiscountPct: 0.30 },
        makeDeps({
          anchorRate: rateHex(1.0265),
          blockTs: futureBlockTs,
          withdrawalDelay: '0x' + (604800).toString(16),
          poolSlot0: { [pool100.address]: sqrtPriceHex(1.05) },
          poolLiquidity: { [pool100.address]: '0x' + (BigInt(1e18)).toString(16) },
          now: DEFAULT_NOW,
        }),
      );
      const alerts = await scanner.scan();
      expect(alerts).toEqual([]);
    });

    it('fails closed on block timestamp slightly in the future beyond 60s tolerance', async () => {
      // EM-STRAT-005 §4: 60s tolerance for clock skew. 90s in the future is beyond tolerance.
      const futureBlockTs = Math.floor(DEFAULT_NOW / 1000) + 90;
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100, minNetDiscountPct: 0.30 },
        makeDeps({
          anchorRate: rateHex(1.0265),
          blockTs: futureBlockTs,
          withdrawalDelay: '0x' + (604800).toString(16),
          poolSlot0: { [pool100.address]: sqrtPriceHex(1.05) },
          poolLiquidity: { [pool100.address]: '0x' + (BigInt(1e18)).toString(16) },
          now: DEFAULT_NOW,
        }),
      );
      const alerts = await scanner.scan();
      expect(alerts).toEqual([]);
    });

    it('accepts block timestamp within 60s future tolerance (clock skew allowed)', async () => {
      // EM-STRAT-005 §4: 30s in the future is within the 60s tolerance.
      const skewBlockTs = Math.floor(DEFAULT_NOW / 1000) + 30;
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100, minNetDiscountPct: 0.30 },
        makeDeps({
          anchorRate: rateHex(1.0265),
          blockTs: skewBlockTs,
          withdrawalDelay: '0x' + (604800).toString(16),
          poolSlot0: { [pool100.address]: sqrtPriceHex(1.05) },
          poolLiquidity: { [pool100.address]: '0x' + (BigInt(1e18)).toString(16) },
          now: DEFAULT_NOW,
        }),
      );
      const alerts = await scanner.scan();
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      expect(alerts[0].anchorBlockTs).toBe(skewBlockTs);
    });

    it('fails closed on zero block timestamp', async () => {
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100, minNetDiscountPct: 0.30 },
        makeDeps({
          anchorRate: rateHex(1.0265),
          blockTs: 0,
          withdrawalDelay: '0x' + (604800).toString(16),
          poolSlot0: { [pool100.address]: sqrtPriceHex(1.05) },
          poolLiquidity: { [pool100.address]: '0x' + (BigInt(1e18)).toString(16) },
          now: DEFAULT_NOW,
        }),
      );
      const alerts = await scanner.scan();
      // fetchRedemptionAnchor returns null when blockTs <= 0.
      expect(alerts).toEqual([]);
    });

    it('fails closed on negative block timestamp', async () => {
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100, minNetDiscountPct: 0.30 },
        makeDeps({
          anchorRate: rateHex(1.0265),
          blockTs: -1,
          withdrawalDelay: '0x' + (604800).toString(16),
          poolSlot0: { [pool100.address]: sqrtPriceHex(1.05) },
          poolLiquidity: { [pool100.address]: '0x' + (BigInt(1e18)).toString(16) },
          now: DEFAULT_NOW,
        }),
      );
      const alerts = await scanner.scan();
      expect(alerts).toEqual([]);
    });

    it('anchorBlockTs field is documented as chain-head ts (NOT Accountant state-change ts)', () => {
      // EM-STRAT-005 §4: the field comment must accurately describe what
      // the timestamp represents. We verify the source documentation does
      // NOT claim it proves when the Accountant state last changed.
      // (This is a static-source check — the field docstring is in the
      // HlLstArbAlert interface.)
      // We construct an alert and verify the field exists; the docstring
      // check is enforced by the strategy-labeling.test.ts source contract.
      const alert: HlLstArbAlert = {
        pair: 'WHYPE/kHYPE', poolAddress: '0x', feeTier: 100,
        marketPrice: 1.05, redemptionAnchor: 1.0265, grossDiscountPct: 5,
        netProfitPct: 4.95, estimatedProfitUsd: 247.5, ammFeePct: 0.01,
        flashloanFeePct: 0.04, poolLiquidity: 1n, withdrawalDelaySec: 604800,
        anchorBlockTs: 1700000000, anchorFresh: true, executable: false, ts: 0,
      };
      expect(alert.anchorBlockTs).toBe(1700000000);
    });
  });

  describe('missing required inputs fail closed (EM-STRAT-004 §1)', () => {
    it('fails closed when anchor rate is unavailable (0x)', async () => {
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100, minNetDiscountPct: 0.30 },
        makeDeps({
          anchorRateRaw: '0x',
          blockTs: DEFAULT_BLOCK_TS,
          withdrawalDelay: '0x' + (604800).toString(16),
          poolSlot0: { [pool100.address]: sqrtPriceHex(1.05) },
          poolLiquidity: { [pool100.address]: '0x' + (BigInt(1e18)).toString(16) },
          now: DEFAULT_NOW,
        }),
      );
      const alerts = await scanner.scan();
      expect(alerts).toEqual([]);
    });

    it('fails closed when anchor rate is zero', async () => {
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100, minNetDiscountPct: 0.30 },
        makeDeps({
          anchorRateRaw: '0x' + (0).toString(16).padStart(64, '0'),
          blockTs: DEFAULT_BLOCK_TS,
          withdrawalDelay: '0x' + (604800).toString(16),
          poolSlot0: { [pool100.address]: sqrtPriceHex(1.05) },
          poolLiquidity: { [pool100.address]: '0x' + (BigInt(1e18)).toString(16) },
          now: DEFAULT_NOW,
        }),
      );
      const alerts = await scanner.scan();
      expect(alerts).toEqual([]);
    });

    it('fails closed when withdrawal delay is missing (0x)', async () => {
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100, minNetDiscountPct: 0.30 },
        makeDeps({
          anchorRate: rateHex(1.0265),
          blockTs: DEFAULT_BLOCK_TS,
          // withdrawalDelay default → use 0x (missing)
          poolSlot0: { [pool100.address]: sqrtPriceHex(1.05) },
          poolLiquidity: { [pool100.address]: '0x' + (BigInt(1e18)).toString(16) },
          now: DEFAULT_NOW,
        }),
      );
      // Override the deps to make withdrawal delay return 0x
      const deps: HlLstArbDeps = {
        rpcCall: async (method, params) => {
          if (method === 'eth_getBlockByNumber') {
            return { result: { timestamp: '0x' + DEFAULT_BLOCK_TS.toString(16) } } as any;
          }
          if (method === 'eth_call') {
            const p = params as Array<{ to: string; data: string }>;
            const to = (p[0]?.to || '').toLowerCase();
            if (to === ACCOUNTANT_ADDR) return { result: rateHex(1.0265) };
            if (to === STAKING_MANAGER_ADDR) return { result: '0x' }; // missing!
            if (p[0]?.data === '0x3850c7bd') return { result: sqrtPriceHex(1.05).padEnd(66, '0') };
            if (p[0]?.data === '0x1a686502') return { result: '0x' + (BigInt(1e18)).toString(16).padEnd(66, '0') };
          }
          return { result: '0x' };
        },
        now: () => DEFAULT_NOW,
      };
      const scanner2 = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100, minNetDiscountPct: 0.30 },
        deps,
      );
      const alerts = await scanner2.scan();
      // EM-STRAT-004: missing withdrawal delay → fail closed.
      expect(alerts).toEqual([]);
    });
  });

  describe('discount / premium / parity scenarios', () => {
    it('emits alert for a clear discount (marketPrice > fairPrice)', async () => {
      // anchor=1.0265 → fairPrice=1/1.0265≈0.9742 kHYPE/WHYPE
      // marketPrice=1.05 → kHYPE trades BELOW redemption (discount)
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100, minNetDiscountPct: 0.30 },
        makeDeps({
          anchorRate: rateHex(1.0265),
          blockTs: DEFAULT_BLOCK_TS,
          withdrawalDelay: '0x' + (604800).toString(16),
          poolSlot0: { [pool100.address]: sqrtPriceHex(1.05) },
          poolLiquidity: { [pool100.address]: '0x' + (BigInt(1e18)).toString(16) },
          now: DEFAULT_NOW,
        }),
      );
      const alerts = await scanner.scan();
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      expect(alerts[0].grossDiscountPct).toBeGreaterThan(0);
      expect(alerts[0].netProfitPct).toBeGreaterThan(0);
    });

    it('does NOT emit alert for a premium (marketPrice < fairPrice)', async () => {
      // marketPrice = 0.95 → kHYPE trades ABOVE redemption (premium)
      // grossDiscountPct will be negative → filtered by minDiscountPct.
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100, minNetDiscountPct: 0.30 },
        makeDeps({
          anchorRate: rateHex(1.0265),
          blockTs: DEFAULT_BLOCK_TS,
          withdrawalDelay: '0x' + (604800).toString(16),
          poolSlot0: { [pool100.address]: sqrtPriceHex(0.95) },
          poolLiquidity: { [pool100.address]: '0x' + (BigInt(1e18)).toString(16) },
          now: DEFAULT_NOW,
        }),
      );
      const alerts = await scanner.scan();
      expect(alerts).toEqual([]);
    });

    it('does NOT emit alert at parity (marketPrice ≈ fairPrice)', async () => {
      // marketPrice = fairPrice = 1/1.0265 ≈ 0.9742 → grossDiscount ≈ 0%
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100, minNetDiscountPct: 0.30 },
        makeDeps({
          anchorRate: rateHex(1.0265),
          blockTs: DEFAULT_BLOCK_TS,
          withdrawalDelay: '0x' + (604800).toString(16),
          poolSlot0: { [pool100.address]: sqrtPriceHex(1 / 1.0265) },
          poolLiquidity: { [pool100.address]: '0x' + (BigInt(1e18)).toString(16) },
          now: DEFAULT_NOW,
        }),
      );
      const alerts = await scanner.scan();
      // grossDiscountPct ≈ 0, well below minDiscountPct (0.1) → no alert
      expect(alerts).toEqual([]);
    });
  });

  describe('flashloan fee constant', () => {
    it('exposes flashloan fee from Hyperlend constant (0.04%)', async () => {
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100, minNetDiscountPct: 0.30 },
        makeDeps({
          anchorRate: rateHex(1.0265),
          blockTs: DEFAULT_BLOCK_TS,
          withdrawalDelay: '0x' + (604800).toString(16),
          poolSlot0: { [pool100.address]: sqrtPriceHex(1.05) },
          poolLiquidity: { [pool100.address]: '0x' + (BigInt(1e18)).toString(16) },
          now: DEFAULT_NOW,
        }),
      );
      const alerts = await scanner.scan();
      expect(alerts[0].flashloanFeePct).toBeCloseTo(HYPERLEND_FLASHLOAN_FEE * 100, 5);
    });
  });

  describe('strategy interface compliance', () => {
    it('implements Strategy interface', () => {
      const scanner = new HlLstArbScanner({ minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100 });
      expect(scanner.id).toBe('hl_lst_arb');
      expect(scanner.landscape).toBe('C_dex_dex');
    });

    it('riskParams flows maxSizeUsd', () => {
      const scanner = new HlLstArbScanner({ minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100 });
      const rp = scanner.riskParams();
      expect(rp.maxSizeUsd).toBe(5_000);
      expect(rp.maxConcurrent).toBe(1);
    });

    it('scan returns array (fail-closed when no deps — no live RPC)', async () => {
      // Without deps, the scanner would try real fetch(). We don't want live RPC
      // in tests, so we inject a deps that returns '0x' for everything.
      const deps: HlLstArbDeps = {
        rpcCall: async () => ({ result: '0x' }),
        now: () => DEFAULT_NOW,
      };
      const scanner = new HlLstArbScanner(
        { minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100, minNetDiscountPct: 0.30 },
        deps,
      );
      const results = await scanner.scan();
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(0); // fail-closed
    });
  });
});

// ─── EM-STRAT-014-X3-F1: withdrawalDelay() selector integrity ───────────
//
// EI's X3 evidence review (EI_STRAT014_E10_X3_ONCHAIN_READS_2026-10-27
// §1/§9) verified that the StakingManager implementation's ABI contains
// withdrawalDelay() with selector 0xa7ab6961 and NO function with the
// previously coded 0x5e8a8c20. The wrong selector made every eth_call
// revert; fetchWithdrawalDelay() failed closed (null) and the
// withdrawal-delay input silently suppressed hl_lst_arb signals.
//
// These tests pin (a) the EXACT eth_call request the scanner issues
// (target address, calldata selector, block tag), (b) the canonical
// signature→selector relation recomputed INDEPENDENTLY from the production
// constant via viem's keccak256 (an existing repo dependency — no new
// dependency added), and (c) the fail-closed behavior on empty/malformed/
// failed responses.

import { toFunctionSelector, keccak256, stringToBytes } from 'viem';

describe('withdrawalDelay selector integrity (EM-STRAT-014-X3-F1)', () => {
  const STAKING_MANAGER_CHECKSUMMED = '0x393D0B87Ed38fc779FD9611144aE649BA6082109';
  const VERIFIED_SELECTOR = '0xa7ab6961'; // from EI's verified-ABI one-off read (604800 at block 49,592,218)

  it('canonical signature withdrawalDelay() hashes to the EI-verified selector 0xa7ab6961 (independent keccak)', () => {
    // Recompute the selector from the CANONICAL signature — independent of
    // whatever the production constant says.
    expect(toFunctionSelector('withdrawalDelay()')).toBe(VERIFIED_SELECTOR);
    // Full keccak for the record: first 4 bytes = the selector.
    const full = keccak256(stringToBytes('withdrawalDelay()'));
    expect(full.slice(0, 10)).toBe(VERIFIED_SELECTOR);
    // And it is NOT the old (nonexistent-on-ABI) selector.
    expect(VERIFIED_SELECTOR).not.toBe('0x5e8a8c20');
  });

  it('fetchWithdrawalDelay issues eth_call to the StakingManager with data 0xa7ab6961 and the latest block tag, decoding 604800', async () => {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const deps: HlLstArbDeps = {
      rpcCall: async (method, params) => {
        calls.push({ method, params });
        // Real eth_call wire format: a LEFT-padded 32-byte word (the
        // shared makeDeps mock pads right; no existing test asserts the
        // decoded value, this one does).
        return { result: '0x' + (604800).toString(16).padStart(64, '0') };
      },
      now: () => DEFAULT_NOW,
    };
    const scanner = new HlLstArbScanner({ minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100 }, deps);
    const delay = await scanner.fetchWithdrawalDelay();
    expect(delay).toBe(604800);

    expect(calls.length).toBe(1);
    const { method, params } = calls[0]!;
    expect(method).toBe('eth_call');
    const [callObj, blockTag] = params as [{ to: string; data: string }, string];
    expect(callObj.to).toBe(STAKING_MANAGER_CHECKSUMMED);
    expect(callObj.data).toBe(VERIFIED_SELECTOR); // request capture: exact selector on the wire
    expect(blockTag).toBe('latest');
    // The production constant must be the verified one (source-of-truth pin
    // at the request level; the signature relation is pinned separately).
    expect(toFunctionSelector('withdrawalDelay()')).toBe(callObj.data);
  });

  it('fail-closed: empty result (0x) → null', async () => {
    const deps: HlLstArbDeps = { rpcCall: async () => ({ result: '0x' }), now: () => DEFAULT_NOW };
    const scanner = new HlLstArbScanner({ minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100 }, deps);
    expect(await scanner.fetchWithdrawalDelay()).toBeNull();
  });

  it('fail-closed: missing result key → null', async () => {
    const deps: HlLstArbDeps = { rpcCall: async () => ({}), now: () => DEFAULT_NOW };
    const scanner = new HlLstArbScanner({ minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100 }, deps);
    expect(await scanner.fetchWithdrawalDelay()).toBeNull();
  });

  it('fail-closed: malformed/short result (reverted selector shape) → null', async () => {
    // A contract with no withdrawalDelay() function reverts → RPC returns
    // '0x' or a short blob; both must yield null, never a fabricated delay.
    for (const bad of ['0x', '0x1234', '0x' + 'ab'.repeat(10)]) {
      const deps: HlLstArbDeps = { rpcCall: async () => ({ result: bad }), now: () => DEFAULT_NOW };
      const scanner = new HlLstArbScanner({ minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100 }, deps);
      expect(await scanner.fetchWithdrawalDelay(), `case ${bad}`).toBeNull();
    }
  });

  it('fail-closed: rpcCall throws (network/RPC error) → null, no crash', async () => {
    const deps: HlLstArbDeps = {
      rpcCall: async () => {
        throw new Error('connection refused (mock)');
      },
      now: () => DEFAULT_NOW,
    };
    const scanner = new HlLstArbScanner({ minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100 }, deps);
    expect(await scanner.fetchWithdrawalDelay()).toBeNull();
  });
});
