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
    // No existing state — create fresh V2 baseline
    state = createV2InitialState(0.30, 0.0193);
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
