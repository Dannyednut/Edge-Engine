/**
 * EM-STRAT-014-E1 — study manifest schema and fail-closed validation.
 *
 * THE MANIFEST IS THE PRE-REGISTRATION. Per EI-STRAT-014 §2.5(1), the
 * window, sampling grid, pool census, cost/convention declarations, the
 * event-independence rule, and the pass-rule parameters N and D are fixed
 * in the manifest BEFORE results are seen. This module enforces that:
 *
 *   - N (nEventsPerWeek) and D (depthUsd) are REQUIRED. There is NO
 *     default anywhere in this package; a manifest missing either is
 *     rejected with an explicit error (E1-T11 binding test).
 *   - All convention strings are compared EXACTLY. A manifest that
 *     declares a different discount convention or price orientation is
 *     rejected rather than silently reinterpreted (orientation-trap guard).
 *   - `synthetic: true` is REQUIRED. Writing or finalizing the REAL study
 *     manifest is prohibited under EM-STRAT-014-E1 (offline tooling only);
 *     the tool refuses anything else with an explicit reason. Lifting this
 *     gate belongs to the future, separately-authorized collection task.
 *   - Validation returns the FULL list of violations, not just the first.
 */

import { ratAdd, ratFromDecimalString, type Rational } from '../math/rational.js';

export const TOOL_VERSION = 'e1-offline-tooling@1';

export const CONVENTION_PRICE = 'khype_per_whype';
export const CONVENTION_DISCOUNT_FORMULA = 'd = marketPrice * anchorRate - 1';
export const CONVENTION_DISCOUNT_SIGN = 'd > 0 => kHYPE below redemption value (discount)';
export const CONVENTION_WHYPE_HYPE = 'ASSUMPTION_NOT_FACT';
/** 1 WHYPE = 10^18 wei (both fixture tokens are 18 decimals). */
export const WEI_PER_WHYPE = '1000000000000000000';
/**
 * EM-STRAT-014-E1-R1: the USD depth conversion. `1 WHYPE = $1` is FORBIDDEN
 * — D USD is converted to a WHYPE wei amount PER SAMPLE via a provenance-
 * bearing, block-aligned WHYPE-to-USD reference price from the archive's
 * usd-price.jsonl series: depthWei = ceil(D_usd * 10^18 / usdPriceRaw).
 * Ceil is the conservative direction (the walked amount is never smaller
 * than the declared USD depth). Missing/stale/malformed/not-aligned USD
 * input excludes the sample from depth evaluation with a counted reason.
 */
export const CONVENTION_DEPTH_CONVERSION = 'per_sample_ceil(D_usd*10^36/usdPriceRaw)';
/** Expected pool orientation: token0 = WHYPE, token1 = kHYPE (declared). */
export const EXPECTED_TOKEN0_SYMBOL = 'WHYPE';
export const EXPECTED_TOKEN1_SYMBOL = 'KHYPE';

export interface PoolCensusEntry {
  /** Lowercase hex pool address (also the raw archive file key). */
  address: string;
  venue: string;
  token0: { symbol: string; decimals: number; address: string };
  token1: { symbol: string; decimals: number; address: string };
  /** Expected V3 fee tier (millionths, e.g. 100 = 0.01%); null = no expectation. */
  expectedFeeTier: number | null;
}

export interface StudyManifest {
  toolVersion: string;
  manifestId: string;
  synthetic: boolean;
  chainId: number;
  window: {
    startBlock: number;
    blockStep: number;
    sampleCount: number;
    startTimestampSec: number;
    gridStepSec: number;
  };
  conventions: {
    priceConvention: string;
    discountFormula: string;
    discountSign: string;
    whypeEqualsHype: string;
    weiPerWhype: string;
    anchorStalenessMaxSec: number;
    anchorFutureToleranceSec: number;
    impactMeasuredWithFeeZero: boolean;
  };
  costs: {
    /** Flashloan fee in PERCENT (exact decimal string; scanner lineage: 0.0004 ratio). */
    flashloanFeePct: string;
    /**
     * Redemption fee in PERCENT (exact decimal string). UNMEASURED in
     * reality (E-10 prerequisite) — the synthetic fixture manifest declares
     * '0' for tooling validation only; the real gate stays closed until
     * E-10 measures Kinetiq redemption mechanics.
     */
    redemptionFeePct: string;
  };
  parameters: {
    /** N — pre-registered qualifying events per week (exact decimal string). */
    nEventsPerWeek: string;
    /** D — pre-registered depth/notional in USD (exact decimal string). */
    depthUsd: string;
    /** Gross dislocation threshold in PERCENT: an excursion requires d > this. */
    grossEventThresholdPct: string;
    /**
     * Independence band in PERCENT: two excursions merge into ONE event
     * unless separated by at least one usable sample with |d| < band
     * (reversion to within the band of the anchor).
     */
    independenceBandPct: string;
  };
  poolCensus: PoolCensusEntry[];
}

