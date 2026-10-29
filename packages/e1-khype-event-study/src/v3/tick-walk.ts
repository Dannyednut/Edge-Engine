/**
 * EM-STRAT-014-E1 — local V3 tick-walk quote / depth-at-size model.
 *
 * PURPOSE
 *   The E-1 pass rule needs impact(D): the price cost of trading size D
 *   against a kHYPE pool. The repository's view-quoter cannot be used for
 *   chain 999 (no documented deployment — see EI-STRAT-014 §2.2), so depth
 *   is modeled here by a deterministic local walk over recorded pool state
 *   (slot0 sqrtPriceX96, liquidity, and the initialized-tick liquidity
 *   distribution at the SAME block).
 *
 * POOL ORIENTATION (FIXED — matches the measurement subject,
 * packages/scanner's hl-lst-arb-scanner WHYPE/kHYPE pools):
 *   token0 = WHYPE, token1 = kHYPE, both 18 decimals.
 *   price P = token1/token0 = kHYPE per WHYPE = (sqrtPriceX96 / 2^96)^2.
 *   The strategy leg is BUYING kHYPE with WHYPE (exact-in WHYPE ->
 *   kHYPE): zeroForOne, price P DECREASES, i.e. the kHYPE-per-WHYPE
 *   premium shrinks — buying kHYPE eats the discount, which is exactly
 *   the impact the pass rule must account for.
 *
 * MATH (all BigInt-exact, Q64.96):
 *   Virtual reserves within one tick range: x = L/sqrtP (token0), y =
 *   L*sqrtP (token1). For an input r of token0 within a segment:
 *     1/sqrtP_end = 1/sqrtP_start + r/L
 *     sqrtP_end   = S*L*2^96 / (L*2^96 + r*S)      (exact rational, floored)
 *     token1 out  = L*(sqrtP_start - sqrtP_end)/2^96   (floored)
 *   Crossing an initialized tick DOWNWARD applies L <- L - liquidityNet[t]
 *   (liquidityNet[t] is the liquidity ADDED crossing t upward).
 *
 * DECLARED ROUNDING / FAIL-CLOSED POLICY
 *   - Segment input requirement is CEILed, token1 output is FLOORed:
 *     the model never overstates output and never understates required
 *     input (conservative in the direction that understates profit).
 *   - A boundary-crossing consumes the ceil-ed segment input; the residual
 *     slack per crossing is at most 1 wei of token0 (bounded, declared).
 *   - Zero recorded liquidity -> { ok:false, reason:'no_liquidity' }.
 *   - Input remaining after the last recorded boundary below the price ->
 *     { ok:false, reason:'zero_liquidity_below' }. The model NEVER clamps
 *     to the last price or extrapolates unseen liquidity (E1-T7/T8).
 *   - slot0/tick inconsistency or tick-data disorder -> explicit failure.
 */

import { mulDivCeil, mulDivFloor } from '../math/bigint-math.js';
import { Q96, getSqrtRatioAtTick, MAX_TICK, MIN_TICK } from './tick-math.js';

/** One initialized-tick liquidity boundary. */
export interface TickEntry {
  tick: number;
  /** Liquidity ADDED when crossing this tick upward (removed downward). */
  liquidityNet: bigint;
}

/** Recorded pool state at one block (already hex-decoded to BigInts). */
export interface PoolState {
  sqrtPriceX96: bigint;
  tick: number;
  /** Active in-range liquidity as recorded by the pool's liquidity() call. */
  liquidity: bigint;
  /** Initialized tick boundaries covering the walk range (any order in). */
  ticks: TickEntry[];
}

export interface WalkQuote {
  ok: true;
  /** kHYPE (token1) received. */
  amountOut: bigint;
  /** WHYPE (token0) consumed after the fee deduction. */
  amountInEffective: bigint;
  /** WHYPE (token0) as submitted (fee deducted from this). */
  amountInGross: bigint;
  sqrtPriceX96After: bigint;
  startSqrtPriceX96: bigint;
  /** Initialized ticks crossed, in walk order (descending tick values). */
  ticksCrossed: number[];
  /** Active liquidity after the walk (before crossing the next boundary). */
  liquidityAfter: bigint;
}

export type WalkFailure = { ok: false; reason: string };

export type WalkResult = WalkQuote | WalkFailure;

/** Active liquidity implied by the tick data at the given tick. */
export function activeLiquidityFromTicks(ticks: TickEntry[], currentTick: number): bigint {
  let L = 0n;
  for (const t of ticks) {
    if (t.tick <= currentTick) L += t.liquidityNet;
  }
  return L;
}

function sortedTicks(ticks: TickEntry[]): TickEntry[] | string {
  const sorted = [...ticks].sort((a, b) => a.tick - b.tick);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].tick === sorted[i - 1].tick) return 'tick_data_duplicate_tick';
    if (!Number.isInteger(sorted[i].tick)) return 'tick_data_invalid_tick';
  }
  for (const t of sorted) {
    if (!Number.isInteger(t.tick) || t.tick < MIN_TICK || t.tick > MAX_TICK) {
      return 'tick_data_tick_out_of_range';
    }
  }
  return sorted;
}

