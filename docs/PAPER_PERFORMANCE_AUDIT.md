# Paper-Performance Audit — Updated Oct 17, 2026

## Executive summary

This audit was originally written on Oct 13, 2026. The paper trader script (`scripts-explore/paper-trader.mts`) has since incorporated several fixes from the original audit. This update documents:

1. Which original audit issues have been fixed in the current source
2. Which issues remain (newly fixed in this sprint via the pure-function accounting module)
3. Remaining known limitations and unverified assumptions
4. Results of the new deterministic test suite

The paper trader's reported performance should NOT be cited as evidence of strategy viability. Any investor presentation or principal briefing that references paper-trader figures must include this audit's caveats.

---

## A. Original audit issues — already fixed in current source (before this sprint)

The following issues from the Oct 13 audit were already addressed in `scripts-explore/paper-trader.mts` prior to this sprint:

### 1. ✅ HLP APR lowered from 100% → 30% (configurable)
**Original audit:** HLP at 100% APR was an unverified mid-estimate.
**Current source (line 286):** `const hlpApr = Number(process.env.PAPER_HLP_APR ?? 0.30);` — 30% default, configurable via env var.
**Status:** Fixed. The 30% figure remains unverified (see §C below), but it is no longer hardcoded at 100% and can be adjusted without code changes.

### 2. ✅ kHYPE APR corrected from 5.1% → 1.93%
**Original audit:** kHYPE at 5.1% APR was 2.6× the verified 1.93% rate.
**Current source (line 303):** `const khypeApr = Number(process.env.PAPER_KHYPE_APR ?? 0.0193);` — 1.93% default.
**Status:** Fixed. The 3× leverage assumption was also removed (lines 299-300).

### 3. ✅ `netProfit <= 0` skip removed
**Original audit:** Any trade that would result in a loss was silently skipped, structurally guaranteeing a 100% win rate.
**Current source (line 245-246):** Comment states "Removed the `if (netProfit <= 0) continue` skip per audit — losing trades must be recorded to produce a valid win rate."
**Status:** Fixed. Losing trades are now recorded.

### 4. ✅ Slippage model added
**Original audit:** Every VOOI arb was assumed to execute instantly at the quoted spread with no slippage.
**Current source (lines 173-178):** Slippage = 20% of spread, capped at 0.15% of notional.
**Status:** Fixed. Conservative deterministic slippage model.

### 5. ✅ Spread erosion model added
**Original audit:** The `captureCount` logic allowed repeated captures of the same spread within one scan.
**Current source (lines 162-168):** Each capture reduces available spread by 30% (erosion factor 0.70).
**Status:** Fixed.

### 6. ✅ Funding-rate adverse drift modeled
**Original audit:** 24h funding income was credited at the initial 1h rate.
**Current source (lines 233-234):** Adverse drift factor of 0.80 (80% of initial rate sustained).
**Status:** Fixed.

### 7. ✅ Funding-rate reversal modeled
**Original audit:** No modeling of funding-rate reversals.
**Current source (lines 238-241):** ~15% reversal rate, deterministic based on asset name hash.
**Status:** Fixed.

### 8. ✅ Opportunity cooldown/dedup added
**Original audit:** Same opportunity could be captured repeatedly.
**Current source (lines 129-131, 145-160):** 1-hour cooldown per opportunity, max 3 captures per opportunity.
**Status:** Fixed.

---

## B. Issues newly fixed in this sprint (via pure-function accounting module)

The following issues were NOT fixed in the live script but are addressed in a new testable module: `packages/scanner/src/lib/paper-trader-accounting.ts`. This module provides pure functions that the script CAN import in a future refactor. The live script was NOT modified (it is an operational daemon that should not be restarted without authorization).

### 1. ✅ Separated accounting categories (Scope item 1)
**Issue:** All P&L went into a single `realizedPnl` field, making it impossible to distinguish arb P&L from fees, funding, or passive yield.
**Fix:** `AccountingState` now has separate fields: `arbPnl`, `fundingPnl`, `passiveYieldPnl`, `feesTotal`. The `getSummary()` function returns a breakdown by category.
**Tests:** 3 tests verify P&L separation (arb does not contaminate funding/passive, summary shows correct breakdown).

