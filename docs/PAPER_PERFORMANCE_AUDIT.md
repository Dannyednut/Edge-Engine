# Paper-Performance Audit — Updated Oct 29, 2026

## Executive summary

This audit was originally written on Oct 13, 2026 and previously updated on Oct 17, 2026. This revision brings the document into agreement with the current PR #3 head, in which the paper trader is now **fully integrated** with the tested accounting/engine modules (this was previously listed as a future migration path), and two supervisor follow-ups have been applied:

1. **VOOI HTTP/data failures are now visible.** The adapter previously converted every non-2xx response into `{ items: [], total: 0 }`, so a 429/500 looked like "no opportunities." It now throws a typed `VooiScanError` that `runScan` records in `result.errors`, and validates the response shape.
2. **The APR configuration mismatch is fixed.** The script loaded `PAPER_HLP_APR` / `PAPER_KHYPE_APR` from the environment but a fresh baseline in `runScan` hardcoded `0.30` / `0.0193`. The env knobs are now parsed by a fail-closed `parseAprConfig()` and passed as validated `initialAprs` into `runScan`.

The paper trader's reported performance should NOT be cited as evidence of strategy viability. Any investor presentation or principal briefing that references paper-trader figures must include this audit's caveats.

---

## A. Original audit issues (Oct 13) — fixed and now enforced in tested modules

All eight issues from the original audit remain fixed. Because the live script was rewritten in this PR to use the shared engine, each fix is now enforced in a **unit-tested module** rather than in script-embedded logic:

| # | Issue | Where now enforced |
|---|-------|--------------------|
| 1 | HLP APR lowered 100% → 30% (configurable) | `DEFAULT_V2_APRS.hlp = 0.30` (`packages/scanner/src/lib/paper-trader-engine.ts:225`); overridable via `PAPER_HLP_APR` through `parseAprConfig()` (`:261`) |
| 2 | kHYPE APR corrected 5.1% → 1.93% | `DEFAULT_V2_APRS.khype = 0.0193` (`paper-trader-engine.ts:225`); overridable via `PAPER_KHYPE_APR`; 3× leverage assumption removed |
| 3 | `netProfit <= 0` skip removed — losing trades recorded | `tryRecordArbTrade()` + `runScan` record both outcomes (`paper-trader-accounting.ts`); tested by engine tests 2/10 and accounting "win-rate validity" tests |
| 4 | Slippage model (20% of spread, capped 0.15% of notional) | `calcSlippage()` in `paper-trader-accounting.ts`; 4 dedicated tests |
| 5 | Spread erosion (30% per capture) | `calcSpreadErosion()`; 3 dedicated tests + persistent opportunity tracking (engine test 11) |
| 6 | Funding adverse drift (0.80 factor) | `calcEffectiveFundingSpread()` / `DEFAULT_ADVERSE_DRIFT`; tested in lifecycle suites |
| 7 | Funding reversal (~15%, deterministic hash) | `calcFundingReversal()`; 3 dedicated tests |
| 8 | Opportunity cooldown (1h) + max captures (3) | `checkOpportunityCapture()` / `recordOpportunityCapture()` with **persistent** `opportunityHistory` (survives restarts); engine test 11 + migration-safety tests 15 |

The historical line references to the old pre-integration script are obsolete: that script has been replaced (see §E).

---

## B. Issues fixed by the integration sprint (this PR)

### 1. ✅ Separated accounting categories
**Issue:** All P&L went into a single `realizedPnl` field.
**Fix:** `AccountingState` has separate `arbPnl`, `fundingPnl`, `passiveYieldPnl`, `feesTotal`; `getSummary()` returns the breakdown.

### 2. ✅ Modeled capital allocation
**Issue:** HLP ($5k) and kHYPE ($10k) yield capital was claimed without deduction from available capital.
**Fix:** `CapitalAllocation` tracks `available` / `allocated` (by source) / `reserved` (open funding positions); invariant `available + allocated + reserved = startingCapital + totalPnl` is validated fail-closed.

### 3. ✅ Corrected funding-position lifecycle
**Issue:** 24h funding income was credited instantly on each scan.
**Fix:** Positions open with `maturityMs`, close with actual-hold-time pro-rata P&L (`maturity_reached` / `premature_close` / reversal). Fees are **settled at close**, never double-counted.

### 4. ✅ Conservative yield handling with freshness window
**Issue:** Unverified/stale APRs were credited silently.
**Fix:** `YieldConfig` carries `verified` / `verifiedAt` / `freshnessMs`; `calcPassiveYield()` credits 0 for unverified/stale unless the caller explicitly opts in. **The default remains credit-unverified = disabled.**

