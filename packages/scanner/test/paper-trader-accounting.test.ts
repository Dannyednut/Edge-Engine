/**
 * paper-trader-accounting.test.ts — Deterministic tests for the pure
 * accounting functions. No external services, no I/O, no Date.now().
 * All inputs and expected outputs are hardcoded.
 */
import { describe, it, expect } from 'vitest';
import {
  // Constants
  SCAN_INTERVAL_MS,
  ONE_DAY_MS,
  DEFAULT_FUNDING_MATURITY_MS,
  DEFAULT_ADVERSE_DRIFT,
  DEFAULT_EROSION_FACTOR,
  DEFAULT_FEE_BPS,
  // Pure calc functions
  calcSlippage,
  calcFees,
  calcSpreadErosion,
  calcArbNetProfit,
  calcArbGrossProfit,
  calcFundingReversal,
  calcEffectiveFundingSpread,
  calcFundingIncome,
  checkYieldFreshness,
  calcPassiveYield,
  // Capital allocation
  getTotalCapital,
  getAvailableCapital,
  allocateCapital,
  releaseCapital,
  reserveCapital,
  releaseReservedCapital,
  // Trade recording
  recordArbTrade,
  openFundingPosition,
  closeFundingPosition,
  creditPassiveYield,
  // Summary
  getTotalPnl,
  getWinRate,
  getRoi,
  getSummary,
  // Init
  createInitialState,
  // Types
  type AccountingState,
  type ArbTrade,
  type YieldConfig,
  type YieldSource,
} from '../src/lib/paper-trader-accounting.js';

// ─── Helpers ──────────────────────────────────────────────────────────

function makeYieldConfig(overrides: Partial<YieldConfig> = {}): YieldConfig {
  return {
    source: 'hlp',
    apr: 0.30,
    capitalUsd: 5000,
    verified: true,
    verifiedAt: 1000000,
    freshnessMs: ONE_DAY_MS,
    ...overrides,
  };
}

function makeInitialStateWithYields(starting: number = 100_000): AccountingState {
  return createInitialState(starting, {
    hlp: makeYieldConfig({ source: 'hlp', apr: 0.30, capitalUsd: 5000 }),
    khype: makeYieldConfig({
      source: 'khype',
      apr: 0.0193,
      capitalUsd: 10000,
      verifiedAt: 1000000,
    }),
  });
}

// ─── 1. Slippage calculation ──────────────────────────────────────────

describe('calcSlippage', () => {
  it('calculates slippage as fraction of spread, capped', () => {
    // 0.5% spread * 20% fraction = 0.10% slippage — below 0.15% cap
    const r = calcSlippage(5000, 0.5);
    expect(r.slippagePct).toBeCloseTo(0.10, 6);
    expect(r.slippageUsd).toBeCloseTo(5, 6); // 5000 * 0.10 / 100
  });

  it('caps slippage at the cap', () => {
    const r = calcSlippage(5000, 5.0); // 5% spread, 20% = 1.0% — capped at 0.15%
    expect(r.slippagePct).toBe(0.15);
    expect(r.slippageUsd).toBeCloseTo(7.5, 6); // 5000 * 0.15 / 100
  });

  it('returns zero slippage for zero spread', () => {
    const r = calcSlippage(5000, 0);
    expect(r.slippagePct).toBe(0);
    expect(r.slippageUsd).toBe(0);
  });

  it('handles custom fraction and cap', () => {
    const r = calcSlippage(10000, 2.0, 0.10, 0.50); // 10% of 2% = 0.2%, cap 0.5%
    expect(r.slippagePct).toBeCloseTo(0.2, 6);
    expect(r.slippageUsd).toBeCloseTo(20, 6);
  });
});

// ─── 2. Fees calculation ──────────────────────────────────────────────

