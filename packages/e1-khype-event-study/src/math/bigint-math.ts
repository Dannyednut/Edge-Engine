/**
 * EM-STRAT-014-E1 — exact BigInt arithmetic primitives.
 *
 * EVERY number that enters a study artifact flows through integer math.
 * There is deliberately NO floating-point anywhere in the computation
 * pipeline: IEEE-754 rounding, float->string formatting, and accumulator
 * order are the classic sources of non-reproducible output (E1-T9), and a
 * study whose bytes can shift between runs cannot be a decision basis.
 *
 * All helpers are pure, total on their declared domain, and assert-fail on
 * domain violations (fail-closed, no silent clamping).
 */

/** a*b/c floored, for a,b >= 0 and c > 0. Exact BigInt arithmetic. */
export function mulDivFloor(a: bigint, b: bigint, c: bigint): bigint {
  if (a < 0n || b < 0n) throw new Error('mulDivFloor:negative-operand');
  if (c <= 0n) throw new Error('mulDivFloor:non-positive-denominator');
  return (a * b) / c;
}

/** a*b/c ceiled, for a,b >= 0 and c > 0. Exact BigInt arithmetic. */
export function mulDivCeil(a: bigint, b: bigint, c: bigint): bigint {
  if (a < 0n || b < 0n) throw new Error('mulDivCeil:negative-operand');
  if (c <= 0n) throw new Error('mulDivCeil:non-positive-denominator');
  const p = a * b;
  const q = p / c;
  return q * c === p ? q : q + 1n;
}

/** floor(a/b) for b > 0 with a of any sign. */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('floorDiv:non-positive-denominator');
  const q = a / b;
  // BigInt '/' truncates toward zero; adjust negatives with a remainder.
  return a % b === 0n || a >= 0n ? q : q - 1n;
}

/** floor(sqrt(n)) for n >= 0. Exact: Newton iteration with final floor correction. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('isqrt:negative');
  if (n < 2n) return n;
  // Initial guess: 2^(ceil(bitLength/2)) — guaranteed >= sqrt(n).
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2) + 1);
  let xNext = (x + n / x) >> 1n;
  while (xNext < x) {
    x = xNext;
    xNext = (x + n / x) >> 1n;
  }
  // x is now <= sqrt(n) but verify exactly (defensive floor correction).
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}

/** Greatest common divisor (both non-negative). */
export function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y > 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}