### 5. ✅ Fail-closed state validation and V2 state separation
**Issue:** Corrupted/legacy state could be silently replaced by a fresh baseline.
**Fix:** `loadV2State()` (`scripts-explore/paper-trader.mts:59`) aborts on corrupted JSON, missing `opportunityHistory`, or failed `validateState()` — preserving the original file plus a diagnostic copy. V2 state/log paths are separate from V1; V1 files are never written.

### 6. ✅ VOOI HTTP/data failures are visible (supervisor follow-up #2, this revision)
**Issue:** `vooiScan()` in the live script converted EVERY non-2xx response into `{ items: [], total: 0 }` — a 429/500 was indistinguishable from "no opportunities," and the JSON body was used without any shape validation.
**Fix:** The adapter now lives in the engine module with an **injectable fetch** (`vooiScan(baseUrl, params, fetchImpl)`, `paper-trader-engine.ts:149`):
- non-2xx → throws `VooiScanError(kind: 'http', status)` (class at `:70`);
- invalid JSON or malformed shape → throws `VooiScanError(kind: 'shape')` via `validateVooiResponse()` (`:98`), which requires a JSON object body, a REQUIRED `items` array of objects each with a string `asset` and a REQUIRED `pairs` array (both possibly empty — a genuine `{ items: [], total: 0 }` is valid), and finite numeric `total` when present; a response missing `items`, or an item missing `pairs`, is REJECTED (supervisor review regression fix: incomplete responses can no longer pass as "no opportunities");
- valid empty results pass through unchanged — an empty result is only ever a real empty result;
- `runScan` records any thrown failure in `result.errors` (prefixed `Price-spread scan failed:` / `Funding-rate scan failed:`), and the scan summary prints an Errors section.
**Tests:** 32 direct adapter tests in `packages/scanner/test/paper-trader-vooi-adapter.test.ts` — non-2xx (429/500/403), invalid JSON, 14 malformed-shape cases (including the regression set: `{}`, missing `items`, missing `pairs`), valid empty/empty-`pairs`/non-empty pass-through, query serialization, transport isolation, and `runScan` integration. All use an injected mock fetch; no test touches the network.

### 7. ✅ APR configuration mismatch fixed (supervisor follow-up #3, this revision)
**Issue:** The script loaded `.env` "for PAPER_HLP_APR / PAPER_KHYPE_APR" but never used them; a fresh baseline in `runScan` hardcoded `createV2InitialState(0.30, 0.0193)`. Setting the env knobs had no effect — a misleading configuration surface.
**Fix:**
- `parseAprConfig(env)` (`paper-trader-engine.ts:261`) parses the knobs with an injectable env record: absent/empty → documented `DEFAULT_V2_APRS`; present-but-invalid (non-numeric, NaN/Infinity, outside the decimal-fraction range `[0, 2]`) → **throws** instead of silently falling back;
- `validateApr()` (`:236`) enforces finiteness and bounds; `createV2InitialState()` (`:304`) validates both APRs fail-closed before creating a baseline;
- `runScan` accepts `deps.initialAprs` and uses it only on the fresh-baseline path (`:361`); an existing state's yield config is never rewritten by a scan;
- the live script passes `parseAprConfig(process.env)` (`paper-trader.mts:162`) as `initialAprs` (`:173`);
- unverified-yield credit remains disabled by default regardless of APR source (`PAPER_CREDIT_UNVERIFIED === 'true'` strict opt-in).
**Tests:** 18 new tests in `packages/scanner/test/paper-trader-engine.test.ts` (describe 16): defaults, valid overrides, boundary values, 7 invalid-input cases, error-message attribution, `createV2InitialState` bounds, `runScan` wiring (fresh baseline uses `initialAprs`; existing state untouched), and unverified-credit default-off.

---

## C. Remaining known limitations and unverified assumptions

### Unverified assumptions
1. **HLP 30% APR — UNVERIFIED.** `DEFAULT_V2_APRS.hlp = 0.30` is a lowered estimate (was 100%) not verified against a live API. HLP vault APRs are highly variable (-20% to +200% historically). The state labels this yield `'unverified'` and credits 0 unless explicitly opted in via `PAPER_CREDIT_UNVERIFIED=true`.
2. **kHYPE 1.93% APR — STALE.** Verified via DefiLlama on Oct 13, 2026 (4 samples, 1.926–1.929% range); no re-verification has occurred since (and none is authorized in this offline work item). Labeled `'stale'`/`'unverified'` and credited 0 by default.
3. **VOOI API spreads — REAL but execution assumptions are simulated.** Price/funding spreads come from the real VOOI API in past scans. Slippage (20% of spread), erosion (30% per capture), adverse drift (80%), and reversal (15%) are deterministic estimates, not empirically calibrated.
4. **0.1% fee assumption — OPTIMISTIC.** The 10 bps rate is labeled "VOOI atomic" but unverified against actual execution costs.
5. **APR validation bounds are policy, not market data.** The `[0, 2]` (0%–200%) range in `validateApr()` is a sanity envelope; it does not verify that any particular APR is achievable.

