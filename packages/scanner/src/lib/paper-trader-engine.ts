/**
 * paper-trader-engine.ts — Testable scan orchestration for the paper-trader.
 *
 * This module extracts the paper-trader's scan logic into a pure function
 * with injectable dependencies, enabling end-to-end testing with mocked
 * market data, deterministic timestamps, and temporary filesystem paths.
 *
 * The live script (scripts-explore/paper-trader.mts) imports this engine
 * and wires it to real fetch/Date.now/fs. Tests import the engine and
 * wire it to mocks.
 */

import {
  type AccountingState,
  type ArbTrade,
  type YieldSource,
  type YieldConfig,
  createInitialState,
  allocateCapital,
  tryRecordArbTrade,
  tryOpenFundingPosition,
  closeMatureFundingPositions,
  creditPassiveYield,
  calcPassiveYield,
  calcSlippage,
  calcFees,
  calcSpreadErosion,
  calcArbGrossProfit,
  calcArbNetProfit,
  calcFundingReversal,
  checkOpportunityCapture,
  recordOpportunityCapture,
  makeOpportunityKey,
  getSummary,
  validateState,
  SCAN_INTERVAL_MS,
  ONE_DAY_MS,
  DEFAULT_FUNDING_MATURITY_MS,
  DEFAULT_ADVERSE_DRIFT,
  DEFAULT_FEE_BPS,
} from './paper-trader-accounting.js';

// ─── Types ────────────────────────────────────────────────────────────

/** VOOI API response shape (subset used by the engine). */
export interface VooiItem {
  asset: string;
  pairs: Array<{
    priceSpread?: number;
    fundingSpread1h?: number;
    long?: { exchange?: string; price?: string };
    short?: { exchange?: string; price?: string };
  }>;
}

export interface VooiResponse {
  items?: VooiItem[];
  total?: number;
}

/**
 * Typed failure for the VOOI adapter. Thrown on ANY HTTP or data-shape
 * failure so that `runScan` records it in `result.errors` instead of the
 * failure silently looking like "no opportunities".
 *
 *   kind 'http'  — non-2xx HTTP status (`status` carries the code)
 *   kind 'shape' — invalid JSON body or response shape violates the
 *                  expected `VooiResponse` structure
 */
export class VooiScanError extends Error {
  readonly kind: 'http' | 'shape';
  readonly status?: number;

  constructor(kind: 'http' | 'shape', message: string, status?: number) {
    super(message);
    this.name = 'VooiScanError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Validate a parsed VOOI payload against the shape the engine consumes.
 * Fail-closed: throws `VooiScanError('shape', …)` on any violation rather
 * than tolerating malformed data (a malformed row could silently change
 * accounting inputs).
 *
 * Accepted shape (matching `VooiResponse` / `VooiItem`):
 *   - body must be a non-null object
 *   - `items`, if present, must be an array of non-null objects each with
 *     a string `asset`; each item's `pairs`, if present, must be an array
 *     of non-null objects
 *   - `total`, if present, must be a finite number
 */
export function validateVooiResponse(body: unknown): VooiResponse {
  const shapeFail = (detail: string): VooiScanError =>
    new VooiScanError('shape', `VOOI response shape invalid: ${detail}`);

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw shapeFail('body is not a JSON object');
  }
  const rec = body as Record<string, unknown>;

  if (rec.total !== undefined && (typeof rec.total !== 'number' || !Number.isFinite(rec.total))) {
    throw shapeFail('total is present but not a finite number');
  }

  if (rec.items === undefined) return body as VooiResponse;

  if (!Array.isArray(rec.items)) {
    throw shapeFail('items is present but not an array');
  }
  for (const item of rec.items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw shapeFail('items entry is not a JSON object');
    }
    const itemRec = item as Record<string, unknown>;
    if (typeof itemRec.asset !== 'string') {
      throw shapeFail('items entry is missing a string asset');
    }
    if (itemRec.pairs !== undefined && !Array.isArray(itemRec.pairs)) {
      throw shapeFail('item.pairs is present but not an array');
    }
    if (Array.isArray(itemRec.pairs)) {
      for (const pair of itemRec.pairs) {
        if (pair === null || typeof pair !== 'object' || Array.isArray(pair)) {
          throw shapeFail('item.pairs entry is not a JSON object');
        }
      }
    }
  }
  return body as VooiResponse;
}

