/**
 * EM-STRAT-014-E1 — discount series construction (replay of raw fixtures).
 *
 * For every DECLARED grid block of a pool, the series either carries an
 * exact discount value or an EXCLUSION with a reason. The core rules:
 *
 *   1. CONVENTION (code convention, hl-lst-arb-scanner lineage):
 *        marketPrice = slot0 sqrtPriceX96^-2 in kHYPE per WHYPE
 *        anchorRate  = Accountant.kHYPEToHYPE(1e18)/1e18  (HYPE per kHYPE)
 *        d = marketPrice x anchorRate - 1
 *      d > 0  => kHYPE trades BELOW redemption value (discount).
 *      d is computed EXACTLY: d = (S^2*anchorRaw - 2^192*1e18) / (2^192*1e18).
 *
 *   2. NO INTERPOLATION, NO CARRY-FORWARD: a sample whose anchor read is
 *      missing/invalid/stale/future is excluded with reason
 *      `anchor_unusable` (+detail). It produces NO discount value, and
 *      event contiguity is broken across it (E1-T4).
 *
 *   3. Redundant state is cross-validated and failures exclude the sample:
 *      recorded tick vs sqrtPriceX96 (`slot0_tick_mismatch`), recorded
 *      liquidity vs tick-data-implied liquidity
 *      (`liquidity_tickdata_mismatch`), fee-tier constancy
 *      (`fee_tier_inconsistent`), timestamp monotonicity
 *      (`non_monotonic_series`), duplicate grid blocks
 *      (`duplicate_sample`), grid gaps (`sample_missing`).
 *
 *   4. EM-STRAT-014-E1-R2 duplicate integrity: identical duplicate records
 *      for a block are a visible `duplicate_sample` exclusion (first kept,
 *      deterministic); CONFLICTING duplicates throw a deterministic error —
 *      runReplay enforces the same policy upstream and fails the replay
 *      with { ok:false } before this function is reached. Silent
 *      first-record-wins on conflicting data is impossible.
 */

import { rat, ratAbs, ratCmp, ratMul, ratToDecimalString, ratToExactFractionString, type Rational } from '../math/rational.js';
import { Q192, getSqrtRatioAtTick, tickFromSqrtPrice } from '../v3/tick-math.js';
import { activeLiquidityFromTicks, type PoolState, type TickEntry } from '../v3/tick-walk.js';
import type { AnchorRecord, PoolSampleRecord } from './raw-archive.js';
import { poolDuplicateKind } from './raw-archive.js';

export interface SeriesExclusion {
  blockHeight: number;
  reason: string;
  detail: string | null;
}

export interface SeriesSample {
  /** Expected grid index (0-based) — contiguity is defined on this. */
  gridIndex: number;
  blockHeight: number;
  blockTimestampSec: number;
  /** The anchor raw value (kHYPEToHYPE, 1e18 scale) used for this d. */
  anchorRaw: bigint;
  /** d as a percent (d*100), exact. */
  dPct: Rational;
  /** Canonical 12-dp truncated decimal of dPct. */
  dPctStr: string;
  /** Fully exact "num/den" of dPct. */
  dPctExact: string;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  feeTier: number;
  tickData: TickEntry[];
  /** |d| < independence band (reversion marker, informational). */
  withinBand: boolean;
}

export interface PoolSeries {
  poolAddress: string;
  samples: SeriesSample[];
  exclusions: SeriesExclusion[];
  /** Fee tier recorded by the pool's FIRST usable sample. */
  feeTierRecorded: number | null;
  declaredSampleCount: number;
}

export interface AnchorLookup {
  /** Exact-block anchor records; no carry-forward is performed, ever. */
  byBlock: Map<number, AnchorRecord>;
}

