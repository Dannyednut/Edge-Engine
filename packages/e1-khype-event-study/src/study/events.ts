/**
 * EM-STRAT-014-E1 — event detection and per-event depth evaluation.
 *
 * PRE-REGISTERED EVENT DEFINITION (manifest parameters; E1-T2/T3 pin the
 * semantics — the code implements exactly what the manifest declares):
 *
 *   1. EXCURSION: a maximal run of CONTIGUOUS usable samples (no excluded
 *      grid block in between) with d > grossEventThresholdPct.
 *
 *   2. INDEPENDENCE (merge rule): two consecutive excursions belong to the
 *      SAME event unless at least one usable sample strictly between them
 *      has |d| < independenceBandPct (reversion to within the band of the
 *      anchor). If every intervening usable sample keeps |d| >= band — or
 *      if only excluded blocks lie between (no reversion observable) — the
 *      excursions are MERGED into one event, flagged when a gap was
 *      spanned. Consequence: reversion INSIDE the band -> two independent
 *      events; reversion that never reaches the band -> ONE event.
 *
 *   3. EVENT GEOMETRY: an event spans from the first sample of its first
 *      excursion to the last sample of its last excursion. durationSec is
 *      the timestamp difference (grid-aligned). d_max is the maximum d
 *      over usable in-span samples (earliest block wins ties).
 *
 *   4. PASS EVALUATION (E1-T1/T5): a sample QUALIFIES when
 *        d > feesSum + impact_s(D)
 *      with feesSum = recordedPoolFeeTier% + flashloan% + redemption%
 *      (exact) and impact_s(D) measured by the local tick-walk at the
 *      pre-registered depth D on that sample's recorded state, with the
 *      AMM fee EXCLUDED from the walk (fee=0) because the fee tier is
 *      already accounted in feesSum (declared; prevents double-count).
 *      impact_s = d_spot - d_realized, where d_realized uses the walk's
 *      average realized price (kHYPE per WHYPE) under the SAME anchor —
 *      the size cost is thus counted exactly once, never double-counted.
 *      An event PASSES iff at least one usable in-span sample qualifies.
 *      Samples with d <= feesSum can never qualify (impact >= 0) and are
 *      skip-safely not walked. A depth walk failure (e.g. no liquidity)
 *      fails the sample and is recorded as a counted exclusion.
 */

import { rat, ratCmp, ratIsPositive, ratMul, ratSub, ratToDecimalString, ratToExactFractionString, type Rational } from '../math/rational.js';
import { quoteExactInWhypeToKhype, type WalkQuote } from '../v3/tick-walk.js';
import { sampleToPoolState, type PoolSeries, type SeriesExclusion, type SeriesSample } from './discount-series.js';

export interface DepthQuoteView {
  /** kHYPE received for D (decimal string of wei). */
  amountOut: string;
  amountInGrossWei: string;
  sqrtPriceX96After: string;
  ticksCrossed: number[];
  /** Average realized price (kHYPE per WHYPE), exact fraction + 12dp. */
  avgPriceExact: string;
  avgPriceStr: string;
}

export interface DepthExclusion extends SeriesExclusion {
  eventIndex: number;
}

export interface StudyEvent {
  eventIndex: number;
  startBlockHeight: number;
  endBlockHeight: number;
  startTsSec: number;
  endTsSec: number;
  durationSec: number;
  /** Usable samples in span. */
  sampleCount: number;
  spannedExclusionGap: boolean;
  dMaxPctStr: string;
  dMaxPctExact: string;
  dMaxBlockHeight: number;
  feesPctStr: string;
  feesPctExact: string;
  /** Depth quote + impact at the d_max sample (null when not measurable). */
  depthQuote: DepthQuoteView | null;
  impactAtDMaxPctStr: string | null;
  impactAtDMaxPctExact: string | null;
  netAtDMaxPctStr: string | null;
  netAtDMaxPctExact: string | null;
  /** First (earliest) qualifying sample block, when the event passes. */
  qualifyingSampleBlock: number | null;
  passed: boolean;
  failingReason: string | null;
}