### Limitations of the current implementation
1. **No empirical calibration.** Slippage/erosion/drift/reversal parameters remain deterministic estimates.
2. **No position-level risk modeling.** No liquidation risk, margin requirements, or counterparty risk for funding positions.
3. **No multi-asset correlation.** Each trade is treated independently.
4. **Past scans used real API data; this PR's work is offline-only.** No scan, schedule, or live data collection was performed or re-enabled as part of this revision; all new tests are mocked/deterministic.
5. **Yield figures are estimates, not realized income.** Even when credited, passive yield is labeled as an estimate.

### What the audit does NOT claim
- Does NOT claim the paper trader is accurate or profitable.
- Does NOT claim the VOOI API data is wrong (or right) beyond shape validity.
- Does NOT estimate live-trading performance.
- Does NOT authorize running the operational script, enabling a schedule, or collecting live data.

---

## D. Test results (at this head, offline/deterministic)

```
npx vitest run packages/scanner/test/paper-trader-accounting.test.ts   → 52/52 PASS
npx vitest run packages/scanner/test/paper-trader-integration.test.ts  → 22/22 PASS
npx vitest run packages/scanner/test/paper-trader-engine.test.ts       → 54/54 PASS
npx vitest run packages/scanner/test/paper-trader-vooi-adapter.test.ts → 32/32 PASS
Paper-trader total                                                     → 160/160 PASS

npx pnpm -r build      → all workspace packages PASS
npx pnpm -r typecheck  → all workspace packages PASS
npx vitest run         → 1027/1027 PASS (61 test files, repository-wide)
```

### Paper-trader test breakdown (160 tests)

| Test file | Tests | Description |
|---|---|---|
| `paper-trader-accounting.test.ts` | 52 | Pure-function tests: slippage, fees, erosion, arb P&L, funding reversal, yield freshness, capital allocation, trade recording, state persistence |
| `paper-trader-integration.test.ts` | 22 | Integration tests: profitable/losing arbs, funding lifecycle, capital checks, yield handling, repeated scans, restart, invalid inputs |
| `paper-trader-engine.test.ts` | 54 | V2 orchestration with mocked VOOI data, deterministic timestamps, temp filesystem. Includes 5 migration-safety tests + 18 APR-configuration tests (describe 16) |
| `paper-trader-vooi-adapter.test.ts` | 32 | Direct adapter tests: non-2xx, invalid JSON, malformed shapes (incl. missing `items`/`pairs` regressions), valid empty results, query serialization, transport isolation, runScan error recording |
| **Total paper-trader tests** | **160** | |

(The 160 paper-trader tests are a subset of the 1027 repository-wide tests.)

---

## E. Integration status (previously "Migration path")

The migration listed in the Oct 17 revision is **done in this PR** — the live script now:

1. Loads `.env` via the shared fail-closed dotenv helper (`scripts-explore/paper-trader.mts:33`, EM-STRAT-014-C loader-census approved form; `EDGE_EXECUTION_AUTH` exclusion preserved)
2. Imports and calls the tested engine `runScan()` with injected dependencies (`paper-trader.mts:164`)
3. Uses `AccountingState` (V2) with fail-closed load/validate (`paper-trader.mts:59`)
4. Opens/closes funding positions through the lifecycle functions (no instant 24h crediting)
5. Allocates HLP/kHYPE capital via `allocateCapital()` (deducted from available)
6. Defaults `creditUnverified=false` (strict `PAPER_CREDIT_UNVERIFIED === 'true'` opt-in)
7. Prints the `getSummary()` breakdown (arb / funding / passive yield / fees)
8. Parses APR env knobs via `parseAprConfig()` and passes validated `initialAprs` (`paper-trader.mts:162,173`)

V2 state/log files are separate from V1. V1 files are preserved as unaudited historical records and are never modified. One controlled V2 scan was performed earlier under prior authorization; **no scans were run for this revision**.

---

## F. Conclusion

The original audit (Oct 13) identified 8 issues; all are fixed and now enforced in unit-tested modules. The integration sprint wired the live script to the tested accounting/engine modules (V2), made VOOI failures visible, and fixed the APR configuration mismatch. 160 deterministic paper-trader tests pass at this head, within a green 1027-test repository-wide run.

The paper trader's reported performance should STILL NOT be cited as evidence of strategy viability until:
1. The HLP APR is verified against a live API (explicitly not authorized in this offline work item)
2. The kHYPE APR is re-verified (current verification is stale)
3. The slippage/erosion/drift/reversal parameters are empirically calibrated
4. Realized execution data replaces simulated execution assumptions

Until then, the integrated modules provide a tested, fail-closed foundation whose failure modes (corrupt state, API outage, malformed data, invalid config) are surfaced rather than silently absorbed.
