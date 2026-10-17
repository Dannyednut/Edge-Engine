/**
 * paper-trader-accounting.ts — Pure functions for paper-trader P&L accounting.
 * ─────────────────────────────────────────────────────────────────────
 * This module provides testable pure functions for the paper-trader's
 * calculation and accounting logic. The live daemon (scripts-explore/
 * paper-trader.mts) is NOT modified — these functions are designed to be
 * importable by a future refactor of that script.
 *
 * Design principles:
 *   - All functions are pure (no side effects, no I/O, no Date.now()).
 *   - Time is always an explicit parameter (never implicit).
 *   - State is immutable — functions return new state objects.
 *   - P&L categories are separated: arb, funding, passive yield.
 *   - Capital allocation is tracked: available / allocated / reserved.
 *   - Unverified yields are labeled, not silently credited.
 */

// ─── Types ────────────────────────────────────────────────────────────

export type PnlCategory = 'arb' | 'funding' | 'passive_yield';
export type YieldSource = 'hlp' | 'khype';
export type YieldLabel = 'verified' | 'stale' | 'unverified';

export interface YieldConfig {
  source: YieldSource;
  /** APR as a fraction (0.30 = 30%). */
  apr: number;
  /** Capital allocated to this yield source (USD). */
  capitalUsd: number;
  /** Whether the APR has been verified against a live API. */
  verified: boolean;
  /** Epoch ms when the APR was last verified. */
  verifiedAt: number | null;
  /** How long the verification is valid (ms). */
  freshnessMs: number;
}

export interface CapitalAllocation {
  /** Unencumbered capital available for new trades. */
  available: number;
  /** Capital allocated to passive yield positions (by source name). */
  allocated: Record<string, number>;
  /** Capital reserved as margin for open funding positions. */
  reserved: number;
}

export interface ArbTrade {
  strategy: string;
  asset: string;
  notionalUsd: number;
  grossProfitUsd: number;
  slippageUsd: number;
  feesUsd: number;
  netProfitUsd: number;
}

export interface FundingPosition {
  id: string;
  asset: string;
  notionalUsd: number;
  /** 1h funding spread at entry, as a percentage (0.05 = 0.05%/h). */
  entryFundingSpread1hPct: number;
  /** Epoch ms when the position was opened. */
  openedAt: number;
  /** How long the position must be held before it can be closed (ms). */
  maturityMs: number;
  /** Adverse drift factor (0.80 = 80% of initial rate sustained). */
  adverseDriftFactor: number;
  /** Whether the funding rate reversed during the hold. */
  reversed: boolean;
  /** Entry fees in USD. */
  feesUsd: number;
}

export interface AccountingState {
  startingCapital: number;
  /** P&L from arbitrage trades (VOOI price spread, etc.). */
  arbPnl: number;
  /** P&L from funding rate arbitrage (realized on position close). */
  fundingPnl: number;
  /** P&L from passive yield (HLP, kHYPE — labeled, not necessarily realized). */
  passiveYieldPnl: number;
  /** Total fees paid across all categories. */
  feesTotal: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  /** Open funding positions awaiting maturity. */
  openFundingPositions: FundingPosition[];
  /** Capital allocation state. */
  capital: CapitalAllocation;
  /** Yield source configurations. */
  yields: Record<YieldSource, YieldConfig>;
  /** Epoch ms when state was last saved (set by the I/O layer, not by pure functions). */
  lastUpdate?: number;
}

// ─── Constants ────────────────────────────────────────────────────────

/** 5-minute scan interval in ms (288 scans/day). */
export const SCAN_INTERVAL_MS = 5 * 60 * 1000;

/** 24 hours in ms. */
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Default funding position maturity (24h). */
export const DEFAULT_FUNDING_MATURITY_MS = ONE_DAY_MS;

/** Default adverse drift factor (80% of initial rate sustained). */
export const DEFAULT_ADVERSE_DRIFT = 0.80;

/** Default funding reversal rate (~15% of positions). */
export const DEFAULT_REVERSAL_RATE = 0.15;

/** Default spread erosion factor (30% reduction per capture). */
export const DEFAULT_EROSION_FACTOR = 0.70;

/** Default slippage as fraction of spread (20%). */
export const DEFAULT_SLIPPAGE_FRACTION = 0.20;

