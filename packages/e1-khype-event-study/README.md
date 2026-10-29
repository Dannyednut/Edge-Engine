# @edge/e1-khype-event-study

EM-STRAT-014-E1 — **offline kHYPE event-study tooling**. Deterministic replay
and depth-at-size model required by EI-STRAT-014 §2 (E-1) so the tools are
validated **before** any future collection authorization.

> **Status / authorization boundary (read this first)**
> This package is OFFLINE TOOLING VALIDATION ONLY. It does NOT establish that
> a profitable dislocation exists and does NOT change `hl_lst_arb`'s
> disposition. No collector is included, no RPC/archive/explorer/live query
> was performed, and no real study manifest exists — the tool refuses
> non-synthetic manifests (`real-study-manifest-not-authorized-EM-STRAT-014-E1`).
> Actual data collection and strategy promotion remain unauthorized and
> pending E-10 results plus separate Instructor authorization.

## What is here

```
src/
  math/bigint-math.ts      exact mulDiv (floor/ceil), floorDiv, isqrt, gcd
  math/rational.ts         exact rationals; canonical 12-dp truncated decimals + "num/den"
  v3/tick-math.ts          local exact-rational TickMath (declared convention, see A4)
  v3/tick-walk.ts          fail-closed V3 tick-walk quote / depth-at-size model
  study/manifest.ts        pre-registration schema; REQUIRED N & D; synthetic gate
  study/raw-archive.ts     raw JSONL decoding (hex scalars as eth_call returns them)
  study/discount-series.ts d-series with counted exclusions; NO interpolation
  study/events.ts          excursions, pre-registered independence rule, pass eval
  study/report.ts          pass-rule report + assumption register + limitations
  study/canonical.ts       canonical JSON (sorted keys, safe integers only)
  replay.ts                pure orchestrator: manifest + raws -> canonical report
  cli/replay.ts            CLI wrapper (reads files, prints canonical JSON)
  fixtures/synthetic-generator.ts  deterministic synthetic fixture generator
fixtures/synthetic-48h/    committed fixtures + PROVENANCE.md (machine-verified)
test/                      E1-T1..T9, T11, conventions, fail-closed, provenance
```

## Design contracts

1. **Conventions are pinned, not inferred.** The study uses the CODE
   convention (`hl-lst-arb-scanner.ts` lineage): `marketPrice` = slot0 price
   in **kHYPE per WHYPE**, `anchorRate` = `Accountant.kHYPEToHYPE(1e18)/1e18`
   (HYPE per kHYPE), `d = marketPrice * anchorRate - 1`, `d > 0` = kHYPE
   below redemption value (discount). The inverse form `1 - price *
   anchorRate` is equivalent ONLY with correspondingly inverted inputs; the
   manifest's convention strings are compared exactly, so silent
   re-interpretation (the orientation trap) is impossible.
2. **`WHYPE ≈ HYPE` is recorded as an assumption** (`ASSUMPTION_NOT_FACT`),
   never asserted as a fact (report assumption A1).
3. **No view-quoter reuse.** The repository's view-quoter has no chain-999
   deployment (EI-STRAT-014 §2.2), so depth comes from a local BigInt-exact
   tick-walk over recorded `slot0` + `liquidity` + tick data at the same
   block. The package imports nothing from `packages/scanner` (enforced by
   test).
4. **Determinism by construction.** No clock, no randomness, no floating
   point anywhere in the pipeline; all measured quantities are exact
   BigInt rationals serialized as fixed 12-dp truncated decimals plus full
   `num/den` fractions. E1-T9 proves byte-identical canonical output across
   two fresh processes.
5. **Fail-closed everywhere.** Missing/invalid anchor → sample excluded
   (`anchor_unusable`, no interpolation, no carry-forward, contiguity
   broken); inconsistent slot0/liquidity/tick state → excluded with reason;
   zero liquidity → no quote (`no_liquidity`); input exceeding recorded
   liquidity → `zero_liquidity_below` (never clamped); manifest missing N/D
   → refused. Exclusions are counted and reasoned in the report — never
   silently dropped.