describe('calcFees', () => {
  it('calculates fees from basis points', () => {
    expect(calcFees(5000, 10)).toBeCloseTo(5, 6); // 0.1% of $5000
    expect(calcFees(10000, 30)).toBeCloseTo(30, 6); // 0.3% of $10000
  });

  it('uses default 10 bps (0.1%)', () => {
    expect(calcFees(5000)).toBeCloseTo(5, 6);
  });

  it('returns zero for zero notional', () => {
    expect(calcFees(0)).toBe(0);
  });
});

// ─── 3. Spread erosion ────────────────────────────────────────────────

describe('calcSpreadErosion', () => {
  it('reduces spread by erosion factor per capture', () => {
    expect(calcSpreadErosion(1.0, 0)).toBeCloseTo(1.0, 6);
    expect(calcSpreadErosion(1.0, 1)).toBeCloseTo(0.7, 6); // 1.0 * 0.7
    expect(calcSpreadErosion(1.0, 2)).toBeCloseTo(0.49, 6); // 1.0 * 0.7^2
    expect(calcSpreadErosion(1.0, 3)).toBeCloseTo(0.343, 6); // 1.0 * 0.7^3
  });

  it('uses custom erosion factor', () => {
    expect(calcSpreadErosion(2.0, 1, 0.5)).toBeCloseTo(1.0, 6);
    expect(calcSpreadErosion(2.0, 3, 0.5)).toBeCloseTo(0.25, 6);
  });

  it('returns original spread for zero captures', () => {
    expect(calcSpreadErosion(1.5, 0)).toBe(1.5);
  });
});

// ─── 4. Arb P&L (gross + net) ────────────────────────────────────────

describe('calcArbGrossProfit + calcArbNetProfit', () => {
  it('calculates gross profit from notional and spread', () => {
    expect(calcArbGrossProfit(5000, 1.0)).toBeCloseTo(50, 6); // 5000 * 1.0 / 100
    expect(calcArbGrossProfit(5000, 0.5)).toBeCloseTo(25, 6);
  });

  it('calculates net profit = gross - slippage - fees', () => {
    const net = calcArbNetProfit(50, 10, 5);
    expect(net).toBe(35);
  });

  it('net profit can be negative (losing trade)', () => {
    const net = calcArbNetProfit(10, 8, 5);
    expect(net).toBe(-3);
  });

  it('net profit is gross when slippage and fees are zero', () => {
    expect(calcArbNetProfit(50, 0, 0)).toBe(50);
  });
});

// ─── 5. Funding reversal (deterministic) ─────────────────────────────

describe('calcFundingReversal', () => {
  it('is deterministic (same asset always produces same result)', () => {
    const a1 = calcFundingReversal('BTC');
    const a2 = calcFundingReversal('BTC');
    expect(a1).toBe(a2);
  });

  it('different assets can produce different results', () => {
    const results = new Set<string>();
    for (const asset of ['BTC', 'ETH', 'SOL', 'AVAX', 'ARB', 'OP', 'MATIC', 'BNB']) {
      results.add(String(calcFundingReversal(asset)));
    }
    // At least 2 different results across 8 assets
    expect(results.size).toBeGreaterThanOrEqual(2);
  });

  it('respects custom reversal rate', () => {
    // With 100% reversal rate, everything reverses
    expect(calcFundingReversal('BTC', 1.0)).toBe(true);
    expect(calcFundingReversal('ETH', 1.0)).toBe(true);
    // With 0% reversal rate, nothing reverses
    expect(calcFundingReversal('BTC', 0.0)).toBe(false);
    expect(calcFundingReversal('ETH', 0.0)).toBe(false);
  });
});

// ─── 6. Effective funding spread ──────────────────────────────────────

describe('calcEffectiveFundingSpread', () => {
  it('applies adverse drift factor', () => {
    const eff = calcEffectiveFundingSpread(0.10, 0.80, false);
    expect(eff).toBeCloseTo(0.08, 6); // 0.10 * 0.80
  });

  it('negates when reversed', () => {
    const eff = calcEffectiveFundingSpread(0.10, 0.80, true);
    expect(eff).toBeCloseTo(-0.08, 6);
  });

  it('returns zero for zero entry spread', () => {
    expect(calcEffectiveFundingSpread(0, 0.80, false)).toBe(0);
    expect(Object.is(calcEffectiveFundingSpread(0, 0.80, true), -0)).toBe(true);
  });
});