/** Default slippage cap (0.15% of notional). */
export const DEFAULT_SLIPPAGE_CAP_PCT = 0.15;

/** Default fee rate (0.1% = 10 bps). */
export const DEFAULT_FEE_BPS = 10;

// ─── Pure calculation functions ───────────────────────────────────────

/**
 * Calculate slippage for a given notional and spread.
 * Slippage = min(cap, spread * fraction) * notional / 100.
 */
export function calcSlippage(
  notionalUsd: number,
  spreadPct: number,
  fraction: number = DEFAULT_SLIPPAGE_FRACTION,
  capPct: number = DEFAULT_SLIPPAGE_CAP_PCT,
): { slippagePct: number; slippageUsd: number } {
  const slippagePct = Math.min(capPct, spreadPct * fraction);
  const slippageUsd = notionalUsd * slippagePct / 100;
  return { slippagePct, slippageUsd };
}

/**
 * Calculate fees for a given notional and fee rate in basis points.
 */
export function calcFees(notionalUsd: number, feeBps: number = DEFAULT_FEE_BPS): number {
  return notionalUsd * feeBps / 10000;
}

/**
 * Calculate the effective spread after erosion from repeated captures.
 * Each capture reduces the available spread by (1 - erosionFactor).
 */
export function calcSpreadErosion(
  originalSpreadPct: number,
  captureCount: number,
  erosionFactor: number = DEFAULT_EROSION_FACTOR,
): number {
  return originalSpreadPct * Math.pow(erosionFactor, captureCount);
}

/**
 * Calculate net profit for an arb trade.
 * netProfit = grossProfit - slippage - fees.
 */
export function calcArbNetProfit(
  grossProfitUsd: number,
  slippageUsd: number,
  feesUsd: number,
): number {
  return grossProfitUsd - slippageUsd - feesUsd;
}

/**
 * Calculate gross profit for a spread arb.
 * grossProfit = notional * spreadPct / 100.
 */
export function calcArbGrossProfit(notionalUsd: number, spreadPct: number): number {
  return notionalUsd * spreadPct / 100;
}

/**
 * Deterministically determine whether a funding position experiences
 * a rate reversal. Based on a hash of the asset name so it is
 * reproducible (not random).
 */
export function calcFundingReversal(
  asset: string,
  reversalRate: number = DEFAULT_REVERSAL_RATE,
): boolean {
  const hash = asset.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
  return (Math.abs(hash) % 100) / 100 < reversalRate;
}

/**
 * Calculate the effective funding spread for a position, accounting
 * for adverse drift and potential reversal.
 *
 * @param entrySpread1hPct  The 1h funding spread at entry (percentage).
 * @param adverseDriftFactor  Fraction of initial rate sustained (0.80 = 80%).
 * @param reversed  Whether the funding rate reversed.
 * @returns The effective 1h funding spread (percentage), negative if reversed.
 */
export function calcEffectiveFundingSpread(
  entrySpread1hPct: number,
  adverseDriftFactor: number,
  reversed: boolean,
): number {
  const adjusted = entrySpread1hPct * adverseDriftFactor;
  return reversed ? -adjusted : adjusted;
}

/**
 * Calculate funding income for a position over a given hold period.
 *
 * @param position  The funding position.
 * @param closeAt  Epoch ms when the position is closed.
 * @returns Object with grossIncome, netIncome, isMature, holdHours.
 */
export function calcFundingIncome(
  position: FundingPosition,
  closeAt: number,
): { grossIncomeUsd: number; netIncomeUsd: number; isMature: boolean; holdHours: number } {
  const holdMs = closeAt - position.openedAt;
  const holdHours = holdMs / (60 * 60 * 1000);
  const isMature = holdMs >= position.maturityMs;

  const effectiveSpread = calcEffectiveFundingSpread(
    position.entryFundingSpread1hPct,
    position.adverseDriftFactor,
    position.reversed,
  );

  // Income = notional * spread% * holdHours
  const grossIncomeUsd = position.notionalUsd * effectiveSpread / 100 * holdHours;
  const netIncomeUsd = grossIncomeUsd - position.feesUsd;

  return { grossIncomeUsd, netIncomeUsd, isMature, holdHours };
}

/**
 * Check whether a yield config's verification is still fresh.
 */