/**
 * VOOI arbitrage-scanner adapter.
 *
 * Fail-closed contract (per supervisor follow-up on PR #3):
 *   - non-2xx HTTP status  → throws `VooiScanError('http', …, status)`;
 *     a 429/500 is NEVER mapped to an empty result (which previously made
 *     an API failure look like "no opportunities")
 *   - invalid JSON body    → throws `VooiScanError('shape', …)`
 *   - malformed shape      → throws `VooiScanError('shape', …)`
 *   - valid empty results  → returns `{ items: [], total: 0 }` unchanged
 *
 * `fetchImpl` is injectable so tests run fully offline with a mock fetch;
 * the live script binds the real global fetch.
 */
export async function vooiScan(
  baseUrl: string,
  params: Record<string, unknown>,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<VooiResponse> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  const url = `${baseUrl}/arbitrage-scanner?${q.toString()}`;

  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new VooiScanError(
      'http',
      `VOOI arbitrage-scanner returned HTTP ${res.status} ${res.statusText || ''}`.trim(),
      res.status,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    throw new VooiScanError(
      'shape',
      `VOOI arbitrage-scanner returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return validateVooiResponse(body);
}

/** Dependencies injected into the scan function. All are mockable. */
export interface ScanDependencies {
  /** Fetch price-spread arb opportunities (mockable — no real network calls in tests). */
  fetchPriceSpreadArbs(): Promise<VooiResponse>;
  /** Fetch funding-rate arb opportunities (mockable). */
  fetchFundingArbs(): Promise<VooiResponse>;
  /** Current timestamp (deterministic in tests). */
  now(): number;
  /** Load existing state. Returns null if no state file exists. */
  loadState(): AccountingState | null;
  /** Save state. */
  saveState(state: AccountingState): void;
  /** Append a trade/event to the log. */
  logTrade(entry: Record<string, unknown>): void;
  /** Whether to credit unverified/stale yields (default: false). */
  creditUnverified: boolean;
  /** Scan interval in ms (default: 5 min). */
  scanIntervalMs: number;
  /**
   * Validated APR configuration used ONLY when creating a fresh V2
   * baseline (no existing state). Absent → `DEFAULT_V2_APRS`. The live
   * script passes `parseAprConfig(process.env)` here so the
   * PAPER_HLP_APR / PAPER_KHYPE_APR env knobs actually reach the
   * initial state instead of being silently ignored.
   */
  initialAprs?: V2AprConfig;
}

/**
 * Passive-yield APR configuration for the V2 baseline.
 * Values are decimal-fraction APRs (0.30 = 30%/yr).
 */
export interface V2AprConfig {
  hlp: number;
  khype: number;
}

/**
 * Documented V2 baseline APRs (decimal fractions). HLP 30% remains an
 * UNVERIFIED lowered estimate; kHYPE 1.93% was verified via DefiLlama on
 * Oct 13, 2026 and is now STALE (see docs/PAPER_PERFORMANCE_AUDIT.md §C).
 * Both yields stay `verified: false` in the created state, so with the
 * default `creditUnverified=false` neither is credited until re-verified.
 */
export const DEFAULT_V2_APRS: V2AprConfig = { hlp: 0.30, khype: 0.0193 };

/** APR validation bounds (decimal fraction: 0 = 0%/yr, 2 = 200%/yr). */
export const APR_MIN = 0;
export const APR_MAX = 2;

/**
 * Validate a single APR value. Fail-closed: throws on non-finite numbers
 * or values outside `[APR_MIN, APR_MAX]`. Never silently clamps — a
 * misconfigured APR must abort, not silently change accounting inputs.
 */
export function validateApr(value: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid APR for ${name}: expected a finite number, got ${String(value)}`);
  }
  if (value < APR_MIN || value > APR_MAX) {
    throw new Error(
      `Invalid APR for ${name}: ${value} is outside the accepted decimal-fraction range [${APR_MIN}, ${APR_MAX}]`,
    );
  }
  return value;
}

