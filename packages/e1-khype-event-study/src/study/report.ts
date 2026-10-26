/**
 * EM-STRAT-014-E1 — pass-rule report builder.
 *
 * Applies the pre-registered decision rule VERBATIM:
 *   >= N independent qualifying events per week with
 *   d > fees + impact(D) at depth D
 *     ==> advance hl_lst_arb to controlled paper validation;
 *   fewer/shallower ==> retain MONITORING_ONLY.
 *
 * The report carries the full audit trail: per-pool series, every event
 * with its economics, EVERY exclusion with its reason (nothing is silently
 * dropped), the assumption register, and the limitations block that states
 * — in the artifact itself — that this run is synthetic tooling
 * validation, that no data collection was performed, and that strategy
 * promotion remains unauthorized pending E-10 + separate Instructor
 * authorization.
 *
 * eventsPerWeek = qualifyingEvents * 604800 / windowSec, EXACT rational.
 * The verdict comparison is exact: eventsPerWeek >= N. It therefore changes
 * ONLY when N or D (or the underlying data) change (E1-T11).
 */

import { rat, ratCmp, ratToDecimalString, ratToExactFractionString, type Rational } from '../math/rational.js';
import type { ParsedManifest, StudyManifest } from './manifest.js';
import type { PoolSeries } from './discount-series.js';
import type { DepthExclusion, StudyEvent } from './events.js';

export const PASS_RULE_TEXT =
  '>= N independent qualifying events per week with d > fees + impact(D) at depth D';

export interface PoolReport {
  address: string;
  venue: string;
  feeTierRecorded: number | null;
  declaredSampleCount: number;
  samplesUsable: number;
  exclusionsCount: number;
  events: StudyEvent[];
  depthExclusions: DepthExclusion[];
  /** Full per-sample series: block, ts, d (12dp + exact), liquidity, fee. */
  series: Array<{
    gridIndex: number;
    blockHeight: number;
    blockTimestampSec: number;
    dPct: string;
    dPctExact: string;
    withinBand: boolean;
    liquidity: string;
    feeTier: number;
  }>;
  exclusions: Array<{ blockHeight: number; reason: string; detail: string | null }>;
}

export interface ReportObject {
  schema: 'e1-pass-report/v1';
  toolVersion: string;
  manifestId: string;
  manifestSha256: string;
  /** Echo of the pre-registered manifest (already plain JSON). */
  manifest: StudyManifest;
  window: {
    startBlock: number;
    endBlock: number;
    sampleCount: number;
    gridStepSec: number;
    windowSec: number;
    windowWeeksStr: string;
    windowWeeksExact: string;
  };
  parameters: {
    nEventsPerWeek: string;
    nEventsPerWeekExact: string;
    depthUsd: string;
    depthNotionalWei: string;
    grossEventThresholdPct: string;
    independenceBandPct: string;
  };
  costs: {
    flashloanFeePct: string;
    redemptionFeePct: string;
    note: string;
  };
  pools: PoolReport[];
  aggregate: {
    qualifyingEvents: number;
    failingEvents: number;
    eventsPerWeekStr: string;
    eventsPerWeekExact: string;
    exclusionsTotal: number;
    exclusionsByReason: Record<string, number>;
  };
  verdict: {
    rule: string;
    advance: boolean;
    verdict: 'ADVANCE_TO_CONTROLLED_PAPER_VALIDATION' | 'RETAIN_MONITORING_ONLY';
    basis: 'synthetic-tooling-validation-only';
    rationale: string;
  };
  assumptions: string[];
  limitations: string[];
}