// ─── 7. Funding income (with lifecycle) ───────────────────────────────

describe('calcFundingIncome', () => {
  const basePos = {
    id: 'test',
    asset: 'BTC',
    notionalUsd: 5000,
    entryFundingSpread1hPct: 0.10, // 0.10%/h
    openedAt: 0,
    maturityMs: ONE_DAY_MS, // 24h
    adverseDriftFactor: 0.80,
    reversed: false,
    feesUsd: 5,
  };

  it('calculates income for full 24h hold (mature)', () => {
    const r = calcFundingIncome(basePos, ONE_DAY_MS);
    expect(r.isMature).toBe(true);
    expect(r.holdHours).toBeCloseTo(24, 6);
    // Effective spread = 0.10 * 0.80 = 0.08%/h
    // Gross = 5000 * 0.08 / 100 * 24 = 96
    expect(r.grossIncomeUsd).toBeCloseTo(96, 4);
    expect(r.netIncomeUsd).toBeCloseTo(91, 4); // 96 - 5 fees
  });

  it('calculates income for partial hold (premature)', () => {
    const r = calcFundingIncome(basePos, 12 * 60 * 60 * 1000); // 12h
    expect(r.isMature).toBe(false);
    expect(r.holdHours).toBeCloseTo(12, 6);
    // Gross = 5000 * 0.08 / 100 * 12 = 48
    expect(r.grossIncomeUsd).toBeCloseTo(48, 4);
    expect(r.netIncomeUsd).toBeCloseTo(43, 4); // 48 - 5
  });

  it('produces negative income when reversed', () => {
    const reversedPos = { ...basePos, reversed: true };
    const r = calcFundingIncome(reversedPos, ONE_DAY_MS);
    expect(r.isMature).toBe(true);
    // Effective spread = -0.08%/h
    // Gross = 5000 * -0.08 / 100 * 24 = -96
    expect(r.grossIncomeUsd).toBeCloseTo(-96, 4);
    expect(r.netIncomeUsd).toBeCloseTo(-101, 4); // -96 - 5
  });

  it('returns zero income for zero hold time', () => {
    const r = calcFundingIncome(basePos, 0);
    expect(r.grossIncomeUsd).toBe(0);
    expect(r.netIncomeUsd).toBeCloseTo(-5, 4); // 0 - 5 fees
    expect(r.isMature).toBe(false);
  });
});

// ─── 8. Yield freshness ───────────────────────────────────────────────

describe('checkYieldFreshness', () => {
  it('returns verified when within freshness window', () => {
    const config = makeYieldConfig({ verified: true, verifiedAt: 1000, freshnessMs: 10_000 });
    const r = checkYieldFreshness(config, 5000);
    expect(r.isStale).toBe(false);
    expect(r.label).toBe('verified');
  });

  it('returns stale when past freshness window', () => {
    const config = makeYieldConfig({ verified: true, verifiedAt: 1000, freshnessMs: 10_000 });
    const r = checkYieldFreshness(config, 20_000);
    expect(r.isStale).toBe(true);
    expect(r.label).toBe('stale');
  });

  it('returns unverified when not verified', () => {
    const config = makeYieldConfig({ verified: false, verifiedAt: null });
    const r = checkYieldFreshness(config, 5000);
    expect(r.isStale).toBe(true);
    expect(r.label).toBe('unverified');
  });
});

// ─── 9. Passive yield calculation ─────────────────────────────────────