/**
 * Parse and validate the PAPER_HLP_APR / PAPER_KHYPE_APR environment
 * knobs. `env` is injectable (pass `process.env` in the live script) so
 * tests exercise this fail-closed parser offline.
 *
 * Semantics:
 *   - absent knob            → documented `DEFAULT_V2_APRS` value
 *   - present but invalid    → THROWS (non-numeric, NaN/Infinity, or
 *                              outside [0, 2]) — no silent fallback to
 *                              defaults, which would re-create the very
 *                              config/script mismatch this fixes
 *   - empty/whitespace value → treated as absent (uses default)
 */
export function parseAprConfig(env: Record<string, string | undefined>): V2AprConfig {
  const parseOne = (varName: string, fallback: number): number => {
    const raw = env[varName];
    if (raw === undefined) return fallback;
    const trimmed = raw.trim();
    if (trimmed === '') return fallback;
    const parsed = Number(trimmed);
    return validateApr(parsed, varName);
  };
  return {
    hlp: parseOne('PAPER_HLP_APR', DEFAULT_V2_APRS.hlp),
    khype: parseOne('PAPER_KHYPE_APR', DEFAULT_V2_APRS.khype),
  };
}

/** Result of a scan. */
export interface ScanResult {
  state: AccountingState;
  summary: ReturnType<typeof getSummary>;
  errors: string[];
  arbTradesExecuted: number;
  fundingPositionsOpened: number;
  fundingPositionsClosed: number;
  yieldCredited: { source: string; amount: number; label: string }[];
}

// ─── Constants ────────────────────────────────────────────────────────

const ARB_NOTIONAL = 5000;
const FUNDING_NOTIONAL = 5000;
const MAX_ARBS_PER_SCAN = 3;
const MAX_FUNDING_PER_SCAN = 3;
const MIN_SPREAD_PCT = 0.5;
const MIN_ERODED_SPREAD_PCT = 0.3;
const MIN_FUNDING_APR = 70;
const MAX_FUNDING_APR = 120;

// ─── Factory ──────────────────────────────────────────────────────────

/**
 * Create the initial V2 state with clean $100k baseline and pre-allocated
 * passive yield capital.
 */
export function createV2InitialState(
  hlpApr: number,
  khypeApr: number,
): AccountingState {
  // Fail-closed APR validation — a non-finite or out-of-range APR must
  // abort baseline creation, never silently distort yield accounting.
  validateApr(hlpApr, 'hlpApr');
  validateApr(khypeApr, 'khypeApr');

  const yields: Record<YieldSource, YieldConfig> = {
    hlp: {
      source: 'hlp',
      apr: hlpApr,
      capitalUsd: 5000,
      verified: false,
      verifiedAt: null,
      freshnessMs: ONE_DAY_MS,
    },
    khype: {
      source: 'khype',
      apr: khypeApr,
      capitalUsd: 10000,
      verified: false,
      verifiedAt: null,
      freshnessMs: ONE_DAY_MS,
    },
  };

  let state = createInitialState(100_000, yields);
  state = allocateCapital(state, 'hlp', 5000);
  state = allocateCapital(state, 'khype', 10000);
  return state;
}

// ─── Scan orchestration ───────────────────────────────────────────────

/**
 * Run one paper-trading scan with injectable dependencies.
 *
 * This is the actual V2 orchestration: state load, funding close/open,
 * arbitrage calculation, yield handling, log writes, state writes, and
 * final summary. All external calls go through `deps`.
 */
