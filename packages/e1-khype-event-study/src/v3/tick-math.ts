/**
 * EM-STRAT-014-E1 — local tick math for the V3-style depth model.
 *
 * DECLARED CONVENTION (differs from Uniswap's deployed TickMath by design):
 *   sqrtP(tick) is computed from the EXACT rational 1.0001^tick:
 *     tick >= 0:  sqrtP_q96 = floor(isqrt(2^192 * 10001^tick / 10000^tick))
 *     tick <  0:  sqrtP_q96 = floor(isqrt(2^192 * 10000^(-tick) / 10001^(-tick)))
 *   i.e. the floor of the integer square root of the floored rational. This
 *   is deterministic and auditable; it can differ from the deployed
 *   bit-twiddled TickMath by at most 1 ulp. Before ANY real-data study is
 *   authorized, this convention must be cross-validated against the
 *   pool's actual deployed TickMath (assumption register item). For the
 *   synthetic fixture set of this task it is exact by construction.
 *
 * There is intentionally NO reuse of packages/scanner's view-quoter: the EI
 * specification documents NO view-quoter deployment on chain 999
 * (HyperEVM), so chain-999 depth must come from a local tick-walk. This
 * module (and the whole package) imports nothing from packages/scanner.
 */

import { isqrt } from '../math/bigint-math.js';

export const Q96 = 1n << 96n;
export const Q192 = 1n << 192n;

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

const memo = new Map<number, bigint>();

/** sqrtP(tick) in Q64.96, exact-rational convention (see header). */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`getSqrtRatioAtTick:tick-out-of-range:${String(tick)}`);
  }
  const cached = memo.get(tick);
  if (cached !== undefined) return cached;
  const t = BigInt(tick);
  let value: bigint;
  if (tick >= 0) {
    value = isqrt((Q192 * 10001n ** t) / 10000n ** t);
  } else {
    const inv = -t;
    value = isqrt((Q192 * 10000n ** inv) / 10001n ** inv);
  }
  memo.set(tick, value);
  return value;
}

/** Largest tick whose sqrtP is <= the given Q96 sqrt price. */
export function tickFromSqrtPrice(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 <= 0n) throw new Error('tickFromSqrtPrice:non-positive-price');
  let lo = MIN_TICK;
  let hi = MAX_TICK;
  if (sqrtPriceX96 < getSqrtRatioAtTick(MIN_TICK)) {
    throw new Error('tickFromSqrtPrice:below-min-sqrt');
  }
  if (sqrtPriceX96 >= getSqrtRatioAtTick(MAX_TICK)) {
    throw new Error('tickFromSqrtPrice:at-or-above-max-sqrt');
  }
  // Invariant: sqrt(lo) <= S < sqrt(hi + 1)
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2);
    if (getSqrtRatioAtTick(mid) <= sqrtPriceX96) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}