describe('calcPassiveYield', () => {
  it('calculates yield for verified, fresh config', () => {
    const config = makeYieldConfig({
      apr: 0.30, // 30% APR
      capitalUsd: 5000,
      verified: true,
      verifiedAt: 1000,
      freshnessMs: ONE_DAY_MS,
    });
    const r = calcPassiveYield(config, SCAN_INTERVAL_MS, 2000);
    // Daily yield = 5000 * 0.30 / 365 = 4.109589...
    // Per scan (5 min) = 4.109589 * (300000 / 86400000) = 0.014273...
    expect(r.isVerified).toBe(true);
    expect(r.label).toBe('verified');
    expect(r.yieldUsd).toBeCloseTo(0.014273, 4);
  });

  it('returns zero for unverified config (default creditUnverified=false)', () => {
    const config = makeYieldConfig({ verified: false, verifiedAt: null });
    const r = calcPassiveYield(config, SCAN_INTERVAL_MS, 2000);
    expect(r.yieldUsd).toBe(0);
    expect(r.isVerified).toBe(false);
    expect(r.label).toBe('unverified');
  });

  it('returns zero for stale config (default)', () => {
    const config = makeYieldConfig({
      verified: true,
      verifiedAt: 0,
      freshnessMs: 1000,
    });
    const r = calcPassiveYield(config, SCAN_INTERVAL_MS, 100_000);
    expect(r.yieldUsd).toBe(0);
    expect(r.label).toBe('stale');
  });

  it('credits yield for unverified config when creditUnverified=true', () => {
    const config = makeYieldConfig({
      apr: 0.30,
      capitalUsd: 5000,
      verified: false,
      verifiedAt: null,
    });
    const r = calcPassiveYield(config, SCAN_INTERVAL_MS, 2000, true);
    expect(r.yieldUsd).toBeCloseTo(0.014273, 4);
    expect(r.isVerified).toBe(false);
    expect(r.label).toBe('unverified');
  });
});

// ─── 10. Capital allocation ───────────────────────────────────────────

describe('Capital allocation', () => {
  it('initial state has all capital available', () => {
    const state = makeInitialStateWithYields(100_000);
    expect(getAvailableCapital(state)).toBe(100_000);
    expect(getTotalCapital(state)).toBe(100_000);
    expect(state.capital.reserved).toBe(0);
    expect(Object.keys(state.capital.allocated)).toHaveLength(0);
  });

  it('allocateCapital moves capital from available to allocated', () => {
    const state = makeInitialStateWithYields(100_000);
    const s2 = allocateCapital(state, 'hlp', 5000);
    expect(getAvailableCapital(s2)).toBe(95_000);
    expect(s2.capital.allocated['hlp']).toBe(5000);
    expect(getTotalCapital(s2)).toBe(100_000); // total unchanged
  });

  it('allocateCapital throws on insufficient available', () => {
    const state = makeInitialStateWithYields(3000);
    expect(() => allocateCapital(state, 'hlp', 5000)).toThrow('Insufficient');
  });

  it('releaseCapital moves capital back from allocated to available', () => {
    const state = makeInitialStateWithYields(100_000);
    const s2 = allocateCapital(state, 'hlp', 5000);
    const s3 = releaseCapital(s2, 'hlp', 3000);
    expect(getAvailableCapital(s3)).toBe(98_000);
    expect(s3.capital.allocated['hlp']).toBe(2000);
  });

  it('releaseCapital removes the key when fully released', () => {
    const state = makeInitialStateWithYields(100_000);
    const s2 = allocateCapital(state, 'hlp', 5000);
    const s3 = releaseCapital(s2, 'hlp', 5000);
    expect(getAvailableCapital(s3)).toBe(100_000);
    expect(s3.capital.allocated['hlp']).toBeUndefined();
  });

  it('reserveCapital moves capital from available to reserved', () => {
    const state = makeInitialStateWithYields(100_000);
    const s2 = reserveCapital(state, 5000);
    expect(getAvailableCapital(s2)).toBe(95_000);
    expect(s2.capital.reserved).toBe(5000);
    expect(getTotalCapital(s2)).toBe(100_000);
  });

  it('releaseReservedCapital moves capital back from reserved to available', () => {
    const state = makeInitialStateWithYields(100_000);
    const s2 = reserveCapital(state, 5000);
    const s3 = releaseReservedCapital(s2, 5000);
    expect(getAvailableCapital(s3)).toBe(100_000);
    expect(s3.capital.reserved).toBe(0);
  });

  it('prevents double-allocation of the same capital', () => {
    const state = makeInitialStateWithYields(100_000);
    // Allocate $80k to HLP
    const s2 = allocateCapital(state, 'hlp', 80_000);
    expect(getAvailableCapital(s2)).toBe(20_000);
    // Try to allocate $30k to kHYPE — only $20k available
    expect(() => allocateCapital(s2, 'khype', 30_000)).toThrow('Insufficient');
    // Allocate $20k to kHYPE — OK
    const s3 = allocateCapital(s2, 'khype', 20_000);
    expect(getAvailableCapital(s3)).toBe(0);
    expect(s3.capital.allocated['hlp']).toBe(80_000);
    expect(s3.capital.allocated['khype']).toBe(20_000);
  });
});