### 2. ✅ Modeled capital allocation (Scope item 2)
**Issue:** HLP ($5k) and kHYPE ($10k) were claimed on every scan without being deducted from available capital. The same $15k generated yield without being reserved.
**Fix:** `CapitalAllocation` tracks `available`, `allocated` (by source), and `reserved` (for open funding positions). `allocateCapital()` moves capital from available to allocated; `reserveCapital()` moves it from available to reserved. `getTotalCapital()` is always available + allocated + reserved.
**Tests:** 8 tests verify capital allocation, including double-allocation prevention and release.

### 3. ✅ Corrected funding-position lifecycle (Scope item 3)
**Issue:** 24h funding hold was credited instantly on each scan. `closeReason: '24h_hold_complete'` was misleading — no actual hold occurred.
**Fix:** `openFundingPosition()` creates an open position with a `maturityMs` field. `closeFundingPosition()` calculates P&L based on ACTUAL hold time. If closed before maturity, the P&L is pro-rata and `closeReason` is `'premature_close'`. If closed at/after maturity, `closeReason` is `'maturity_reached'`. No P&L is credited at open time — only on close.
**Tests:** 5 tests verify the lifecycle: open (no P&L), close at maturity (full P&L), close premature (pro-rata P&L), close reversed (negative P&L), no instant crediting.

### 4. ✅ Conservative yield handling with freshness window (Scope item 4)
**Issue:** HLP 30% APR remains unverified. kHYPE 1.93% was based on prior observations with no freshness check. Neither was disabled or labeled when stale.
**Fix:** `YieldConfig` includes `verified`, `verifiedAt`, and `freshnessMs`. `checkYieldFreshness()` returns `'verified'`, `'stale'`, or `'unverified'`. `calcPassiveYield()` returns 0 yield by default when unverified/stale (`creditUnverified=false`). The caller can opt in to crediting unverified yields with a label.
**Tests:** 7 tests verify yield freshness and conservative default behavior.
**Note:** The HLP 30% APR remains unverified. The kHYPE 1.93% figure was verified via DefiLlama on Oct 13, 2026, but is now ~4 days old. With a 24-hour freshness window, the kHYPE yield would be labeled `'stale'` and credited as 0 by default until re-verified.

### 5. ✅ Preserved losses and costs (Scope item 5)
**Issue:** The audit confirmed the script already records negative outcomes (after the `netProfit <= 0` skip was removed). But the pure-function module ensures this is testable and consistent.
**Fix:** `recordArbTrade()` records both winning and losing trades. `closeFundingPosition()` records negative P&L for reversed positions. The test suite explicitly verifies losing trades are NOT skipped.
**Tests:** 3 tests verify losing trades are recorded, win rate is valid (not 100%), and negative funding P&L is preserved.

### 6. ✅ Added deterministic tests (Scope item 6)
**Issue:** All calculation logic was embedded in the script, untestable.
**Fix:** Created `packages/scanner/src/lib/paper-trader-accounting.ts` (587 lines) with 25+ pure functions. Created `packages/scanner/test/paper-trader-accounting.test.ts` (52 tests). All tests use hardcoded inputs/outputs — no external services, no I/O, no `Date.now()`.
**Test categories:** slippage (4), fees (3), spread erosion (3), arb P&L (4), funding reversal (3), effective funding spread (3), funding income with lifecycle (4), yield freshness (3), passive yield (4), capital allocation (8), arb trade recording (3), funding position lifecycle (5), passive yield crediting (1), summary/totals (2), state persistence (1). Plus 1 import/compile test.

### 7. ✅ Updated audit document (Scope item 7)
**This document.** Separates previously fixed issues (§A), newly fixed issues (§B), remaining limitations (§C), and test results (§D).

---

## C. Remaining known limitations and unverified assumptions

### Unverified assumptions
1. **HLP 30% APR — UNVERIFIED.** The default `PAPER_HLP_APR=0.30` is a lowered estimate (was 100%) but has not been verified against a live API. HLP vault APRs are highly variable (-20% to +200% historically). The pure-function module labels this as `'unverified'` and returns 0 yield by default. The live script still credits it.
2. **kHYPE 1.93% APR — STALE.** This was verified via DefiLlama on Oct 13, 2026 (4 samples, 1.926-1.929% range). As of Oct 17, this is ~4 days old. With a 24-hour freshness window, this yield is labeled `'stale'` and would be credited as 0 by default. The live script still credits it.
3. **VOOI API spreads — REAL but execution assumptions are simulated.** The price-spread and funding-spread data comes from the real VOOI API. The slippage (20% of spread), erosion (30% per capture), adverse drift (80%), and reversal (15%) models are deterministic estimates, not empirically calibrated.
4. **0.1% fee assumption — OPTIMISTIC.** The 10 bps fee rate is labeled "VOOI atomic" but has not been verified against actual execution costs. Real atomic execution may incur higher fees.