export function checkYieldFreshness(
  config: YieldConfig,
  now: number,
): { isStale: boolean; label: YieldLabel } {
  if (!config.verified || config.verifiedAt === null) {
    return { isStale: true, label: 'unverified' };
  }
  if (now - config.verifiedAt > config.freshnessMs) {
    return { isStale: true, label: 'stale' };
  }
  return { isStale: false, label: 'verified' };
}

/**
 * Calculate passive yield for a single scan interval.
 *
 * If the yield is unverified or stale, returns 0 and labels it.
 * The caller can choose to credit 0 (conservative default) or credit
 * the yield with a label (if explicitly opted in).
 *
 * @param config  Yield source configuration.
 * @param scanIntervalMs  Time elapsed since last scan (ms).
 * @param now  Current epoch ms.
 * @param creditUnverified  If false (default), unverified/stale yields return 0.
 * @returns Object with yieldUsd, isVerified, label.
 */
export function calcPassiveYield(
  config: YieldConfig,
  scanIntervalMs: number,
  now: number,
  creditUnverified: boolean = false,
): { yieldUsd: number; isVerified: boolean; label: YieldLabel } {
  const { isStale, label } = checkYieldFreshness(config, now);

  if (isStale && !creditUnverified) {
    return { yieldUsd: 0, isVerified: false, label };
  }

  // Daily yield = capital * APR / 365
  // Per-scan yield = daily yield * (scanIntervalMs / ONE_DAY_MS)
  const dailyYield = config.capitalUsd * config.apr / 365;
  const yieldUsd = dailyYield * (scanIntervalMs / ONE_DAY_MS);

  return { yieldUsd, isVerified: !isStale, label };
}

// ─── Capital allocation ───────────────────────────────────────────────

/**
 * Get the total capital (available + allocated + reserved).
 */
export function getTotalCapital(state: AccountingState): number {
  const allocatedTotal = Object.values(state.capital.allocated).reduce((a, b) => a + b, 0);
  return state.capital.available + allocatedTotal + state.capital.reserved;
}

/**
 * Get the available capital for new trades.
 */
export function getAvailableCapital(state: AccountingState): number {
  return state.capital.available;
}

/**
 * Allocate capital to a passive yield position. Reduces available,
 * increases allocated[source].
 */
export function allocateCapital(
  state: AccountingState,
  source: string,
  amount: number,
): AccountingState {
  if (amount > state.capital.available) {
    throw new Error(`Insufficient available capital: need ${amount}, have ${state.capital.available}`);
  }
  const prevAllocated = state.capital.allocated[source] ?? 0;
  return {
    ...state,
    capital: {
      ...state.capital,
      available: state.capital.available - amount,
      allocated: { ...state.capital.allocated, [source]: prevAllocated + amount },
    },
  };
}

/**
 * Release capital from a passive yield position. Increases available,
 * decreases allocated[source].
 */
export function releaseCapital(
  state: AccountingState,
  source: string,
  amount: number,
): AccountingState {
  const prevAllocated = state.capital.allocated[source] ?? 0;
  if (amount > prevAllocated) {
    throw new Error(`Cannot release ${amount} from ${source}: only ${prevAllocated} allocated`);
  }
  const newAllocated = prevAllocated - amount;
  const newAllocatedMap = { ...state.capital.allocated };
  if (newAllocated === 0) {
    delete newAllocatedMap[source];
  } else {
    newAllocatedMap[source] = newAllocated;
  }
  return {
    ...state,
    capital: {
      ...state.capital,
      available: state.capital.available + amount,
      allocated: newAllocatedMap,
    },
  };
}

/**
 * Reserve capital for an open funding position. Reduces available,
 * increases reserved.
 */
export function reserveCapital(
  state: AccountingState,
  amount: number,
): AccountingState {
  if (amount > state.capital.available) {
    throw new Error(`Insufficient available capital to reserve: need ${amount}, have ${state.capital.available}`);
  }
  return {
    ...state,
    capital: {
      ...state.capital,
      available: state.capital.available - amount,
      reserved: state.capital.reserved + amount,
    },
  };
}

/**
 * Release reserved capital (when a funding position closes).
 */