export interface EventsResult {
  events: StudyEvent[];
  depthExclusions: DepthExclusion[];
}

interface Excursion {
  /** Indices into the usable-sample array. */
  fromIdx: number;
  toIdx: number;
}

interface SampleEval {
  net: Rational;
  impact: Rational;
  walk: WalkQuote;
  avgPrice: Rational;
}

function contiguous(usable: SeriesSample[], fromIdx: number, toIdx: number): boolean {
  for (let i = fromIdx + 1; i <= toIdx; i++) {
    if (usable[i].gridIndex !== usable[i - 1].gridIndex + 1) return false;
  }
  return true;
}

/**
 * Evaluate one sample: walk depth D (fee=0), derive realized d and net.
 * Returns failure instead of throwing for any walk-level rejection.
 */
function evaluateSample(
  s: SeriesSample,
  depthNotionalWei: bigint,
  feesSumPct: Rational,
): SampleEval | { failure: string } {
  const walk = quoteExactInWhypeToKhype(sampleToPoolState(s), depthNotionalWei, 0n);
  if (!walk.ok) return { failure: walk.reason };
  // d_realized = (amountOut/amountInGross) * anchorRate - 1, in percent.
  const avgPrice = rat(walk.amountOut, walk.amountInGross);
  const anchorRate = rat(s.anchorRaw, 1_000_000_000_000_000_000n);
  const dRealizedPct = ratMul(ratSub(ratMul(avgPrice, anchorRate), rat(1n, 1n)), rat(100n, 1n));
  const impact = ratSub(s.dPct, dRealizedPct);
  const net = ratSub(ratSub(s.dPct, feesSumPct), impact);
  return { net, impact, walk, avgPrice };
}