function q192ScaledPriceD(anchorRaw: bigint, sqrtPriceX96: bigint): Rational {
  // d = (S^2 * anchorRaw - 2^192 * 1e18) / (2^192 * 1e18)   [exact]
  const num = sqrtPriceX96 * sqrtPriceX96 * anchorRaw - Q192 * 1_000_000_000_000_000_000n;
  const den = Q192 * 1_000_000_000_000_000_000n;
  return rat(num, den);
}

/** d as percent, exact. */
export function discountPct(anchorRaw: bigint, sqrtPriceX96: bigint): Rational {
  return ratMul(q192ScaledPriceD(anchorRaw, sqrtPriceX96), rat(100n, 1n));
}

/**
 * Price P (kHYPE per WHYPE) implied by sqrtPriceX96, as an exact rational
 * with denominator 2^192. Used to validate the recorded tick.
 */
export function priceFromSqrt(sqrtPriceX96: bigint): Rational {
  return rat(sqrtPriceX96 * sqrtPriceX96, Q192);
}

/**
 * Build the discount series for one pool over the declared grid.
 * `records` are the decoded raw samples for this pool (any order).
 */
export function buildDiscountSeries(
  poolAddress: string,
  declaredSampleCount: number,
  expectedBlockAt: (gridIndex: number) => number,
  anchorLookup: AnchorLookup,
  records: PoolSampleRecord[],
  stalenessMaxSec: number,
  futureToleranceSec: number,
  independenceBandPct: Rational,
): PoolSeries {
  const byBlock = new Map<number, PoolSampleRecord>();
  const exclusions: SeriesExclusion[] = [];

  for (const rec of records) {
    const existing = byBlock.get(rec.blockHeight);
    if (existing !== undefined) {
      // EM-STRAT-014-E1-R2: a duplicate that disagrees on ANY decoded field
      // is a self-contradicting archive and must NEVER be silently resolved
      // by first-record-wins. Fail LOUDLY with a deterministic error.
      // The sanctioned pipeline (runReplay) enforces the same policy
      // upstream and fails closed with { ok:false } BEFORE calling this
      // function — reaching this throw means buildDiscountSeries was
      // invoked directly on a stream that replay would have rejected.
      if (poolDuplicateKind(existing, rec) === 'conflict') {
        throw new Error(`discount_series:conflicting_duplicate_pool_sample:block_${rec.blockHeight}:records_disagree_on_decoded_values`);
      }
      exclusions.push({
        blockHeight: rec.blockHeight,
        reason: 'duplicate_sample',
        detail: `duplicate_raw_record_for_block_${rec.blockHeight}_first_record_kept`,
      });
      continue;
    }
    byBlock.set(rec.blockHeight, rec);
  }

  const samples: SeriesSample[] = [];
  let feeTierRecorded: number | null = null;
  let lastUsableTs = -1;

  for (let gridIndex = 0; gridIndex < declaredSampleCount; gridIndex++) {
    const blockHeight = expectedBlockAt(gridIndex);
    const rec = byBlock.get(blockHeight);
    if (rec === undefined) {
      exclusions.push({ blockHeight, reason: 'sample_missing', detail: `declared_grid_block_${blockHeight}_absent_from_raw_archive` });
      continue;
    }
    if (rec.fieldError !== null) {
      exclusions.push({ blockHeight, reason: 'sample_field_invalid', detail: rec.fieldError });
      continue;
    }
    // All fields are non-null when fieldError is null (decoder contract).
    const S = rec.sqrtPriceX96 as bigint;
    const tick = rec.tick as number;
    const liquidity = rec.liquidity as bigint;
    const feeTier = rec.feeTier as number;
    const tickData = rec.tickData as TickEntry[];

    // --- anchor gate (exact-block lookup; NO carry-forward) ---
    const anchor = anchorLookup.byBlock.get(blockHeight);
    if (anchor === undefined) {
      exclusions.push({ blockHeight, reason: 'anchor_unusable', detail: 'anchor_record_missing_at_declared_block' });
      continue;
    }
    if (anchor.fieldError !== null) {
      exclusions.push({ blockHeight, reason: 'anchor_unusable', detail: anchor.fieldError });
      continue;
    }
    const anchorRaw = anchor.anchorRaw as bigint;
    const anchorAgeSec = anchor.blockTimestampSec - anchor.anchorReadAtSec;
    if (anchorAgeSec > stalenessMaxSec) {
      exclusions.push({
        blockHeight,
        reason: 'anchor_unusable',
        detail: `anchor_read_stale:${anchorAgeSec}s>${stalenessMaxSec}s`,
      });
      continue;
    }
    const anchorFutureSec = anchor.anchorReadAtSec - anchor.blockTimestampSec;
    if (anchorFutureSec > futureToleranceSec) {
      exclusions.push({
        blockHeight,
        reason: 'anchor_unusable',
        detail: `anchor_read_future:${anchorFutureSec}s>${futureToleranceSec}s`,
      });
      continue;
    }

    // --- slot0/tick cross-validation ---
    let tickConsistent = true;
    try {
      const lo = getSqrtRatioAtTick(tick);
      const hi = tick >= 887272 ? lo : getSqrtRatioAtTick(tick + 1);
      tickConsistent = S >= lo && S < hi && tickFromSqrtPrice(S) === tick;
    } catch {
      tickConsistent = false;
    }
    if (!tickConsistent) {
      exclusions.push({ blockHeight, reason: 'slot0_tick_mismatch', detail: `tick_${tick}_inconsistent_with_sqrtPriceX96` });
      continue;
    }

    // --- liquidity vs tick-data cross-validation ---
    const impliedLiquidity = activeLiquidityFromTicks(tickData, tick);
    if (impliedLiquidity !== liquidity) {
      exclusions.push({
        blockHeight,
        reason: 'liquidity_tickdata_mismatch',
        detail: `recorded_${liquidity.toString()}_implied_${impliedLiquidity.toString()}`,
      });
      continue;
    }

    // --- fee-tier constancy ---
    if (feeTierRecorded === null) {
      feeTierRecorded = feeTier;
    } else if (feeTierRecorded !== feeTier) {
      exclusions.push({
        blockHeight,
        reason: 'fee_tier_inconsistent',
        detail: `first_${feeTierRecorded}_this_${feeTier}`,
      });
      continue;
    }

    // --- timestamp monotonicity across USABLE samples ---
    if (lastUsableTs >= 0 && rec.blockTimestampSec <= lastUsableTs) {
      exclusions.push({
        blockHeight,
        reason: 'non_monotonic_series',
        detail: `ts_${rec.blockTimestampSec}_not_after_previous_${lastUsableTs}`,
      });
      continue;
    }
    lastUsableTs = rec.blockTimestampSec;

    const dPct = discountPct(anchorRaw, S);
    const withinBand = ratCmp(ratAbs(dPct), independenceBandPct) < 0;
    samples.push({
      gridIndex,
      blockHeight,
      blockTimestampSec: rec.blockTimestampSec,
      anchorRaw,
      dPct,
      dPctStr: ratToDecimalString(dPct, 12),
      dPctExact: ratToExactFractionString(dPct),
      sqrtPriceX96: S.toString(),
      tick,
      liquidity: liquidity.toString(),
      feeTier,
      tickData,
      withinBand,
    });
  }

  // Deterministic exclusion order: by block height, then reason.
  exclusions.sort((a, b) => a.blockHeight - b.blockHeight || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));

  return { poolAddress, samples, exclusions, feeTierRecorded, declaredSampleCount };
}

/** Reconstruct the walkable PoolState for one sample. */
export function sampleToPoolState(s: SeriesSample): PoolState {
  return {
    sqrtPriceX96: BigInt(s.sqrtPriceX96),
    tick: s.tick,
    liquidity: BigInt(s.liquidity),
    ticks: s.tickData,
  };
}