export function releaseReservedCapital(
  state: AccountingState,
  amount: number,
): AccountingState {
  if (amount > state.capital.reserved) {
    throw new Error(`Cannot release ${amount} reserved: only ${state.capital.reserved} reserved`);
  }
  return {
    ...state,
    capital: {
      ...state.capital,
      available: state.capital.available + amount,
      reserved: state.capital.reserved - amount,
    },
  };
}

// ─── Trade recording ──────────────────────────────────────────────────

/**
 * Record an arb trade. Updates arbPnl, feesTotal, trade counts, and
 * available capital.
 */
export function recordArbTrade(state: AccountingState, trade: ArbTrade): AccountingState {
  const isWin = trade.netProfitUsd > 0;
  return {
    ...state,
    arbPnl: state.arbPnl + trade.netProfitUsd,
    feesTotal: state.feesTotal + trade.feesUsd,
    totalTrades: state.totalTrades + 1,
    winningTrades: state.winningTrades + (isWin ? 1 : 0),
    losingTrades: state.losingTrades + (isWin ? 0 : 1),
    capital: {
      ...state.capital,
      available: state.capital.available + trade.netProfitUsd,
    },
  };
}

/**
 * Open a funding position. Reserves capital, records the position.
 * Does NOT credit any P&L — income is only realized on close.
 */
export function openFundingPosition(
  state: AccountingState,
  pos: Omit<FundingPosition, 'id' | 'openedAt'>,
  now: number,
): { state: AccountingState; positionId: string } {
  const positionId = `fund-${now}-${pos.asset}`;
  const fullPos: FundingPosition = { ...pos, id: positionId, openedAt: now };

  // Reserve the notional as margin
  const reserved = reserveCapital(state, pos.notionalUsd);

  return {
    state: {
      ...reserved,
      openFundingPositions: [...reserved.openFundingPositions, fullPos],
    },
    positionId,
  };
}

/**
 * Close a funding position. Calculates realized P&L based on actual hold
 * time, releases reserved capital, and records the trade.
 *
 * If the position is not yet mature (holdMs < maturityMs), the P&L is
 * calculated pro-rata for the actual hold time and the close reason is
 * 'premature_close' (not 'maturity_reached').
 */
export function closeFundingPosition(
  state: AccountingState,
  positionId: string,
  closeAt: number,
): { state: AccountingState; pnl: number; isMature: boolean; closeReason: string } {
  const pos = state.openFundingPositions.find(p => p.id === positionId);
  if (!pos) {
    throw new Error(`Funding position not found: ${positionId}`);
  }

  const { netIncomeUsd, isMature } = calcFundingIncome(pos, closeAt);
  const closeReason = isMature ? 'maturity_reached' : 'premature_close';

  // Release reserved capital + add P&L
  let newState = releaseReservedCapital(state, pos.notionalUsd);
  newState = {
    ...newState,
    fundingPnl: newState.fundingPnl + netIncomeUsd,
    feesTotal: newState.feesTotal + pos.feesUsd,
    totalTrades: newState.totalTrades + 1,
    winningTrades: newState.winningTrades + (netIncomeUsd > 0 ? 1 : 0),
    losingTrades: newState.losingTrades + (netIncomeUsd > 0 ? 0 : 1),
    capital: {
      ...newState.capital,
      available: newState.capital.available + netIncomeUsd,
    },
    openFundingPositions: newState.openFundingPositions.filter(p => p.id !== positionId),
  };

  return { state: newState, pnl: netIncomeUsd, isMature, closeReason };
}

/**
 * Credit passive yield for a scan interval. Updates passiveYieldPnl
 * and available capital.
 */
export function creditPassiveYield(
  state: AccountingState,
  _source: YieldSource,
  yieldUsd: number,
): AccountingState {
  return {
    ...state,
    passiveYieldPnl: state.passiveYieldPnl + yieldUsd,
    capital: {
      ...state.capital,
      available: state.capital.available + yieldUsd,
    },
  };
}

// ─── Summary functions ────────────────────────────────────────────────

/**
 * Get total realized P&L across all categories.
 */
export function getTotalPnl(state: AccountingState): number {
  return state.arbPnl + state.fundingPnl + state.passiveYieldPnl;
}

/**
 * Get the win rate as a fraction (0.0 - 1.0).
 */