/** Simple deterministic SHA-256 (FIPS 180-4) over UTF-8 bytes, BigInt-based. */
export function sha256Hex(input: string): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  // UTF-8 encode without TextEncoder (keeps the pipeline dependency-free
  // and identical across runtimes).
  const bytes: number[] = [];
  const encoded = Buffer.from(input, 'utf8');
  for (const b of encoded) bytes.push(b);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(Math.floor(bitLen / 2 ** (8 * i)) & 0xff);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  for (let off = 0; off < bytes.length; off += 64) {
    const w = new Array<number>(64).fill(0);
    for (let i = 0; i < 16; i++) {
      w[i] =
        ((bytes[off + 4 * i] << 24) |
          (bytes[off + 4 * i + 1] << 16) |
          (bytes[off + 4 * i + 2] << 8) |
          bytes[off + 4 * i + 3]) >>>
        0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map(x => x.toString(16).padStart(8, '0')).join('');
}

function secondsToWeeksRational(sec: number): Rational {
  return rat(BigInt(sec), 604800n);
}

export function buildReport(
  manifestParsed: ParsedManifest,
  manifestCanonicalSha256: string,
  poolResults: Array<{
    series: PoolSeries;
    events: StudyEvent[];
    depthExclusions: DepthExclusion[];
    venue: string;
  }>,
): ReportObject {
  const m: StudyManifest = manifestParsed.manifest;
  const w = m.window;
  const windowSec = (w.sampleCount - 1) * w.gridStepSec;
  const endBlock = w.startBlock + (w.sampleCount - 1) * w.blockStep;
  const weeks = secondsToWeeksRational(windowSec);

  const poolReports: PoolReport[] = poolResults.map(pr => ({
    address: pr.series.poolAddress,
    venue: pr.venue,
    feeTierRecorded: pr.series.feeTierRecorded,
    declaredSampleCount: pr.series.declaredSampleCount,
    samplesUsable: pr.series.samples.length,
    exclusionsCount: pr.series.exclusions.length + pr.depthExclusions.length,
    events: pr.events,
    depthExclusions: pr.depthExclusions,
    series: pr.series.samples.map(s => ({
      gridIndex: s.gridIndex,
      blockHeight: s.blockHeight,
      blockTimestampSec: s.blockTimestampSec,
      dPct: s.dPctStr,
      dPctExact: s.dPctExact,
      withinBand: s.withinBand,
      liquidity: s.liquidity,
      feeTier: s.feeTier,
    })),
    exclusions: [
      ...pr.series.exclusions.map(e => ({ blockHeight: e.blockHeight, reason: e.reason, detail: e.detail })),
      ...pr.depthExclusions.map(e => ({ blockHeight: e.blockHeight, reason: e.reason, detail: e.detail })),
    ].sort((a, b) => a.blockHeight - b.blockHeight || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0)),
  }));

  let qualifying = 0;
  let failing = 0;
  let exclusionsTotal = 0;
  const exclusionsByReason: Record<string, number> = {};
  for (const pr of poolResults) {
    for (const ev of pr.events) {
      if (ev.passed) qualifying++;
      else failing++;
    }
    const allEx = [...pr.series.exclusions, ...pr.depthExclusions];
    exclusionsTotal += allEx.length;
    for (const e of allEx) {
      exclusionsByReason[e.reason] = (exclusionsByReason[e.reason] ?? 0) + 1;
    }
  }

  // eventsPerWeek = qualifying * 604800 / windowSec (exact).
  const eventsPerWeek = rat(BigInt(qualifying) * 604800n, BigInt(windowSec));
  const nThreshold = manifestParsed.nEventsPerWeek;
  const advance = ratCmp(eventsPerWeek, nThreshold) >= 0;

  const rationale = advance
    ? `synthetic_result:qualifying_events_per_week_${ratToDecimalString(eventsPerWeek, 12)}_>=_pre_registered_N_${ratToDecimalString(nThreshold, 12)}`
    : `synthetic_result:qualifying_events_per_week_${ratToDecimalString(eventsPerWeek, 12)}_<_pre_registered_N_${ratToDecimalString(nThreshold, 12)}`;

  const assumptions: string[] = [
    'A1: WHYPE ~ HYPE 1:1 is an ASSUMPTION, not a measured fact (code lineage: hl-lst-arb-scanner.ts:317). If material, it must be measured via a WHYPE/HYPE reference pool before any real study.',
    'A2: Discount convention is the CODE convention: d = marketPrice * anchorRate - 1 with marketPrice in kHYPE per WHYPE and anchorRate = Accountant.kHYPEToHYPE(1e18)/1e18 (HYPE per kHYPE). d > 0 means kHYPE trades below redemption value. The inverse form 1 - price * anchorRate is equivalent ONLY with correspondingly inverted inputs; conventions are never mixed across artifacts.',
    'A3: anchorRate provenance is the Accountant read (selector 0x759bc2fc lineage); the freshness gate mirrors the scanner (staleness <= anchorStalenessMaxSec, future tolerance <= anchorFutureToleranceSec). Missing/invalid/stale/future anchors EXCLUDE the sample (no interpolation, no carry-forward).',
    'A4: Tick math is a LOCAL exact-rational convention (floor of isqrt of the floored rational 2^192*1.0001^tick). It can differ from deployed Uniswap TickMath by <= 1 ulp; before any real-data study it must be cross-validated against the pools actual deployed TickMath.',
    'A5: slot0 sqrtPriceX96 prints are single-block spot observations — a spot print is NOT executable depth (manipulation/flash-boost caveat). That is exactly why impact(D) is measured separately by the tick-walk over recorded liquidity + tick data at the same block.',
    'A6: Pool-census completeness is NOT established offline. This run validates tooling over a SYNTHETIC census only; the real census enumeration (HyperSwap V2/V3, Ramses, other HyperEVM venues) requires live queries and its own authorization.',
    'A7: Kinetiq redemption fees/queue/minimums are UNMEASURED (E-10 prerequisite). The synthetic manifest declares redemptionFeePct=0 for tooling validation ONLY; the real pass rule stays CLOSED until E-10 measures the schedule. The same applies to the flashloan fee constant, which is taken from the manifest (lineage: lib/hyperliquid-defi.ts HYPERLEND_FLASHLOAN_FEE=0.0004) and must be re-verified by E-10.',
    'A8: impact(D) is measured with a fee=0 walk (size impact only); the per-pool AMM fee tier — read from recorded pool state, never assumed — is accounted once in the fees term. This prevents double-counting size impact and fee.',
    'A9: Events are detected PER POOL and summed across the census for frequency; cross-pool correlation is not deduplicated (declared).',
    'A10: The block grid is synthetic (declared blockStep/gridStepSec); timestamps are synthetic block timestamps, not wall-clock. The pipeline contains NO clock, no randomness, and no floating point.',
  ];

  const limitations: string[] = [
    'L1: This run is TOOLING VALIDATION over explicitly synthetic fixtures (manifest.synthetic=true, enforced). It does NOT establish that a profitable dislocation exists and does NOT change the hl_lst_arb disposition.',
    'L2: No collector was run and none is included: no RPC, no archive RPC, no explorer read, no live market query, no cadence/daemon. E1-T10 (collector conformance) is deferred until collection is separately authorized.',
    'L3: The REAL study manifest was not written or finalized (the tool refuses synthetic=false). N and D above are synthetic test parameters, NOT Instructor pre-registrations for a real study.',
    'L4: No pass/fail verdict from REAL-market evidence can be emitted by this run; the verdict block is labeled synthetic-tooling-validation-only.',
    'L5: Actual data collection and strategy promotion remain unauthorized and pending E-10 results plus separate Instructor authorization.',
  ];

  return {
    schema: 'e1-pass-report/v1',
    toolVersion: m.toolVersion,
    manifestId: m.manifestId,
    manifestSha256: manifestCanonicalSha256,
    manifest: m,
    window: {
      startBlock: w.startBlock,
      endBlock,
      sampleCount: w.sampleCount,
      gridStepSec: w.gridStepSec,
      windowSec,
      windowWeeksStr: ratToDecimalString(weeks, 12),
      windowWeeksExact: ratToExactFractionString(weeks),
    },
    parameters: {
      nEventsPerWeek: m.parameters.nEventsPerWeek,
      nEventsPerWeekExact: ratToExactFractionString(nThreshold),
      depthUsd: m.parameters.depthUsd,
      depthNotionalWei: manifestParsed.depthNotionalWei.toString(),
      grossEventThresholdPct: m.parameters.grossEventThresholdPct,
      independenceBandPct: m.parameters.independenceBandPct,
    },
    costs: {
      flashloanFeePct: m.costs.flashloanFeePct,
      redemptionFeePct: m.costs.redemptionFeePct,
      note: 'fees are PERCENT; redemptionFeePct is UNMEASURED in reality (E-10 prerequisite) — synthetic value only (A7)',
    },
    pools: poolReports,
    aggregate: {
      qualifyingEvents: qualifying,
      failingEvents: failing,
      eventsPerWeekStr: ratToDecimalString(eventsPerWeek, 12),
      eventsPerWeekExact: ratToExactFractionString(eventsPerWeek),
      exclusionsTotal,
      exclusionsByReason,
    },
    verdict: {
      rule: PASS_RULE_TEXT,
      advance,
      verdict: advance ? 'ADVANCE_TO_CONTROLLED_PAPER_VALIDATION' : 'RETAIN_MONITORING_ONLY',
      basis: 'synthetic-tooling-validation-only',
      rationale,
    },
    assumptions,
    limitations,
  };
}
