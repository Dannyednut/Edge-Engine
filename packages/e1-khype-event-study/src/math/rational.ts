/**
 * EM-STRAT-014-E1 — exact rational arithmetic with canonical serialization.
 *
 * Every measured quantity in the study (discount d, fees, impact, net,
 * events-per-week) is carried as an exact ratio of BigInts. Exactness is
 * what makes threshold comparisons (event thresholds, independence band,
 * pass rule) free of rounding-direction ambiguity, and it is what makes the
 * canonical output byte-identical across fresh runs (E1-T9).
 *
 * Canonical serialization rules (declared, deterministic):
 *   - toDecimalString(r, fracDigits): fixed-point decimal with fracDigits
 *     fraction digits, TRUNCATED toward zero (never rounded), '-' prefix
 *     only when the truncated magnitude is non-zero. Truncation (not
 *     round-half-even) is chosen because it has no tie-breaking branch.
 *   - toExactFractionString(r): "num/den" with den > 0, fully exact.
 */

import { gcd } from './bigint-math.js';

export interface Rational {
  /** Numerator (any sign). */
  readonly num: bigint;
  /** Denominator (strictly positive). */
  readonly den: bigint;
}

/** Construct a normalized rational (den > 0, gcd reduced). */
export function rat(num: bigint, den: bigint): Rational {
  if (den === 0n) throw new Error('rat:zero-denominator');
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den);
  if (g > 1n) {
    return { num: num / g, den: den / g };
  }
  return { num, den };
}

export function ratInt(n: bigint): Rational {
  return rat(n, 1n);
}

export const RAT_ZERO: Rational = { num: 0n, den: 1n };

export function ratAdd(a: Rational, b: Rational): Rational {
  return rat(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function ratSub(a: Rational, b: Rational): Rational {
  return rat(a.num * b.den - b.num * a.den, a.den * b.den);
}

export function ratMul(a: Rational, b: Rational): Rational {
  return rat(a.num * b.num, a.den * b.den);
}

export function ratNeg(a: Rational): Rational {
  return { num: -a.num, den: a.den };
}

export function ratAbs(a: Rational): Rational {
  return { num: a.num < 0n ? -a.num : a.num, den: a.den };
}

/** -1 | 0 | +1 */
export function ratCmp(a: Rational, b: Rational): number {
  const l = a.num * b.den;
  const r = b.num * a.den;
  return l < r ? -1 : l > r ? 1 : 0;
}

export function ratIsPositive(a: Rational): boolean {
  return a.num > 0n;
}

export function ratIsNegative(a: Rational): boolean {
  return a.num < 0n;
}

export function ratIsZero(a: Rational): boolean {
  return a.num === 0n;
}

const DECIMAL_STRING_RE = /^-?\d+(\.\d+)?$/;

/**
 * Parse an exact decimal string ("0.04", "10000", "-1.5") into a Rational.
 * Scientific notation, empty strings, and any other form are rejected —
 * parseFloat is NEVER used (float round-trip would break exactness).
 */
export function ratFromDecimalString(s: string): Rational {
  if (typeof s !== 'string' || !DECIMAL_STRING_RE.test(s)) {
    throw new Error(`ratFromDecimalString:invalid-decimal-string:${JSON.stringify(s)}`);
  }
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const dot = body.indexOf('.');
  const intPart = dot === -1 ? body : body.slice(0, dot);
  const fracPart = dot === -1 ? '' : body.slice(dot + 1);
  const num = BigInt((intPart.length ? intPart : '0') + fracPart || '0');
  const scale = 10n ** BigInt(fracPart.length);
  return rat(neg ? -num : num, scale);
}

/** Fixed-point canonical decimal string, truncated toward zero. */
export function ratToDecimalString(r: Rational, fracDigits: number): string {
  if (!Number.isInteger(fracDigits) || fracDigits < 0 || fracDigits > 36) {
    throw new Error('ratToDecimalString:bad-frac-digits');
  }
  const scale = 10n ** BigInt(fracDigits);
  const scaled = (r.num < 0n ? -r.num : r.num) * scale / r.den; // truncation
  const sign = r.num < 0n && scaled !== 0n ? '-' : '';
  const s = scaled.toString();
  if (fracDigits === 0) return sign + s;
  if (s.length <= fracDigits) {
    return `${sign}0.${'0'.repeat(fracDigits - s.length)}${s}`;
  }
  return `${sign}${s.slice(0, s.length - fracDigits)}.${s.slice(s.length - fracDigits)}`;
}

/** Fully exact "num/den" form (audit lineage — survives every serialization). */
export function ratToExactFractionString(r: Rational): string {
  return `${r.num}/${r.den}`;
}