export function getWinRate(state: AccountingState): number {
  if (state.totalTrades === 0) return 0;
  return state.winningTrades / state.totalTrades;
}

/**
 * Get ROI as a fraction (0.0 = 0%, 1.0 = 100%).
 */
export function getRoi(state: AccountingState): number {
  return getTotalPnl(state) / state.startingCapital;
}

/**
 * Get a summary of the accounting state, separating P&L by category.
 */
export function getSummary(state: AccountingState) {
  return {
    startingCapital: state.startingCapital,
    totalCapital: getTotalCapital(state),
    availableCapital: getAvailableCapital(state),
    reservedCapital: state.capital.reserved,
    allocatedCapital: Object.entries(state.capital.allocated).map(([source, amount]) => ({
      source,
      amount,
    })),
    pnl: {
      arb: state.arbPnl,
      funding: state.fundingPnl,
      passiveYield: state.passiveYieldPnl,
      total: getTotalPnl(state),
    },
    fees: state.feesTotal,
    trades: {
      total: state.totalTrades,
      winning: state.winningTrades,
      losing: state.losingTrades,
      winRate: getWinRate(state),
    },
    openFundingPositions: state.openFundingPositions.length,
    roi: getRoi(state),
  };
}

// ─── State initialization ─────────────────────────────────────────────

/**
 * Create an initial AccountingState with starting capital and yield configs.
 */
export function createInitialState(
  startingCapital: number,
  yields: Record<YieldSource, YieldConfig>,
): AccountingState {
  return {
    startingCapital,
    arbPnl: 0,
    fundingPnl: 0,
    passiveYieldPnl: 0,
    feesTotal: 0,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    openFundingPositions: [],
    capital: {
      available: startingCapital,
      allocated: {},
      reserved: 0,
    },
    yields,
  };
}

// ─── Input validation ────────────────────────────────────────────────

/**
 * Check if a number is a valid positive finite financial amount.
 */