// ─── 11. Arb trade recording ──────────────────────────────────────────

describe('recordArbTrade', () => {
  it('records a winning trade correctly', () => {
    const state = makeInitialStateWithYields(100_000);
    const trade: ArbTrade = {
      strategy: 'VOOI Price Spread',
      asset: 'BTC',
      notionalUsd: 5000,
      grossProfitUsd: 50,
      slippageUsd: 10,
      feesUsd: 5,
      netProfitUsd: 35,
    };
    const s2 = recordArbTrade(state, trade);
    expect(s2.arbPnl).toBe(35);
    expect(s2.feesTotal).toBe(5);
    expect(s2.totalTrades).toBe(1);
    expect(s2.winningTrades).toBe(1);
    expect(s2.losingTrades).toBe(0);
    expect(getAvailableCapital(s2)).toBe(100_035);
  });

  it('records a losing trade correctly', () => {
    const state = makeInitialStateWithYields(100_000);
    const trade: ArbTrade = {
      strategy: 'VOOI Price Spread',
      asset: 'ETH',
      notionalUsd: 5000,
      grossProfitUsd: 10,
      slippageUsd: 8,
      feesUsd: 5,
      netProfitUsd: -3,
    };
    const s2 = recordArbTrade(state, trade);
    expect(s2.arbPnl).toBe(-3);
    expect(s2.feesTotal).toBe(5);
    expect(s2.totalTrades).toBe(1);
    expect(s2.winningTrades).toBe(0);
    expect(s2.losingTrades).toBe(1);
    expect(getAvailableCapital(s2)).toBe(99_997);
  });

  it('does NOT skip losing trades (win rate is valid)', () => {
    const state = makeInitialStateWithYields(100_000);
    const win: ArbTrade = {
      strategy: 'test', asset: 'A', notionalUsd: 100,
      grossProfitUsd: 10, slippageUsd: 0, feesUsd: 0, netProfitUsd: 10,
    };
    const loss: ArbTrade = {
      strategy: 'test', asset: 'B', notionalUsd: 100,
      grossProfitUsd: 5, slippageUsd: 8, feesUsd: 0, netProfitUsd: -3,
    };
    let s = recordArbTrade(state, win);
    s = recordArbTrade(s, loss);
    expect(getWinRate(s)).toBeCloseTo(0.5, 6); // 1 win / 2 total
  });
});

// ─── 12. Funding position lifecycle ───────────────────────────────────