6. **Pre-registered event semantics.** Excursion = contiguous run with
   `d > grossEventThresholdPct`. Two excursions merge into ONE event unless
   separated by a usable sample with `|d| < independenceBandPct` (reversion
   inside the band). Reversion inside the band → two independent events
   (E1-T2); reversion that never reaches the band → one event (E1-T3); a
   data gap inside an event is flagged (`spannedExclusionGap`).
7. **Pass rule, verbatim.** `>= N independent qualifying events per week
   with d > fees + impact(D) at depth D` where `fees` = recorded pool fee
   tier (read from data, never assumed) + flashloan fee + redemption fee
   (manifest, exact), and `impact(D)` is measured by the fee=0 tick-walk at
   the pre-registered depth D (AMM fee accounted once in `fees`, size cost
   exactly once as `d_spot − d_realized` — no double count). The verdict
   comparison is exact-rational, so it changes ONLY when N/D/data change
   (E1-T11).

## Usage

```bash
# replay the committed synthetic fixtures (offline, deterministic)
pnpm --filter @edge/e1-khype-event-study start:replay -- \
  --manifest fixtures/synthetic-48h/SYNTHETIC-manifest.json \
  --raw fixtures/synthetic-48h/raw

# regenerate the synthetic fixtures (byte-identical; provenance-tested)
pnpm --filter @edge/e1-khype-event-study write-fixtures
```

Exit 0 prints the canonical report JSON (exactly one trailing newline).
Fail-closed refusals print `{"ok":false,"errors":[...]}` and exit 1.

## Test map (acceptance matrix)

| ID | Test | Result |
|---|---|---|
| E1-T1 | `test/e1-t1-t5-event-study.test.ts` | 1 event, d_max ≈ 0.6%, net = 0.50%, duration exactly 3h, passes at D |
| E1-T2 | same | reversion inside band → exactly 2 independent events |
| E1-T3 | same | reversion outside band → exactly 1 merged event (manifest rule == code) |
| E1-T4 | same | missing/`0x`/stale/future anchors → `anchor_unusable` exclusions, no interpolation/carry-forward |
| E1-T5 | same | 1% fee tier dip detected but fails (`net_never_positive`), counted as failing |
| E1-T6 | `test/e1-t6-t8-tick-walk.test.ts` | $10k quote == closed form `10^24/101` **to the wei**; `sqrtPriceX96After` + `ticksCrossed` reported |
| E1-T7 | same | multi-tick crossing matches independent segment math; oversized input fails closed (`zero_liquidity_below`) |
| E1-T8 | same | zero liquidity → no quote, `no_liquidity`; corrupted state → explicit reasons |
| E1-T9 | `test/e1-t9-reproducibility.test.ts` | two fresh processes byte-identical; no floats; no wall-clock |
| E1-T11 | `test/e1-t11-pass-report.test.ts` | verdict flips only when N/D change; missing N → refused |
| (extra) | conventions / fail-closed / provenance suites | orientation trap pinned; manifest refusals; committed fixtures == generator bytes |

## Deliberately NOT in this task

- **No collector.** E1-T10 (collector conformance) is deferred until
  collection is separately authorized; the raw-archive FORMAT this tool
  consumes is the format the future collector must produce.
- **No real study manifest, no historical chain state, no raw observations,
  no E-1 pass/fail from real-market evidence.**
- **No changes** to `hl-lst-arb-scanner.ts`, its thresholds, the redemption
  anchor, EI-S008 artifacts, or any other protected evidence. This package
  has zero imports from `packages/scanner`.
- Kinetiq redemption fees/queue/minimums remain UNMEASURED (E-10
  prerequisite); the synthetic manifest declares `redemptionFeePct: '0'`
  for tooling validation only.