export function isValidPositiveAmount(n: number): boolean {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * Check if a number is a valid non-negative finite financial amount.
 */
export function isValidNonNegativeAmount(n: number): boolean {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * Validate an AccountingState for financial invariants.
 * Throws on invalid inputs.
 */
export function validateState(state: AccountingState): void {
  if (!isValidNonNegativeAmount(state.startingCapital)) {
    throw new Error(`Invalid startingCapital: ${state.startingCapital}`);
  }
  if (!isValidNonNegativeAmount(state.arbPnl)) {
    throw new Error(`Invalid arbPnl: ${state.arbPnl}`);
  }
  // arbPnl can be negative (losing trades), so we check finiteness only
  if (!Number.isFinite(state.arbPnl)) {
    throw new Error(`Non-finite arbPnl: ${state.arbPnl}`);
  }
  if (!Number.isFinite(state.fundingPnl)) {
    throw new Error(`Non-finite fundingPnl: ${state.fundingPnl}`);
  }
  if (!Number.isFinite(state.passiveYieldPnl)) {
    throw new Error(`Non-finite passiveYieldPnl: ${state.passiveYieldPnl}`);
  }
  if (!isValidNonNegativeAmount(state.feesTotal)) {
    throw new Error(`Invalid feesTotal: ${state.feesTotal}`);
  }
  if (!isValidNonNegativeAmount(state.capital.available)) {
    throw new Error(`Invalid available capital: ${state.capital.available}`);
  }
  if (!isValidNonNegativeAmount(state.capital.reserved)) {
    throw new Error(`Invalid reserved capital: ${state.capital.reserved}`);
  }
  for (const [source, amount] of Object.entries(state.capital.allocated)) {
    if (!isValidNonNegativeAmount(amount)) {
      throw new Error(`Invalid allocated amount for ${source}: ${amount}`);
    }
  }
}

/**
 * Try to record an arb trade, checking available capital first.
 * Returns { ok: true, state } on success, { ok: false, reason } if
 * insufficient capital or invalid inputs.
 *
 * The notional is NOT reserved (arb trades are instant in/out), but we
 * check that available capital is sufficient to cover the notional as
 * a risk gate — if the trade goes to zero, the capital must exist.
 */
export function tryRecordArbTrade(
  state: AccountingState,
  trade: ArbTrade,
): { ok: true; state: AccountingState } | { ok: false; reason: string } {
  // Validate inputs
  if (!isValidPositiveAmount(trade.notionalUsd)) {
    return { ok: false, reason: `Invalid notionalUsd: ${trade.notionalUsd}` };
  }
  if (!Number.isFinite(trade.grossProfitUsd)) {
    return { ok: false, reason: `Non-finite grossProfitUsd: ${trade.grossProfitUsd}` };
  }
  if (!Number.isFinite(trade.slippageUsd) || trade.slippageUsd < 0) {
    return { ok: false, reason: `Invalid slippageUsd: ${trade.slippageUsd}` };
  }
  if (!isValidNonNegativeAmount(trade.feesUsd)) {
    return { ok: false, reason: `Invalid feesUsd: ${trade.feesUsd}` };
  }
  if (!Number.isFinite(trade.netProfitUsd)) {
    return { ok: false, reason: `Non-finite netProfitUsd: ${trade.netProfitUsd}` };
  }

  // Check available capital — the notional must be covered
  if (state.capital.available < trade.notionalUsd) {
    return {
      ok: false,
      reason: `Insufficient available capital: need $${trade.notionalUsd}, have $${state.capital.available}`,
    };
  }

  return { ok: true, state: recordArbTrade(state, trade) };
}

/**
 * Try to open a funding position, checking available capital first.
 * Returns { ok: true, state, positionId } on success, { ok: false, reason } if
 * insufficient capital or invalid inputs.
 */
export function tryOpenFundingPosition(
  state: AccountingState,
  pos: Omit<FundingPosition, 'id' | 'openedAt'>,
  now: number,
): { ok: true; state: AccountingState; positionId: string } | { ok: false; reason: string } {
  // Validate inputs
  if (!isValidPositiveAmount(pos.notionalUsd)) {
    return { ok: false, reason: `Invalid notionalUsd: ${pos.notionalUsd}` };
  }
  if (!Number.isFinite(pos.entryFundingSpread1hPct)) {
    return { ok: false, reason: `Non-finite entryFundingSpread1hPct: ${pos.entryFundingSpread1hPct}` };
  }
  if (!isValidNonNegativeAmount(pos.maturityMs)) {
    return { ok: false, reason: `Invalid maturityMs: ${pos.maturityMs}` };
  }
  if (!Number.isFinite(pos.adverseDriftFactor) || pos.adverseDriftFactor < 0 || pos.adverseDriftFactor > 1) {
    return { ok: false, reason: `Invalid adverseDriftFactor: ${pos.adverseDriftFactor}` };
  }
  if (!isValidNonNegativeAmount(pos.feesUsd)) {
    return { ok: false, reason: `Invalid feesUsd: ${pos.feesUsd}` };
  }
  if (!Number.isFinite(now) || now < 0) {
    return { ok: false, reason: `Invalid timestamp: ${now}` };
  }

  // Check available capital
  if (state.capital.available < pos.notionalUsd) {
    return {
      ok: false,
      reason: `Insufficient available capital: need $${pos.notionalUsd}, have $${state.capital.available}`,
    };
  }

  // Check for duplicate position ID (shouldn't happen with timestamp-based IDs
  // but guard against it)
  const positionId = `fund-${now}-${pos.asset}`;
  if (state.openFundingPositions.some(p => p.id === positionId)) {
    return { ok: false, reason: `Duplicate position ID: ${positionId}` };
  }

  const result = openFundingPosition(state, pos, now);
  return { ok: true, state: result.state, positionId: result.positionId };
}

/**
 * Close all mature funding positions at the given time.
 * Returns the updated state and a list of closed positions with their P&L.
 */
export function closeMatureFundingPositions(
  state: AccountingState,
  now: number,
): { state: AccountingState; closed: { positionId: string; pnl: number; isMature: boolean; closeReason: string }[] } {
  let currentState = state;
  const closed: { positionId: string; pnl: number; isMature: boolean; closeReason: string }[] = [];

  for (const pos of state.openFundingPositions) {
    if (now >= pos.openedAt + pos.maturityMs) {
      const result = closeFundingPosition(currentState, pos.id, now);
      currentState = result.state;
      closed.push({
        positionId: pos.id,
        pnl: result.pnl,
        isMature: result.isMature,
        closeReason: result.closeReason,
      });
    }
  }

  return { state: currentState, closed };
}