describe('Funding position lifecycle', () => {
  it('openFundingPosition reserves capital and records position', () => {
    const state = makeInitialStateWithYields(100_000);
    const { state: s2, positionId } = openFundingPosition(
      state,
      {
        asset: 'BTC',
        notionalUsd: 5000,
        entryFundingSpread1hPct: 0.10,
        maturityMs: ONE_DAY_MS,
        adverseDriftFactor: 0.80,
        reversed: false,
        feesUsd: 5,
      },
      1000,
    );
    expect(getAvailableCapital(s2)).toBe(95_000);
    expect(s2.capital.reserved).toBe(5000);
    expect(s2.openFundingPositions).toHaveLength(1);
    expect(s2.openFundingPositions[0].id).toBe(positionId);
    // No P&L credited yet
    expect(s2.fundingPnl).toBe(0);
  });

  it('closeFundingPosition on mature position credits full 24h P&L', () => {
    const state = makeInitialStateWithYields(100_000);
    const { state: s2, positionId } = openFundingPosition(
      state,
      {
        asset: 'BTC',
        notionalUsd: 5000,
        entryFundingSpread1hPct: 0.10,
        maturityMs: ONE_DAY_MS,
        adverseDriftFactor: 0.80,
        reversed: false,
        feesUsd: 5,
      },
      1000,
    );
    const result = closeFundingPosition(s2, positionId, 1000 + ONE_DAY_MS);
    expect(result.isMature).toBe(true);
    expect(result.closeReason).toBe('maturity_reached');
    // Net income = 5000 * 0.08 / 100 * 24 - 5 = 96 - 5 = 91
    expect(result.pnl).toBeCloseTo(91, 4);
    expect(result.state.fundingPnl).toBeCloseTo(91, 4);
    expect(result.state.totalTrades).toBe(1);
    expect(result.state.winningTrades).toBe(1);
    // Capital released back
    expect(getAvailableCapital(result.state)).toBe(100_000 + 91);
    expect(result.state.capital.reserved).toBe(0);
    expect(result.state.openFundingPositions).toHaveLength(0);
  });

  it('closeFundingPosition on premature position credits pro-rata P&L', () => {
    const state = makeInitialStateWithYields(100_000);
    const { state: s2, positionId } = openFundingPosition(
      state,
      {
        asset: 'BTC',
        notionalUsd: 5000,
        entryFundingSpread1hPct: 0.10,
        maturityMs: ONE_DAY_MS,
        adverseDriftFactor: 0.80,
        reversed: false,
        feesUsd: 5,
      },
      1000,
    );
    // Close after 12h (premature)
    const result = closeFundingPosition(s2, positionId, 1000 + 12 * 60 * 60 * 1000);
    expect(result.isMature).toBe(false);
    expect(result.closeReason).toBe('premature_close');
    // Net = 5000 * 0.08 / 100 * 12 - 5 = 48 - 5 = 43
    expect(result.pnl).toBeCloseTo(43, 4);
  });

  it('closeFundingPosition on reversed position credits negative P&L', () => {
    const state = makeInitialStateWithYields(100_000);
    const { state: s2, positionId } = openFundingPosition(
      state,
      {
        asset: 'BTC',
        notionalUsd: 5000,
        entryFundingSpread1hPct: 0.10,
        maturityMs: ONE_DAY_MS,
        adverseDriftFactor: 0.80,
        reversed: true,
        feesUsd: 5,
      },
      1000,
    );
    const result = closeFundingPosition(s2, positionId, 1000 + ONE_DAY_MS);
    expect(result.pnl).toBeLessThan(0);
    expect(result.state.losingTrades).toBe(1);
    expect(result.state.winningTrades).toBe(0);
  });

  it('does NOT credit 24h income instantly on open', () => {
    const state = makeInitialStateWithYields(100_000);
    const { state: s2 } = openFundingPosition(
      state,
      {
        asset: 'BTC',
        notionalUsd: 5000,
        entryFundingSpread1hPct: 0.10,
        maturityMs: ONE_DAY_MS,
        adverseDriftFactor: 0.80,
        reversed: false,
        feesUsd: 5,
      },
      1000,
    );
    // No P&L should be credited at open time
    expect(s2.fundingPnl).toBe(0);
    expect(s2.totalTrades).toBe(0);
  });
});

