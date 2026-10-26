/**
 * EM-STRAT-014-E1 — offline kHYPE event-study tooling (public API).
 *
 * Design contract (see package README + PR description):
 *   - OFFLINE ONLY: no network, no RPC, no clock, no randomness, no floats.
 *   - FAIL-CLOSED: missing/invalid inputs become explicit errors or counted
 *     exclusions — never defaults, never interpolation, never carry-forward.
 *   - CONVENTIONS pinned: code convention d = marketPrice * anchorRate - 1
 *     with marketPrice = kHYPE per WHYPE; WHYPE~HYPE is an assumption.
 *   - SYNTHETIC GATE: the tool refuses non-synthetic manifests (real-study
 *     manifests are not authorized under EM-STRAT-014-E1).
 *
 * This package imports NOTHING from packages/scanner (the view-quoter has
 * no chain-999 deployment and the measurement subject must stay untouched).
 */

export {
  mulDivCeil,
  mulDivFloor,
  floorDiv,
  isqrt,
  gcd,
} from './math/bigint-math.js';

export {
  rat,
  ratInt,
  ratAdd,
  ratSub,
  ratMul,
  ratNeg,
  ratAbs,
  ratCmp,
  ratIsPositive,
  ratIsNegative,
  ratIsZero,
  ratFromDecimalString,
  ratToDecimalString,
  ratToExactFractionString,
  RAT_ZERO,
  type Rational,
} from './math/rational.js';

export {
  Q96,
  Q192,
  MIN_TICK,
  MAX_TICK,
  getSqrtRatioAtTick,
  tickFromSqrtPrice,
} from './v3/tick-math.js';

export {
  quoteExactInWhypeToKhype,
  activeLiquidityFromTicks,
  type PoolState,
  type TickEntry,
  type WalkQuote,
  type WalkFailure,
  type WalkResult,
} from './v3/tick-walk.js';

export {
  TOOL_VERSION,
  CONVENTION_PRICE,
  CONVENTION_DISCOUNT_FORMULA,
  CONVENTION_DISCOUNT_SIGN,
  CONVENTION_WHYPE_HYPE,
  WEI_PER_WHYPE,
  validateManifest,
  type StudyManifest,
  type ParsedManifest,
  type PoolCensusEntry,
  type ManifestResult,
} from './study/manifest.js';

export {
  parseAnchorJsonl,
  parsePoolJsonl,
  type AnchorRecord,
  type PoolSampleRecord,
} from './study/raw-archive.js';

export {
  buildDiscountSeries,
  discountPct,
  priceFromSqrt,
  sampleToPoolState,
  type PoolSeries,
  type SeriesSample,
  type SeriesExclusion,
} from './study/discount-series.js';

export {
  detectEvents,
  type StudyEvent,
  type EventsResult,
  type DepthQuoteView,
  type DepthExclusion,
} from './study/events.js';

export { canonicalJsonString } from './study/canonical.js';

export { buildReport, sha256Hex, PASS_RULE_TEXT, type ReportObject } from './study/report.js';

export { runReplay, type RawArchiveInput, type ReplayResult } from './replay.js';