export function detectEvents(
  series: PoolSeries,
  grossThresholdPct: Rational,
  feesSumPct: Rational,
  depthNotionalWei: bigint,
): EventsResult {
  const usable = series.samples;
  const events: StudyEvent[] = [];
  const depthExclusions: DepthExclusion[] = [];

  // --- 1. excursions ---
  const excursions: Excursion[] = [];
  let cur: Excursion | null = null;
  for (let i = 0; i < usable.length; i++) {
    const inExcursion = ratCmp(usable[i].dPct, grossThresholdPct) > 0;
    if (inExcursion) {
      if (cur !== null && contiguous(usable, cur.fromIdx, i)) {
        cur.toIdx = i;
      } else {
        if (cur !== null) excursions.push(cur);
        cur = { fromIdx: i, toIdx: i };
      }
    } else if (cur !== null) {
      excursions.push(cur);
      cur = null;
    }
  }
  if (cur !== null) excursions.push(cur);

  // --- 2. merge by the pre-registered independence band ---
  const merged: Excursion[][] = excursions.map(e => [e]);
  for (let k = merged.length - 2; k >= 0; k--) {
    const left = merged[k];
    const right = merged[k + 1];
    const betweenFrom = left[left.length - 1].toIdx + 1;
    const betweenTo = right[0].fromIdx - 1;
    let reversionObserved = false;
    for (let i = betweenFrom; i <= betweenTo; i++) {
      if (usable[i].withinBand) {
        reversionObserved = true;
        break;
      }
    }
    if (!reversionObserved) {
      // No usable sample reverted inside the band (or only excluded blocks
      // lie between): merge into ONE event per the pre-registered rule.
      left.push(...right);
      merged.splice(k + 1, 1);
    }
  }

  // --- 3./4. event geometry + pass evaluation ---
  let eventIndex = 0;
  for (const group of merged) {
    eventIndex++;
    const fromIdx = group[0].fromIdx;
    const toIdx = group[group.length - 1].toIdx;
    const span = usable.slice(fromIdx, toIdx + 1);
    const first = span[0];
    const last = span[span.length - 1];

    // d_max: maximum d over usable in-span samples, earliest block on ties.
    let dMaxSample = span[0];
    for (const s of span) {
      if (ratCmp(s.dPct, dMaxSample.dPct) > 0) dMaxSample = s;
    }

    // Excluded grid blocks inside the span -> the event spans a gap.
    let spannedExclusionGap = false;
    for (let i = 1; i < span.length; i++) {
      if (span[i].gridIndex !== span[i - 1].gridIndex + 1) {
        spannedExclusionGap = true;
        break;
      }
    }

    // Depth + net at the d_max sample (only attempted when it can qualify).
    let depthQuote: DepthQuoteView | null = null;
    let impactAtDMax: Rational | null = null;
    let netAtDMax: Rational | null = null;
    let dMaxDepthFailed = false;
    if (ratCmp(dMaxSample.dPct, feesSumPct) > 0) {
      const evalRes = evaluateSample(dMaxSample, depthNotionalWei, feesSumPct);
      if ('failure' in evalRes) {
        dMaxDepthFailed = true;
        depthExclusions.push({
          blockHeight: dMaxSample.blockHeight,
          reason: 'depth_quote_failed',
          detail: evalRes.failure,
          eventIndex,
        });
      } else {
        impactAtDMax = evalRes.impact;
        netAtDMax = evalRes.net;
        depthQuote = {
          amountOut: evalRes.walk.amountOut.toString(),
          amountInGrossWei: evalRes.walk.amountInGross.toString(),
          sqrtPriceX96After: evalRes.walk.sqrtPriceX96After.toString(),
          ticksCrossed: [...evalRes.walk.ticksCrossed],
          avgPriceExact: ratToExactFractionString(evalRes.avgPrice),
          avgPriceStr: ratToDecimalString(evalRes.avgPrice, 12),
        };
      }
    }

    // Pass evaluation over ALL usable in-span samples (skip-safe: samples
    // with d <= feesSum cannot qualify because impact >= 0).
    let passed = false;
    let qualifyingSampleBlock: number | null = null;
    for (const s of span) {
      if (ratCmp(s.dPct, feesSumPct) <= 0) continue;
      const evalRes = evaluateSample(s, depthNotionalWei, feesSumPct);
      if ('failure' in evalRes) continue;
      if (ratIsPositive(evalRes.net)) {
        passed = true;
        qualifyingSampleBlock = s.blockHeight;
        break;
      }
    }
    let failingReason: string | null = null;
    if (!passed) {
      const hadDepthFailure =
        dMaxDepthFailed || depthExclusions.some(e => e.eventIndex === eventIndex);
      failingReason = hadDepthFailure ? 'depth_unmeasurable' : 'net_never_positive';
    }

    events.push({
      eventIndex,
      startBlockHeight: first.blockHeight,
      endBlockHeight: last.blockHeight,
      startTsSec: first.blockTimestampSec,
      endTsSec: last.blockTimestampSec,
      durationSec: last.blockTimestampSec - first.blockTimestampSec,
      sampleCount: span.length,
      spannedExclusionGap,
      dMaxPctStr: dMaxSample.dPctStr,
      dMaxPctExact: dMaxSample.dPctExact,
      dMaxBlockHeight: dMaxSample.blockHeight,
      feesPctStr: ratToDecimalString(feesSumPct, 12),
      feesPctExact: ratToExactFractionString(feesSumPct),
      depthQuote,
      impactAtDMaxPctStr: impactAtDMax !== null ? ratToDecimalString(impactAtDMax, 12) : null,
      impactAtDMaxPctExact: impactAtDMax !== null ? ratToExactFractionString(impactAtDMax) : null,
      netAtDMaxPctStr: netAtDMax !== null ? ratToDecimalString(netAtDMax, 12) : null,
      netAtDMaxPctExact: netAtDMax !== null ? ratToExactFractionString(netAtDMax) : null,
      qualifyingSampleBlock,
      passed,
      failingReason,
    });
  }

  return { events, depthExclusions };
}

// Re-exported for report typing convenience.
export type { SeriesExclusion };