// ─── 13. Passive yield crediting ──────────────────────────────────────

describe('creditPassiveYield', () => {
  it('credits yield to passiveYieldPnl and available capital', () => {
    const state = makeInitialStateWithYields(100_000);
    const s2 = creditPassiveYield(state, 'hlp', 1.5);
    expect(s2.passiveYieldPnl).toBe(1.5);
    expect(getAvailableCapital(s2)).toBe(100_001.5);
    expect(s2.arbPnl).toBe(0); // does not contaminate arb P&L
    expect(s2.fundingPnl).toBe(0); // does not contaminate funding P&L
  });
});

// ─── 14. Summary and totals ───────────────────────────────────────────

describe('getSummary + totals', () => {
  it('separates P&L by category', () => {
    let state = makeInitialStateWithYields(100_000);
    // Record arb trade
    state = recordArbTrade(state, {
      strategy: 'VOOI', asset: 'BTC', notionalUsd: 5000,
      grossProfitUsd: 50, slippageUsd: 10, feesUsd: 5, netProfitUsd: 35,
    });
    // Credit passive yield
    state = creditPassiveYield(state, 'hlp', 2.0);

    const summary = getSummary(state);
    expect(summary.pnl.arb).toBe(35);
    expect(summary.pnl.passiveYield).toBe(2.0);
    expect(summary.pnl.funding).toBe(0);
    expect(summary.pnl.total).toBe(37);
    expect(summary.fees).toBe(5);
  });

  it('getTotalPnl sums all categories', () => {
    let state = makeInitialStateWithYields(100_000);
    state = recordArbTrade(state, {
      strategy: 'test', asset: 'A', notionalUsd: 100,
      grossProfitUsd: 10, slippageUsd: 0, feesUsd: 0, netProfitUsd: 10,
    });
    state = creditPassiveYield(state, 'hlp', 5);
    expect(getTotalPnl(state)).toBe(15);
  });

  it('getRoi divides total P&L by starting capital', () => {
    let state = makeInitialStateWithYields(100_000);
    state = recordArbTrade(state, {
      strategy: 'test', asset: 'A', notionalUsd: 100,
      grossProfitUsd: 10, slippageUsd: 0, feesUsd: 0, netProfitUsd: 10,
    });
    expect(getRoi(state)).toBeCloseTo(0.0001, 6); // 10 / 100000
  });
});

// ─── 15. State persistence (serialize/deserialize) ────────────────────

describe('State persistence', () => {
  it('state can be serialized and deserialized without loss', () => {
    let state = makeInitialStateWithYields(100_000);
    state = allocateCapital(state, 'hlp', 5000);
    state = recordArbTrade(state, {
      strategy: 'VOOI', asset: 'BTC', notionalUsd: 5000,
      grossProfitUsd: 50, slippageUsd: 10, feesUsd: 5, netProfitUsd: 35,
    });
    const { state: s2 } = openFundingPosition(
      state,
      {
        asset: 'ETH', notionalUsd: 3000, entryFundingSpread1hPct: 0.08,
        maturityMs: ONE_DAY_MS, adverseDriftFactor: 0.80, reversed: false, feesUsd: 3,
      },
      1000,
    );

    // Serialize
    const json = JSON.stringify(s2);
    // Deserialize
    const restored = JSON.parse(json) as AccountingState;

    expect(restored.startingCapital).toBe(s2.startingCapital);
    expect(restored.arbPnl).toBe(s2.arbPnl);
    expect(restored.capital.available).toBe(s2.capital.available);
    expect(restored.capital.allocated).toEqual(s2.capital.allocated);
    expect(restored.capital.reserved).toBe(s2.capital.reserved);
    expect(restored.openFundingPositions).toHaveLength(s2.openFundingPositions.length);
    expect(restored.openFundingPositions[0].asset).toBe(s2.openFundingPositions[0].asset);
  });
});