/**
 * Quote an exact-in swap of `amountInGrossWei` WHYPE (token0) for kHYPE
 * (token1). `feeMillionths` is the pool's V3 fee in millionths (fee tier
 * 100 = 0.01%), deducted from the input before pricing (Uniswap-V3
 * convention). Callers measuring pass-rule impact() use feeMillionths = 0
 * so the AMM fee is not double-counted with the fees term (declared
 * convention, recorded in the report's assumption register).
 */
export function quoteExactInWhypeToKhype(
  state: PoolState,
  amountInGrossWei: bigint,
  feeMillionths: bigint,
): WalkResult {
  if (typeof amountInGrossWei !== 'bigint' || amountInGrossWei <= 0n) {
    return { ok: false, reason: 'invalid_amount_in' };
  }
  if (typeof feeMillionths !== 'bigint' || feeMillionths < 0n || feeMillionths >= 1_000_000n) {
    return { ok: false, reason: 'invalid_fee' };
  }
  const S0 = state.sqrtPriceX96;
  if (typeof S0 !== 'bigint' || S0 <= 0n) {
    return { ok: false, reason: 'invalid_sqrt_price' };
  }
  if (!Number.isInteger(state.tick) || state.tick < MIN_TICK || state.tick > MAX_TICK) {
    return { ok: false, reason: 'invalid_tick' };
  }
  // slot0/tick consistency (fail-closed — a mismatched sample is unusable).
  const loSqrt = getSqrtRatioAtTick(state.tick);
  const hiSqrt = state.tick === MAX_TICK ? loSqrt : getSqrtRatioAtTick(state.tick + 1);
  if (S0 < loSqrt || S0 >= hiSqrt) {
    return { ok: false, reason: 'slot0_tick_mismatch' };
  }
  if (typeof state.liquidity !== 'bigint' || state.liquidity < 0n) {
    return { ok: false, reason: 'invalid_liquidity' };
  }
  if (state.liquidity === 0n) {
    return { ok: false, reason: 'no_liquidity' };
  }
  const sorted = sortedTicks(state.ticks);
  if (typeof sorted === 'string') return { ok: false, reason: sorted };
  // Recorded liquidity must agree with the recorded tick distribution.
  const implied = activeLiquidityFromTicks(sorted, state.tick);
  if (implied !== state.liquidity) {
    return { ok: false, reason: 'liquidity_tickdata_mismatch' };
  }

  const amountInEffective = mulDivFloor(amountInGrossWei, 1_000_000n - feeMillionths, 1_000_000n);
  if (amountInEffective === 0n) {
    return { ok: false, reason: 'input_fully_consumed_by_fee' };
  }

  let L = state.liquidity;
  let S = S0;
  let remaining = amountInEffective;
  let amountOut = 0n;
  const ticksCrossed: number[] = [];

  // Boundaries strictly below the current tick, nearest first.
  const downs = sorted.filter(t => t.tick < state.tick).reverse();
  let idx = 0;

  while (remaining > 0n) {
    const boundary = idx < downs.length ? downs[idx] : null;
    if (boundary === null) {
      // No recorded boundaries below the current price and input remains:
      // the recorded liquidity cannot price the rest. FAIL CLOSED — the
      // model never clamps to the last price or extrapolates (E1-T7/T8).
      return { ok: false, reason: 'zero_liquidity_below' };
    }
    const STarget = getSqrtRatioAtTick(boundary.tick);

    // Input needed to push the price exactly onto the segment target (ceil).
    const inToTarget = mulDivCeil(L, Q96 * (S - STarget), S * STarget);

    if (remaining < inToTarget) {
      // Finish inside this segment (exact rational, floored).
      const SEnd = (S * L * Q96) / (L * Q96 + remaining * S);
      if (SEnd >= S) return { ok: false, reason: 'degenerate_segment' };
      amountOut += mulDivFloor(L, S - SEnd, Q96);
      S = SEnd;
      remaining = 0n;
      break;
    }

    // Consume the whole segment.
    amountOut += mulDivFloor(L, S - STarget, Q96);
    S = STarget;
    remaining -= inToTarget;

    // Cross the boundary downward: remove its net liquidity.
    L -= boundary.liquidityNet;
    ticksCrossed.push(boundary.tick);
    idx++;
    if (L <= 0n) {
      if (remaining > 0n) return { ok: false, reason: 'zero_liquidity_below' };
      break;
    }
  }

  return {
    ok: true,
    amountOut,
    amountInEffective,
    amountInGross: amountInGrossWei,
    sqrtPriceX96After: S,
    startSqrtPriceX96: S0,
    ticksCrossed,
    liquidityAfter: L,
  };
}