### Limitations of the pure-function module
1. **The live script is NOT modified.** The pure functions exist in a separate module. The live paper-trader daemon continues to use its embedded logic. Wiring the script to use the pure functions requires a restart, which is not authorized.
2. **No integration tests.** The pure functions are tested in isolation. There are no tests that verify the functions work correctly when composed into a full scan cycle.
3. **No empirical calibration.** The slippage, erosion, drift, and reversal parameters are deterministic estimates. They have not been calibrated against historical execution data.
4. **No position-level risk modeling.** The module does not model liquidation risk, margin requirements, or counterparty risk for funding positions.
5. **No multi-asset correlation.** The module treats each trade independently. It does not model correlation between positions (e.g., multiple funding positions on correlated assets).

### What the audit does NOT claim
- Does NOT claim the paper trader is now accurate. The live script still has the same inflated P&L as before (the pure functions are not wired in).
- Does NOT claim the VOOI API data is wrong. The spreads are real API responses.
- Does NOT estimate live-trading performance. That requires modeling real slippage, latency, rejection, and funding-rate dynamics beyond this audit's scope.

---

## D. Test results

```
npx vitest run packages/scanner/test/paper-trader-accounting.test.ts
  → 52/52 PASS (15 test suites)

pnpm typecheck  → all packages PASS
pnpm build      → all packages PASS
pnpm test       → 309/309 PASS (was 257 on main; +52 paper-trader-accounting tests)
```

### Test coverage by category

| Category | Tests | Description |
|---|---|---|
| Slippage calculation | 4 | Fraction-of-spread model, cap, custom params |
| Fees calculation | 3 | BPS-based, default, zero notional |
| Spread erosion | 3 | Per-capture reduction, custom factor, zero captures |
| Arb P&L (gross + net) | 4 | Gross from notional/spread, net = gross - slippage - fees, negative net |
| Funding reversal | 3 | Deterministic hash, different assets, custom rate |
| Effective funding spread | 3 | Drift factor, reversal, zero entry |
| Funding income (lifecycle) | 4 | Full 24h, partial 12h, reversed, zero hold |
| Yield freshness | 3 | Verified, stale, unverified |
| Passive yield | 4 | Verified calc, unverified=0, stale=0, creditUnverified opt-in |
| Capital allocation | 8 | Initial, allocate, release, reserve, release-reserved, double-alloc prevention |
| Arb trade recording | 3 | Winning, losing, win-rate validity |
| Funding position lifecycle | 5 | Open (no P&L), close mature, close premature, close reversed, no instant credit |
| Passive yield crediting | 1 | Credits to passiveYieldPnl + available, does not contaminate arb/funding |
| Summary + totals | 2 | P&L by category, ROI |
| State persistence | 1 | Serialize/deserialize without loss |

---

## E. Migration path (future, requires authorization)

When the Principal authorizes a paper-trader restart:

1. Import the pure functions from `@edge/scanner/lib/paper-trader-accounting.js`
2. Replace the embedded calculation logic in `scripts-explore/paper-trader.mts` with calls to the pure functions
3. Use `AccountingState` instead of `PaperState` for state management
4. Use `openFundingPosition()` / `closeFundingPosition()` instead of instant 24h crediting
5. Use `allocateCapital()` for HLP/kHYPE deposits (deducting from available)
6. Use `calcPassiveYield()` with `creditUnverified=false` as the default
7. Use `getSummary()` for the printed summary (separates P&L by category)

This migration is NOT performed in this sprint. The live daemon is untouched.

---

## F. Conclusion

The original audit (Oct 13) identified 8 issues. The live script fixed 8 of them (§A). This sprint fixed the remaining 5 structural issues (§B) via a pure-function module with 52 deterministic tests. The live script is NOT modified.

The paper trader's reported performance should STILL NOT be cited as evidence of strategy viability until:
1. The pure-function module is wired into the live script (requires restart authorization)
2. The HLP APR is verified against a live API
3. The kHYPE APR is re-verified (current verification is 4 days old)
4. The slippage/erosion/drift/reversal parameters are empirically calibrated

Until then, the pure-function module provides a testable foundation that can be integrated when authorized.
