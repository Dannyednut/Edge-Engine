/**
 * EM-STRAT-014-E1 — convention, rational, and canonicalization units.
 *
 * Pins the discount convention (code convention, d = marketPrice x
 * anchorRate - 1, positive = kHYPE below redemption value), the
 * orientation trap, exact-decimal parsing, canonical decimal truncation,
 * and the canonical-JSON discipline (no floats, sorted keys).
 */

import { describe, expect, it } from 'vitest';
import { isqrt, mulDivCeil, mulDivFloor, floorDiv } from '../src/math/bigint-math.js';
import {
  rat,
  ratAbs,
  ratAdd,
  ratCmp,
  ratFromDecimalString,
  ratMul,
  ratSub,
  ratToDecimalString,
  ratToExactFractionString,
} from '../src/math/rational.js';
import { canonicalJsonString } from '../src/study/canonical.js';
import { discountPct } from '../src/study/discount-series.js';
import { Q192 } from '../src/v3/tick-math.js';
import { expectRatNear } from './_helpers.js';

describe('BigInt primitives', () => {
  it('mulDivFloor / mulDivCeil are exact at boundaries', () => {
    expect(mulDivFloor(10n, 20n, 7n)).toBe(28n); // 200/7 = 28.57
    expect(mulDivCeil(10n, 20n, 7n)).toBe(29n);
    expect(mulDivFloor(0n, 123n, 5n)).toBe(0n);
    expect(mulDivCeil(5n, 1n, 5n)).toBe(1n);
    expect(() => mulDivFloor(1n, 1n, 0n)).toThrow();
    expect(() => mulDivCeil(-1n, 1n, 5n)).toThrow();
  });

  it('floorDiv floors negatives correctly', () => {
    expect(floorDiv(7n, 2n)).toBe(3n);
    expect(floorDiv(-7n, 2n)).toBe(-4n);
    expect(floorDiv(-6n, 2n)).toBe(-3n);
  });

  it('isqrt is the exact floor square root (incl. huge values)', () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(1n)).toBe(1n);
    expect(isqrt(8n)).toBe(2n);
    expect(isqrt(9n)).toBe(3n);
    expect(isqrt(Q192)).toBe(1n << 96n); // 2^192 -> 2^96
    const big = 123456789012345678901234567890n;
    const r = isqrt(big);
    expect(r * r <= big).toBe(true);
    expect((r + 1n) * (r + 1n) > big).toBe(true);
  });
});

describe('rational arithmetic + canonical strings', () => {
  it('parses exact decimals and rejects everything else', () => {
    expect(ratFromDecimalString('0.04')).toEqual(rat(1n, 25n));
    expect(ratFromDecimalString('10000')).toEqual(rat(10000n, 1n));
    expect(ratFromDecimalString('-1.5')).toEqual(rat(-3n, 2n));
    expect(() => ratFromDecimalString('1e-4')).toThrow();
    expect(() => ratFromDecimalString('')).toThrow();
    expect(() => ratFromDecimalString('abc')).toThrow();
    expect(() => ratFromDecimalString('0.04x')).toThrow();
  });

  it('decimal truncation is toward zero, sign-aware, deterministic', () => {
    expect(ratToDecimalString(rat(3n, 500n), 12)).toBe('0.006000000000');
    expect(ratToDecimalString(rat(-3n, 500n), 12)).toBe('-0.006000000000');
    expect(ratToDecimalString(rat(1n, 7n), 12)).toBe('0.142857142857');
    expect(ratToDecimalString(rat(-1n, 10n ** 14n), 12)).toBe('0.000000000000'); // truncates to zero: no '-0'
    expect(ratToDecimalString(rat(1n, 2n), 0)).toBe('0');
    expect(ratToDecimalString(rat(3n, 2n), 0)).toBe('1');
  });

  it('exact fraction strings carry full precision', () => {
    expect(ratToExactFractionString(ratAdd(rat(1n, 3n), rat(1n, 6n)))).toBe('1/2');
    expect(ratToExactFractionString(ratFromDecimalString('0.04'))).toBe('1/25');
  });

  it('ratCmp is exact across different denominators', () => {
    expect(ratCmp(rat(1n, 3n), rat(333333333333333333n, 10n ** 18n))).toBe(1);
    expect(ratCmp(ratAbs(rat(-2n, 5n)), rat(4n, 10n))).toBe(0);
  });
});

describe('discount convention (code convention, pinned)', () => {
  it('E1 conventions: d = marketPrice * anchorRate - 1 with marketPrice = kHYPE per WHYPE', () => {
    // anchorRate = 1.0 (raw 1e18), market price 1.006 kHYPE per WHYPE:
    // sqrtPriceX96 = floor(isqrt(1.006 * 2^192)) => d_pct ~= +0.6 (discount)
    const S = isqrt((1006n * Q192) / 1000n);
    const d = ratToExactFractionString(discountPct(1_000_000_000_000_000_000n, S));
    expectRatNear(d, '0.6', '0.000000000001'); // d_pct within 1e-12 of +0.6%
  });

  it('the orientation trap: inverting the price but NOT the anchor yields a DIFFERENT quantity', () => {
    // anchorRate = 1.05, kHYPE at ~0.6% discount: fair = 1/1.05 kHYPE per
    // WHYPE, market = 1.006/1.05. Code-convention d_pct ~= +0.6.
    const a = 1050n;
    const S = isqrt((1006n * Q192) / a);
    const dCode = discountPct(1_050_000_000_000_000_000n, S);
    expect(ratCmp(dCode, rat(599n, 1000n))).toBe(1); // > 0.599%
    expect(ratCmp(dCode, rat(601n, 1000n))).toBe(-1); // < 0.601%
    // The WRONG mix (WHYPE-per-kHYPE price x non-inverted anchor) would
    // evaluate ~ +5.1% at the same fair-anchored market state and would NOT
    // vanish at fair value: 1.05 * 1.05 - 1 = 0.1025 != 0. Mixing
    // orientations silently produces a different quantity — this is why
    // the manifest convention strings are compared EXACTLY.
    const mixedAtFair = ratMul(rat(105n, 100n), rat(105n, 100n));
    expect(ratCmp(mixedAtFair, rat(1n, 1n))).toBe(1);
    expect(ratToDecimalString(ratSub(mixedAtFair, rat(1n, 1n)), 12)).toBe('0.102500000000');
  });

  it('sign semantics: d>0 discount, d<0 premium, d=0 fair', () => {
    const S = Q192 / (1n << 96n); // price exactly 1.0 with anchor 1.0 => fair
    expect(ratToDecimalString(discountPct(1_000_000_000_000_000_000n, S), 12)).toBe('0.000000000000');
    const Sprem = isqrt((994n * Q192) / 1000n); // price 0.994 => premium
    expectRatNear(
      ratToExactFractionString(discountPct(1_000_000_000_000_000_000n, Sprem)),
      '-0.6',
      '0.000000000001',
    );
  });
});

describe('canonical JSON discipline', () => {
  it('sorts keys, omits undefined, and is byte-stable', () => {
    const a = canonicalJsonString({ b: 1, a: [2, { z: null, y: 'x' }], c: undefined });
    const b = canonicalJsonString({ a: [2, { y: 'x', z: null }], b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":[2,{"y":"x","z":null}],"b":1}');
  });

  it('refuses floats and BigInts at the boundary', () => {
    expect(() => canonicalJsonString({ x: 0.5 })).toThrow(/non-safe-integer/);
    expect(() => canonicalJsonString({ x: 2n })).toThrow(/bigint/);
  });
});
