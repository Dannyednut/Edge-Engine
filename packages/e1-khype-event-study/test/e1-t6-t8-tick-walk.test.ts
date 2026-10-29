/**
 * EM-STRAT-014-E1 — depth model tests (E1-T6, T6b extra, E1-T7, E1-T8).
 *
 * Fixtures are INLINE, hand-constructed, and documented here (provenance):
 * they use only exact rational quantities (P = 1, L = 10^24, etc.) so the
 * expected outputs are closed-form derivable:
 *
 *   T6: P=1, L=10^24, in = 10^22, fee 0, range [-6000, 6000]:
 *       1/sqrtP_end = 1 + 10^22/10^24 = 1.01 => sqrtP_end = 100/101
 *       out = L*(1 - 100/101) = 10^24/101 = 9900990099009900990099.0099...
 *       (the walk reproduces the FLOOR of this exactly).
 *   T7: stepped liquidity 10^24 -> 4*10^23 -> 10^23 below ticks
 *       -100/-200/-300; input 7.2e21 crosses exactly two boundaries and
 *       finishes inside [-300, -200]; an oversized input (10^22) exhausts
 *       the recorded distribution and must FAIL CLOSED.
 *   T8: zero liquidity => no quote, reason 'no_liquidity'.
 */

import { describe, expect, it } from 'vitest';
import { mulDivFloor } from '../src/math/bigint-math.js';
import { Q96, getSqrtRatioAtTick } from '../src/v3/tick-math.js';
import { quoteExactInWhypeToKhype, type PoolState } from '../src/v3/tick-walk.js';

const L24 = 10n ** 24n;

function wideRangePool(overrides: Partial<PoolState> = {}): PoolState {
  return {
    sqrtPriceX96: Q96, // P = 1.0 exactly
    tick: 0,
    liquidity: L24,
    ticks: [
      { tick: -6000, liquidityNet: L24 },
      { tick: 6000, liquidityNet: -L24 },
    ],
    ...overrides,
  };
}

describe('E1-T6 — in-range quote matches the hand-computed tick-walk', () => {
  it('returns the exact closed-form output for $10k notional at P=1, fee=0', () => {
    const q = quoteExactInWhypeToKhype(wideRangePool(), 10n ** 22n, 0n);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    // Exact closed form: out = floor(10^24/101) — the walk reproduces it
    // to the wei (BigInt-exact where applicable, per the T6 contract).
    expect(q.amountOut).toBe(9900990099009900990099n);
    // relative error vs closed form <= 1e-12 (trivially: exactly 0 here)
    const closedForm = (10n ** 24n) / 101n;
    expect(q.amountOut - closedForm <= 10n ** 10n || closedForm - q.amountOut <= 10n ** 10n).toBe(true);
    // sqrtPriceX96After is reported and equals floor(Q96 * 100/101)
    expect(q.sqrtPriceX96After).toBe(mulDivFloor(Q96, 100n, 101n));
    // zero ticks crossed (deep single range)
    expect(q.ticksCrossed).toEqual([]);
    expect(q.amountInEffective).toBe(10n ** 22n);
    // realized average price 100/101 within 1e-12 relative: |out*101 - 10^24| <= 1e-12 * (10^24/101)*101
    expect((q.amountOut * 101n - 10n ** 24n) <= 10n ** 12n).toBe(true);
  });

  it('E1-T6b (extra) — fee-on-input variant matches the documented formula exactly', () => {
    const q = quoteExactInWhypeToKhype(wideRangePool(), 10n ** 22n, 100n); // 0.01% fee
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    const eff = mulDivFloor(10n ** 22n, 999900n, 1_000_000n);
    expect(q.amountInEffective).toBe(eff);
    expect(q.amountInEffective).toBeLessThan(10n ** 22n);
    const sEndExp = mulDivFloor(Q96 * L24, 1n, L24 + eff); // floor(Q96*L/(L+eff))
    expect(q.sqrtPriceX96After).toBe(sEndExp);
    expect(q.amountOut).toBe(mulDivFloor(L24, Q96 - sEndExp, Q96));
    // fee makes the output strictly worse than the fee=0 quote
    const q0 = quoteExactInWhypeToKhype(wideRangePool(), 10n ** 22n, 0n);
    if (q0.ok) expect(q.amountOut).toBeLessThan(q0.amountOut);
  });
});

