/**
 * Funding annualization + strict provider-rate parsing — E-12 (Issue #17).
 *
 * Single source of truth for the ANNUALIZATION ARITHMETIC used by every
 * funding signal path (funding_divergence HL/VOOI legs, perp_funding
 * VOOI-only rows), so the interval semantics cannot drift between a
 * unit-tested helper and production multiplication.
 *
 * INTERVAL BASIS — EXPLICITLY UNVERIFIED:
 *   Hyperliquid publishes funding as an HOURLY rate (Hyperliquid API
 *   docs). VOOI's `fundingRate` is treated as hourly on the strength of
 *   VOOI's own derivation rule documented in the vooi-client schema
 *   (`fundingRate8h = Number(fundingRate) × 3`, i.e. 8h = 3 × 1h). That
 *   derivation comment is NOT independent confirmation of the upstream
 *   per-venue funding interval: NEITHER API publishes the underlying
 *   venue-specific interval in the payloads this repository consumes, and
 *   NO network verification has been performed (none is authorized in the
 *   offline E-12 work item). Every annualization below therefore rests on
 *   an EXPLICIT '1h-assumed' basis, recorded on every alert
 *   (`fundingIntervalAssumption` / `annualizationBasis`). Nothing in this
 *   repository may describe these figures as interval-verified. If a
 *   future payload carries a per-row interval, it must flow through
 *   `annualizeFundingRate(rate, rowInterval)` instead of the fixed-basis
 *   constant.
 *
 * UNITS:
 *   `annualizeFundingRate` returns a DECIMAL-FRACTION APR (0.08 = 8%/yr)
 *   — the canonical internal unit fixed by E-12. Callers that present
 *   percentage points (e.g. the funding_divergence alert fields) convert
 *   with an explicit `× 100` at the presentation boundary.
 *
 * PROVIDER RATE PARSING — CONTRACT-STRICT:
 *   The repository's `VooiArbitragePair` contract declares each leg's
 *   `fundingRate` as a decimal STRING (e.g. "-0.003497"). Numbers are NOT
 *   contractually supported for this field, so `parseStrictDecimalString`
 *   accepts ONLY strings that match the strict full-string decimal
 *   grammar (after trimming surrounding whitespace) and returns NaN for
 *   everything else — numeric values included. A malformed/missing/nonce-
 *   contractual value must surface as VISIBLE DEGRADATION (a counted
 *   skip), never as a fabricated 0.
 */

/** Strict full-string decimal grammar (see module docblock): the ENTIRE
 *  trimmed string must match. Accepted: '100', '50000.5', '.5', '1.',
 *  '+100', '-0.003497', '1e6', '1E-6'. Rejected: '100garbage',
 *  '50000USD', '1.2.3', '1e', '1e+', '1 00', '1,000', '0x10', 'Infinity',
 *  'NaN', ''. */
export const STRICT_DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Parse a contractually-decimal-STRING provider rate. String-only by
 * design: the provider schema declares `fundingRate: string`, and numeric
 * values are not contractually supported, so a numeric input is a schema
 * violation and yields NaN (visible degradation upstream — never zero).
 * Returns NaN for anything that is not a full-grammar decimal string.
 */
export function parseStrictDecimalString(v: unknown): number {
  if (typeof v !== 'string') return NaN;
  const t = v.trim();
  if (!STRICT_DECIMAL_RE.test(t)) return NaN;
  return Number(t);
}

/** The annualization-interval assumption used across funding signals (hours). */
export const ASSUMED_FUNDING_INTERVAL_HOURS = 1;

/**
 * Annualize a per-interval funding rate into a decimal-fraction APR
 * (1.0 = 100%/yr), pure and fail-closed. THE production annualization
 * input for every funding signal path — no path may inline its own
 * interval multiplication.
 *
 *   apr = rate_per_interval × (24 / interval_hours) × 365
 *
 * Examples (fixtures in funding-divergence-scanner.test.ts):
 *   annualizeFundingRate(0.0001, 1)  → 0.876   (0.01%/h ≈ 87.6%/yr)
 *   annualizeFundingRate(0.0008, 8)  → 0.876   (0.08%/8h ≈ same annual)
 *   annualizeFundingRate(0.01, 24)   → 3.65    (1%/day ≈ 365%/yr)
 *
 * Throws on a non-finite rate or a non-finite/≤0 interval — a missing or
 * malformed interval must FAIL, never silently annualize as if hourly.
 */
export function annualizeFundingRate(ratePerInterval: number, intervalHours: number): number {
  if (typeof ratePerInterval !== 'number' || !Number.isFinite(ratePerInterval)) {
    throw new Error(`annualizeFundingRate: ratePerInterval must be a finite number, got ${String(ratePerInterval)}`);
  }
  if (typeof intervalHours !== 'number' || !Number.isFinite(intervalHours) || intervalHours <= 0) {
    throw new Error(`annualizeFundingRate: intervalHours must be a finite positive number of hours, got ${String(intervalHours)}`);
  }
  return ratePerInterval * (24 / intervalHours) * 365;
}