export async function runScan(deps: ScanDependencies): Promise<ScanResult> {
  const errors: string[] = [];
  const now = deps.now();
  const scanIntervalMs = deps.scanIntervalMs || SCAN_INTERVAL_MS;

  // 1. Load state
  let state: AccountingState;
  const loaded = deps.loadState();
  if (loaded === null) {
    // No existing state — create fresh V2 baseline from the validated APR
    // config (deps.initialAprs, e.g. parseAprConfig(process.env) from the
    // live script) or the documented defaults. The env knobs now actually
    // reach the initial state instead of being silently ignored.
    state = createV2InitialState(
      deps.initialAprs?.hlp ?? DEFAULT_V2_APRS.hlp,
      deps.initialAprs?.khype ?? DEFAULT_V2_APRS.khype,
    );
  } else {
    // Validate existing state — fail closed
    try {
      validateState(loaded);
      state = loaded;
    } catch (e) {
      // Do NOT silently replace with a new baseline.
      // Surface the error and abort.
      throw new Error(
        `V2 state validation failed — aborting scan to prevent state loss. ` +
        `Original state file is NOT modified. Error: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  // 2. Close mature funding positions
  const closeResult = closeMatureFundingPositions(state, now);
  state = closeResult.state;
  const fundingPositionsClosed = closeResult.closed.length;
  for (const c of closeResult.closed) {
    deps.logTrade({
      type: 'funding_close',
      positionId: c.positionId,
      pnl: c.pnl,
      closeReason: c.closeReason,
      isMature: c.isMature,
      feeSettled: true, // fee is settled at close time
    });
  }

  // 3. Scan VOOI price-spread arbs
  let arbTradesExecuted = 0;
  try {
    const vooiResp = await deps.fetchPriceSpreadArbs();
    const seenAssets = new Set<string>();

    for (const item of (vooiResp?.items || [])) {
      if (arbTradesExecuted >= MAX_ARBS_PER_SCAN) break;
      if (seenAssets.has(item.asset)) continue;

      for (const p of (item.pairs || [])) {
        if (arbTradesExecuted >= MAX_ARBS_PER_SCAN) break;
        const spread = (p.priceSpread || 0) * 100;
        if (spread < MIN_SPREAD_PCT) continue;

        // Build stable opportunity key
        const longVenue = p.long?.exchange ?? 'unknown';
        const shortVenue = p.short?.exchange ?? 'unknown';
        const oppKey = makeOpportunityKey(item.asset, longVenue, shortVenue);

        // Check capture history (persistent across restarts)
        const captureCheck = checkOpportunityCapture(state, oppKey, now);
        if (!captureCheck.allowed) {
          continue; // cooldown or max captures
        }

        seenAssets.add(item.asset);

        // Apply spread erosion based on capture count
        const effectiveSpread = calcSpreadErosion(spread, captureCheck.captureCount);
        if (effectiveSpread < MIN_ERODED_SPREAD_PCT) continue;

        // Calculate trade
        const notional = ARB_NOTIONAL;
        const grossProfit = calcArbGrossProfit(notional, effectiveSpread);
        const { slippageUsd } = calcSlippage(notional, effectiveSpread);
        const fees = calcFees(notional, DEFAULT_FEE_BPS);
        const netProfit = calcArbNetProfit(grossProfit, slippageUsd, fees);

        const trade: ArbTrade = {
          strategy: 'VOOI Price Spread Arb',
          asset: item.asset,
          notionalUsd: notional,
          grossProfitUsd: grossProfit,
          slippageUsd,
          feesUsd: fees,
          netProfitUsd: netProfit,
        };

        // Try to record — checks available capital
        const result = tryRecordArbTrade(state, trade);
        if (!result.ok) {
          continue; // insufficient capital
        }
        state = result.state;

        // Record opportunity capture (persists across restarts)
        state = recordOpportunityCapture(state, oppKey, now);

        deps.logTrade({
          type: 'arb',
          strategy: 'VOOI Price Spread Arb',
          asset: item.asset,
          notionalUsd: notional,
          grossProfitUsd: grossProfit,
          slippageUsd,
          feesUsd: fees,
          netProfitUsd: netProfit,
          opportunityKey: oppKey,
          captureCount: captureCheck.captureCount + 1,
        });

        arbTradesExecuted++;
        break; // one arb per asset
      }
    }
  } catch (err) {
    errors.push(`Price-spread scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Scan VOOI funding-rate arbs — OPEN positions (do not credit P&L)
  let fundingPositionsOpened = 0;
  try {
    const vooiFundingResp = await deps.fetchFundingArbs();
    const seenAssets = new Set<string>();

    for (const item of (vooiFundingResp?.items || [])) {
      if (fundingPositionsOpened >= MAX_FUNDING_PER_SCAN) break;
      if (seenAssets.has(item.asset)) continue;

      for (const p of (item.pairs || [])) {
        if (fundingPositionsOpened >= MAX_FUNDING_PER_SCAN) break;
        const spread = (p.fundingSpread1h || 0) * 100;
        const annualApr = spread * 24 * 365;
        if (annualApr < MIN_FUNDING_APR || annualApr > MAX_FUNDING_APR) continue;

        seenAssets.add(item.asset);
        const notional = FUNDING_NOTIONAL;
        const reversed = calcFundingReversal(item.asset);
        const fees = calcFees(notional, DEFAULT_FEE_BPS);

        // Try to open — checks available capital, reserves notional
        const result = tryOpenFundingPosition(
          state,
          {
            asset: item.asset,
            notionalUsd: notional,
            entryFundingSpread1hPct: spread,
            maturityMs: DEFAULT_FUNDING_MATURITY_MS,
            adverseDriftFactor: DEFAULT_ADVERSE_DRIFT,
            reversed,
            feesUsd: fees,
          },
          now,
        );
        if (!result.ok) {
          continue; // insufficient capital or duplicate
        }
        state = result.state;

        deps.logTrade({
          type: 'funding_open',
          positionId: result.positionId,
          asset: item.asset,
          notionalUsd: notional,
          entryFundingSpread1hPct: spread,
          annualApr,
          reversed,
          estimatedFee: fees, // labeled as estimated — settled at close
          feeTiming: 'settled_at_close',
        });

        fundingPositionsOpened++;
        break; // one funding position per asset
      }
    }
  } catch (err) {
    errors.push(`Funding-rate scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5. Credit passive yield (conservative — creditUnverified=false by default)
  const yieldCredited: { source: string; amount: number; label: string }[] = [];
  for (const source of ['hlp', 'khype'] as YieldSource[]) {
    const config = state.yields[source];
    if (!config) continue;
    const yieldResult = calcPassiveYield(config, scanIntervalMs, now, deps.creditUnverified);
    if (yieldResult.yieldUsd > 0) {
      state = creditPassiveYield(state, source, yieldResult.yieldUsd);
      deps.logTrade({
        type: 'passive_yield',
        source,
        yieldUsd: yieldResult.yieldUsd,
        label: yieldResult.label,
        apr: config.apr,
        capitalUsd: config.capitalUsd,
      });
      yieldCredited.push({ source, amount: yieldResult.yieldUsd, label: yieldResult.label });
    } else {
      yieldCredited.push({ source, amount: 0, label: yieldResult.label });
    }
  }

  // 6. Save state
  state.lastUpdate = now;
  deps.saveState(state);

  // 7. Build summary
  const summary = getSummary(state);

  return {
    state,
    summary,
    errors,
    arbTradesExecuted,
    fundingPositionsOpened,
    fundingPositionsClosed,
    yieldCredited,
  };
}