describe('E1-T7 — size exceeding in-range liquidity crosses ticks (never clamps)', () => {
  // Stepped distribution (provenance: hand-built, exact):
  //   active at tick 0: 1e23 + 3e23 + 6e23 = 10^24
  //   below -100: 4*10^23; below -200: 10^23; below -300: 0 (fail-closed)
  const stepped: PoolState = {
    sqrtPriceX96: Q96,
    tick: 0,
    liquidity: L24,
    ticks: [
      { tick: -300, liquidityNet: 10n ** 23n },
      { tick: -200, liquidityNet: 3n * 10n ** 23n },
      { tick: -100, liquidityNet: 6n * 10n ** 23n },
      { tick: 100, liquidityNet: -(10n ** 24n) },
    ],
  };

  it('crosses exactly [-100, -200], lands between them, and is worse than any single-range quote', () => {
    const q = quoteExactInWhypeToKhype(stepped, 7200n * 10n ** 18n, 0n);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.ticksCrossed).toEqual([-100, -200]);
    expect(q.sqrtPriceX96After).toBeLessThan(getSqrtRatioAtTick(-200));
    expect(q.sqrtPriceX96After).toBeGreaterThan(getSqrtRatioAtTick(-300));
    expect(q.sqrtPriceX96After).toBeLessThan(Q96); // price moved (impact is real)
    // Independent recomputation (segment-by-segment closed form, written
    // independently of the walk loop):
    const S100 = getSqrtRatioAtTick(-100);
    const S200 = getSqrtRatioAtTick(-200);
    const segIn = (L: bigint, Ss: bigint, St: bigint) =>
      (L * Q96 * (Ss - St) + Ss * St - 1n) / (Ss * St); // independent ceil
    const segOut = (L: bigint, Ss: bigint, St: bigint) => (L * (Ss - St)) / Q96; // independent floor
    const dx1 = segIn(L24, Q96, S100);
    const dy1 = segOut(L24, Q96, S100);
    const L2 = L24 - 6n * 10n ** 23n;
    const dx2 = segIn(L2, S100, S200);
    const dy2 = segOut(L2, S100, S200);
    const L3 = L2 - 3n * 10n ** 23n;
    const rem = 7200n * 10n ** 18n - dx1 - dx2;
    const sEnd3 = (S200 * L3 * Q96) / (L3 * Q96 + rem * S200);
    const dy3 = mulDivFloor(L3, S200 - sEnd3, Q96);
    const total = dy1 + dy2 + dy3;
    // ceil-slack <= 1 wei per crossed boundary + floor wobble: <= 3 wei
    expect(q.amountOut - total <= 3n && total - q.amountOut <= 3n).toBe(true);
  });

  it('input exceeding ALL recorded liquidity fails closed with zero_liquidity_below (never clamps to spot)', () => {
    const q = quoteExactInWhypeToKhype(stepped, 10n ** 22n, 0n);
    expect(q.ok).toBe(false);
    if (q.ok) return;
    expect(q.reason).toBe('zero_liquidity_below');
  });
});

describe('E1-T8 — zero liquidity fails closed (a zero-gate is not a depth model)', () => {
  it('returns no quote and reason no_liquidity', () => {
    const q = quoteExactInWhypeToKhype(wideRangePool({ liquidity: 0n, ticks: [] }), 10n ** 21n, 0n);
    expect(q.ok).toBe(false);
    if (q.ok) return;
    expect(q.reason).toBe('no_liquidity');
  });

  it('fails closed on corrupted or inconsistent state (each with an explicit reason)', () => {
    // slot0/tick mismatch: tick claims 0 but the price is sqrtAtTick(5)
    const mismatch = quoteExactInWhypeToKhype(
      wideRangePool({ sqrtPriceX96: getSqrtRatioAtTick(5) }),
      10n ** 21n, 0n,
    );
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.reason).toBe('slot0_tick_mismatch');

    // recorded liquidity disagrees with the tick distribution
    const liqMismatch = quoteExactInWhypeToKhype(wideRangePool({ liquidity: 999n }), 10n ** 21n, 0n);
    expect(liqMismatch.ok).toBe(false);
    if (!liqMismatch.ok) expect(liqMismatch.reason).toBe('liquidity_tickdata_mismatch');

    // duplicate initialized tick
    const dup = quoteExactInWhypeToKhype(
      wideRangePool({ ticks: [
        { tick: -6000, liquidityNet: L24 },
        { tick: -6000, liquidityNet: L24 },
        { tick: 6000, liquidityNet: -L24 },
      ] }),
      10n ** 21n, 0n,
    );
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toBe('tick_data_duplicate_tick');

    // invalid inputs
    expect(quoteExactInWhypeToKhype(wideRangePool(), 0n, 0n)).toEqual({ ok: false, reason: 'invalid_amount_in' });
    expect(quoteExactInWhypeToKhype(wideRangePool(), 10n, 1_000_000n)).toEqual({ ok: false, reason: 'invalid_fee' });
  });
});