export interface ParsedManifest {
  manifest: StudyManifest;
  /** flashloan + redemption fees, in percent, exact. */
  extraFeesPct: Rational;
  nEventsPerWeek: Rational;
  /** D — the pre-registered USD depth, exact rational (NO wei fabrication). */
  depthUsd: Rational;
  grossEventThresholdPct: Rational;
  independenceBandPct: Rational;
}

export type ManifestResult =
  | { ok: true; parsed: ParsedManifest }
  | { ok: false; errors: string[] };

const HEX_ADDR_RE = /^0x[0-9a-f]{40}$/;

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function isNonNegInt(v: unknown): v is number {
  return isInt(v) && v >= 0;
}

function isPosInt(v: unknown): v is number {
  return isInt(v) && v > 0;
}

/**
 * Validate + parse the raw manifest object. Returns ALL violations.
 * No field is defaulted; every missing/invalid field is reported.
 */
export function validateManifest(raw: unknown): ManifestResult {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, errors: ['manifest:entire-manifest-missing-or-not-object'] };
  }
  const m = raw as Record<string, unknown>;

  if (m.toolVersion !== TOOL_VERSION) {
    errors.push(`toolVersion:expected-${TOOL_VERSION},got:${JSON.stringify(m.toolVersion)}`);
  }
  if (typeof m.manifestId !== 'string' || m.manifestId.length === 0) {
    errors.push('manifestId:required-non-empty-string');
  }
  // Containment gate for THIS task: only synthetic manifests are runnable.
  if (m.synthetic !== true) {
    errors.push(
      `synthetic:must-be-true,reason:real-study-manifest-not-authorized-EM-STRAT-014-E1,got:${JSON.stringify(m.synthetic)}`,
    );
  }
  if (m.chainId !== 999) {
    errors.push(`chainId:expected-999,got:${JSON.stringify(m.chainId)}`);
  }

  // --- window ---
  const w = m.window as Record<string, unknown> | undefined;
  if (w === null || typeof w !== 'object') {
    errors.push('window:required-object');
  } else {
    if (!isNonNegInt(w.startBlock)) errors.push(`window.startBlock:required-non-negative-integer,got:${JSON.stringify(w.startBlock)}`);
    if (!isPosInt(w.blockStep)) errors.push(`window.blockStep:required-positive-integer,got:${JSON.stringify(w.blockStep)}`);
    if (!isPosInt(w.sampleCount) || (isInt(w.sampleCount) && (w.sampleCount as number) < 2)) {
      errors.push(`window.sampleCount:required-integer>=2,got:${JSON.stringify(w.sampleCount)}`);
    }
    if (!isNonNegInt(w.startTimestampSec)) errors.push(`window.startTimestampSec:required-non-negative-integer,got:${JSON.stringify(w.startTimestampSec)}`);
    if (!isPosInt(w.gridStepSec)) errors.push(`window.gridStepSec:required-positive-integer,got:${JSON.stringify(w.gridStepSec)}`);
  }

  // --- conventions (EXACT string equality — no reinterpretation) ---
  const c = m.conventions as Record<string, unknown> | undefined;
  if (c === null || typeof c !== 'object') {
    errors.push('conventions:required-object');
  } else {
    if (c.priceConvention !== CONVENTION_PRICE) {
      errors.push(`conventions.priceConvention:expected-${CONVENTION_PRICE},got:${JSON.stringify(c.priceConvention)}`);
    }
    if (c.discountFormula !== CONVENTION_DISCOUNT_FORMULA) {
      errors.push(`conventions.discountFormula:expected-exact-code-convention,got:${JSON.stringify(c.discountFormula)}`);
    }
    if (c.discountSign !== CONVENTION_DISCOUNT_SIGN) {
      errors.push(`conventions.discountSign:expected-exact-sign-semantics,got:${JSON.stringify(c.discountSign)}`);
    }
    if (c.whypeEqualsHype !== CONVENTION_WHYPE_HYPE) {
      errors.push(`conventions.whypeEqualsHype:must-record-WHYPE-HYPE-as-ASSUMPTION_NOT_FACT,got:${JSON.stringify(c.whypeEqualsHype)}`);
    }
    if (c.weiPerWhype !== WEI_PER_WHYPE) {
      errors.push(`conventions.weiPerWhype:expected-${WEI_PER_WHYPE},got:${JSON.stringify(c.weiPerWhype)}`);
    }
    if (!isPosInt(c.anchorStalenessMaxSec)) errors.push(`conventions.anchorStalenessMaxSec:required-positive-integer,got:${JSON.stringify(c.anchorStalenessMaxSec)}`);
    if (!isNonNegInt(c.anchorFutureToleranceSec)) errors.push(`conventions.anchorFutureToleranceSec:required-non-negative-integer,got:${JSON.stringify(c.anchorFutureToleranceSec)}`);
    if (c.impactMeasuredWithFeeZero !== true) {
      errors.push(`conventions.impactMeasuredWithFeeZero:must-be-true,got:${JSON.stringify(c.impactMeasuredWithFeeZero)}`);
    }
  }

  // --- costs (exact decimal strings, in PERCENT) ---
  const costs = m.costs as Record<string, unknown> | undefined;
  let extraFeesPct: Rational | null = null;
  if (costs === null || typeof costs !== 'object') {
    errors.push('costs:required-object');
  } else {
    const fees: Rational[] = [];
    for (const key of ['flashloanFeePct', 'redemptionFeePct'] as const) {
      const v = costs[key];
      if (typeof v !== 'string') {
        errors.push(`costs.${key}:required-exact-decimal-string,got:${JSON.stringify(v)}`);
      } else {
        try {
          const r = ratFromDecimalString(v);
          if (r.num < 0n) errors.push(`costs.${key}:must-be-non-negative,got:${v}`);
          else fees.push(r);
        } catch {
          errors.push(`costs.${key}:invalid-decimal-string,got:${JSON.stringify(v)}`);
        }
      }
    }
    if (fees.length === 2) {
      extraFeesPct = ratAdd(fees[0], fees[1]);
    }
  }

  // --- parameters (REQUIRED; no defaults) ---
  const p = m.parameters as Record<string, unknown> | undefined;
  let nR: Rational | null = null;
  let dR: Rational | null = null;
  let grossR: Rational | null = null;
  let bandR: Rational | null = null;
  if (p === null || typeof p !== 'object') {
    errors.push('parameters:required-object');
  } else {
    if (typeof p.nEventsPerWeek !== 'string') {
      errors.push(`parameters.nEventsPerWeek:REQUIRED-exact-decimal-string-no-default,got:${JSON.stringify(p.nEventsPerWeek)}`);
    } else {
      try {
        nR = ratFromDecimalString(p.nEventsPerWeek);
        if (nR.num <= 0n) errors.push(`parameters.nEventsPerWeek:must-be-positive,got:${p.nEventsPerWeek}`);
      } catch {
        errors.push(`parameters.nEventsPerWeek:invalid-decimal-string,got:${JSON.stringify(p.nEventsPerWeek)}`);
      }
    }
    if (typeof p.depthUsd !== 'string') {
      errors.push(`parameters.depthUsd:REQUIRED-exact-decimal-string-no-default,got:${JSON.stringify(p.depthUsd)}`);
    } else {
      try {
        dR = ratFromDecimalString(p.depthUsd);
        if (dR.num <= 0n) errors.push(`parameters.depthUsd:must-be-positive,got:${p.depthUsd}`);
      } catch {
        errors.push(`parameters.depthUsd:invalid-decimal-string,got:${JSON.stringify(p.depthUsd)}`);
      }
    }
    if (typeof p.grossEventThresholdPct !== 'string') {
      errors.push(`parameters.grossEventThresholdPct:REQUIRED-exact-decimal-string-no-default,got:${JSON.stringify(p.grossEventThresholdPct)}`);
    } else {
      try {
        grossR = ratFromDecimalString(p.grossEventThresholdPct);
        if (grossR.num < 0n) errors.push(`parameters.grossEventThresholdPct:must-be-non-negative,got:${p.grossEventThresholdPct}`);
      } catch {
        errors.push(`parameters.grossEventThresholdPct:invalid-decimal-string,got:${JSON.stringify(p.grossEventThresholdPct)}`);
      }
    }
    if (typeof p.independenceBandPct !== 'string') {
      errors.push(`parameters.independenceBandPct:REQUIRED-exact-decimal-string-no-default,got:${JSON.stringify(p.independenceBandPct)}`);
    } else {
      try {
        bandR = ratFromDecimalString(p.independenceBandPct);
        if (bandR.num <= 0n) errors.push(`parameters.independenceBandPct:must-be-positive,got:${p.independenceBandPct}`);
      } catch {
        errors.push(`parameters.independenceBandPct:invalid-decimal-string,got:${JSON.stringify(p.independenceBandPct)}`);
      }
    }
  }

  // --- pool census ---
  const census = m.poolCensus;
  if (!Array.isArray(census) || census.length === 0) {
    errors.push('poolCensus:required-non-empty-array');
  } else {
    const seen = new Set<string>();
    for (let i = 0; i < census.length; i++) {
      const e = census[i] as Record<string, unknown> | null;
      if (e === null || typeof e !== 'object') {
        errors.push(`poolCensus[${i}]:required-object`);
        continue;
      }
      if (typeof e.address !== 'string' || !HEX_ADDR_RE.test(e.address)) {
        errors.push(`poolCensus[${i}].address:required-lowercase-hex-address,got:${JSON.stringify(e.address)}`);
      } else if (seen.has(e.address)) {
        errors.push(`poolCensus[${i}].address:duplicate,${e.address}`);
      } else {
        seen.add(e.address);
      }
      if (typeof e.venue !== 'string' || e.venue.length === 0) {
        errors.push(`poolCensus[${i}].venue:required-non-empty-string`);
      }
      for (const tokKey of ['token0', 'token1'] as const) {
        const t = e[tokKey] as Record<string, unknown> | undefined;
        if (t === null || typeof t !== 'object') {
          errors.push(`poolCensus[${i}].${tokKey}:required-{symbol,decimals,address}`);
          continue;
        }
        if (typeof t.symbol !== 'string' || t.symbol.length === 0) errors.push(`poolCensus[${i}].${tokKey}.symbol:required-non-empty-string`);
        if (!isNonNegInt(t.decimals)) {
          errors.push(`poolCensus[${i}].${tokKey}.decimals:required-non-negative-integer,got:${JSON.stringify(t.decimals)}`);
        } else if (t.decimals !== 18) {
          // The d convention (raw price = human price) requires equal 18-decimal
          // tokens (WHYPE and kHYPE on HyperEVM are both 18). Anything else is
          // rejected rather than silently mis-scaled.
          errors.push(`poolCensus[${i}].${tokKey}.decimals:expected-18-code-convention,got:${t.decimals}`);
        }
        // EM-STRAT-014-E1-R1: token ADDRESSES are required — price
        // orientation is validated against actual token identity, never
        // assumed from slot order alone.
        if (typeof t.address !== 'string' || !HEX_ADDR_RE.test(t.address)) {
          errors.push(`poolCensus[${i}].${tokKey}.address:required-lowercase-hex-address,got:${JSON.stringify(t.address)}`);
        }
      }
      // EM-STRAT-014-E1-R1: orientation integrity — the study subject is
      // kHYPE-per-WHYPE and the local walk is fixed token0=WHYPE ->
      // token1=kHYPE. The census MUST declare exactly that pair in the
      // expected order; anything else fails closed (inverting requires a
      // separately reviewed walk change — see assumption register).
      const t0 = e.token0 as Record<string, unknown> | undefined;
      const t1 = e.token1 as Record<string, unknown> | undefined;
      if (
        t0 && t1 &&
        typeof t0.symbol === 'string' && typeof t1.symbol === 'string' &&
        typeof t0.address === 'string' && typeof t1.address === 'string' &&
        HEX_ADDR_RE.test(t0.address) && HEX_ADDR_RE.test(t1.address)
      ) {
        if (t0.address === t1.address) {
          errors.push(`poolCensus[${i}].tokens:token0-and-token1-addresses-identical`);
        }
        const orderOk =
          t0.symbol === EXPECTED_TOKEN0_SYMBOL && t1.symbol === EXPECTED_TOKEN1_SYMBOL;
        if (!orderOk) {
          errors.push(`poolCensus[${i}].tokens:pool_orientation_unsupported_expected_token0_${EXPECTED_TOKEN0_SYMBOL}_token1_${EXPECTED_TOKEN1_SYMBOL},got_${String(t0.symbol)}_${String(t1.symbol)}`);
        }
      }
      if (e.expectedFeeTier !== null && !isNonNegInt(e.expectedFeeTier)) {
        errors.push(`poolCensus[${i}].expectedFeeTier:required-null-or-non-negative-integer,got:${JSON.stringify(e.expectedFeeTier)}`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // --- derived quantities (exact) ---
  // EM-STRAT-014-E1-R1: D stays a USD rational at manifest level. The
  // per-sample WHYPE-wei conversion happens in the replay against the
  // block-aligned USD reference price. The former `D * 10^18` wei
  // derivation (which silently assumed 1 WHYPE = $1) is REMOVED.

  return {
    ok: true,
    parsed: {
      manifest: raw as unknown as StudyManifest,
      extraFeesPct: extraFeesPct as Rational,
      nEventsPerWeek: nR as Rational,
      depthUsd: dR as Rational,
      grossEventThresholdPct: grossR as Rational,
      independenceBandPct: bandR as Rational,
    },
  };
}
