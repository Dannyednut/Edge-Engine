# Funding-Carry Evidence Harness (EI-STRAT-002)

**Tool proposal + implementation — Edge Intelligence, for Instructor/Supervisor review.**
Repository baseline: `e1cc7a61478ab6513dd1f7fedbe89b21e6409727` (byte-identical to the
EI-AV3-accepted PR #4 head). Branch: `ei/funding-carry-evidence-harness`.

This is **measurement infrastructure, not a strategy approval**. It exists to answer one
pre-registered question with honest data:

> Does the cross-venue perp funding carry identified by EI-STRAT-001 (family rank 1:
> `perp_funding` + `cex_hl_funding_arb`) persist after the CEX leg, fees, slippage
> context and funding-sign changes are actually observed?

EI-STRAT-001 found the HL side of this trade pinned at +10.95% APR on 94 assets (a
cap-saturated regime artifact) while the CEX leg was unverifiable (Binance fapi HTTP
418) — so the net number was `[U]`. This harness converts that `[U]` into a measured,
auditable 14-day series.

## 1. What it is

- A **manually invoked, read-only Python tool** (stdlib-only runtime, zero dependencies;
  `pytest` for the dev/test layer). Nothing here schedules, retries itself, listens, or
  runs continuously. Every action is one explicit `python -m funding_harness <cmd>`
  invocation that exits when done.
- A **failure-honest recorder**: blocked endpoints (Binance 418, MEXC 403 — both
  observed live) are recorded as explicit gap rows with HTTP status, timestamps and
  payload hashes. Missing data is **never** zero-filled or interpolated; a "complete"
  row structurally cannot exist without a real funding rate (enforced by
  `models.validate_observation` and unit-tested).
- An **append-only evidence store** under a new dedicated path
  (`evidence/funding-carry/data/`) that is disjoint from `data/khope-study/`,
  `data/limusd-study/` (EI-S008) and all paper-trader state. Existing observations are
  never modified or overwritten — each invocation creates a new run directory.

## 2. Layout

```
evidence/funding-carry/
├── README.md                  ← this proposal
├── RUNBOOK.md                 ← twice-daily manual collection procedure
├── .gitignore                 ← data/ stays local; tool+tests+docs are committed
├── funding_harness/
│   ├── config.py              assets, endpoints, clamp refs, PRE-REGISTERED GATE
│   ├── convert.py             unit conversions (hourly/4h/8h → APR), clamp detection
│   ├── transport.py           pluggable HTTP (urllib), 25s timeout, 1 bounded retry
│   ├── models.py              canonical record schema + fail-closed validation
│   ├── sources/               9 adapters: hyperliquid, binance, bybit, okx, mexc,
│   │                          gate, bitget, sharpe, vooi (parsers are pure functions)
│   ├── collect.py             one invocation = one run directory
│   ├── store.py               JSONL persistence, manifests, hashing, verify
│   ├── pairing.py             derived HL-vs-CEX net-APR estimates (pairs.jsonl)
│   ├── stats.py               window metrics + pre-registered gate verdict engine
│   ├── fees.py                NON-GATE fee sensitivity sidecar (never a verdict)
│   └── cli.py                 collect / stats / verify / fees (exit codes 0/1/2/3)
├── tests/                     83 offline tests (fixtures = bounded real payloads)
└── data/                      runtime only (gitignored): runs/<run_id>/…
```

## 3. Data sources (all free, public, unauthenticated — no credentials, no paid services)

| Source | Endpoint | Units observed 2026-10-20 | Status at probe |
|---|---|---|---|
| hyperliquid | POST `api.hyperliquid.xyz/info` `metaAndAssetCtxs` | `funding` decimal **per 1h**; APR = rate × 8760 | 200 OK |
| bybit | GET `api.bybit.com/v5/market/tickers?category=linear&symbol=` | `fundingRate` decimal **per 8h** (interval assumed for majors; flagged) | 200 OK |
| okx | GET `okx /api/v5/public/funding-rate` + `open-interest` + `market/ticker` | `fundingRate` decimal per 8h (assumed; flagged) | 200 OK |
| gate | GET `api.gateio.ws/api/v4/futures/usdt/contracts/{S}` | `funding_rate` per **explicit** `funding_interval` seconds | 200 OK |
| bitget | GET `api.bitget.com/api/v2/mix/market/current-fund-rate` | `fundingRate` per 8h (assumed; flagged) | 200 OK |
| binance | GET `fapi.binance.com/fapi/v1/premiumIndex` | (implemented; would be 8h) | **HTTP 418 — blocked since EI-S004 (2026-10-13); re-confirmed 2026-10-19/20** |
| mexc | GET `contract.mexc.com/api/v1/contract/funding_rate/{S}` | (implemented; would be 8h) | **HTTP 403 — blocked at 2026-10-20 probe** |
| sharpe | GET `sharpe.ai/api/funding/rates?coin=` + `/api/arbitrage/cross-exchange` | `rate` + explicit `interval_hours`; `netApr` = fraction APR | 200 OK — **third-party reference only** (EI-STRAT-001: provenance not decomposable → never ground truth) |
| vooi | GET `perps-api.vooi.io/arbitrage-scanner?minOpenInterest=10000&notionalUsd=5000&orderBy=priceSpread` | `priceSpreadAtSize` context; majors typically **absent** from response | 200 OK (15 items, no majors → recorded as gaps) |

Unit convention everywhere: rates are **decimal fractions per interval**; `*_pct`
fields are ×100; APR = rate × (8760 / interval_hours); positive = longs pay shorts
(uniform across all nine sources above).

**Clamp-regime detectors** (observed reference values, not official docs — used only to
FLAG saturation, never to alter a rate): Hyperliquid `0.0000125/h` (= +10.95% APR, the
EI-STRAT-001 cap-saturation artifact) and 8h CEX venues at exactly `0.0001` (= the same
10.95% APR — observed live on OKX BTC `0.0001000000000000` and Bitget BTC/ETH on
2026-10-20, i.e. the saturation regime is **not HL-specific**).

## 4. Canonical observation record (observations.jsonl)

One row = one (source, instrument, metric-group, observation-time). Full example in
§Appendix of the readiness report and in `tests/`. Key fields:

- identity: `observation_id` (sha256 of key+run), `observation_key`, `run_id`
- timing: `collected_at_utc`, `observation_ts_utc`, `observation_ts_basis`
  (`response_time` | `source_reported_time` | `source_updated_at`)
- instrument: `source`, `source_kind` (`cex|dex_perp|reference|aggregator`), `asset`,
  `source_instrument`, `metric_group` (`funding` | `context` | `funding_reference` |
  `cross_exchange_reference`)
- `metrics`: `funding_rate_native`, `funding_interval_hours`,
  `funding_interval_assumed`, `funding_rate_apr(+_pct)`, `funding_rate_8h_equiv`,
  `at_clamp_reference`, `mark_price`, `index_price`, `open_interest_native/_unit/
  _usd_estimate`, `next_funding_ts_utc`, `volume_24h_usd`, `price_spread_at_size`,
  `net_apr_reference`
- `unit_conventions`: `positive_means: "longs_pay_shorts"`, APR definition
- `evidence`: endpoint, method, HTTP status/attempts/elapsed, **payload_sha256 (full
  body)**, `raw_ref`, `raw_bounded`, provenance string, tool version
- `quality`: `complete` / `gap_reason` / `warnings` (clamp flags, assumed intervals,
  degraded context sub-calls)

Raw payloads are stored whole when ≤ 2 MiB; oversized bodies are stored as an explicit
bounded projection with the **full-body sha256** preserved in `evidence.payload_sha256`
(so completeness is auditable either way).

## 5. Derived paired estimate + the pre-registered gate (unchanged, hash-locked)

Per run, `pairing.py` builds HL-vs-CEX pairs for each asset from **complete** legs only:

```
direction           SHORT HL perp + LONG CEX perp (EI-STRAT-001 §2.1 framing)
gross_diff_apr      = F_HL_apr − F_CEX_apr
net_apr_pre_reg     = gross_diff_apr − 0.002   (conservative 0.20% round trip)
net_apr_opt_band    = gross_diff_apr − 0.001   (0.10% band; context only)
primary_cex_leg     first complete venue in pre-registered priority order
                    [binance, bybit, okx, gate, bitget, mexc]  (deterministic)
vooi_context        priceSpreadAtSize when the pair exists in the scanner;
                    |spread| > 1% sets exceeds_vooi_1pct_warning (the repo's own
                    strategy skips such pairs)
```

The **decision gate is carried verbatim from EI-STRAT-001 §4.2 rank-1** (and the
EI-STRAT-002 instruction):

- **PASS candidate for further review**: median net APR **> +3%** AND daily persistence
  **≥ 70%** across the window (and ≤ 2 sign-flips).
- **FAIL/reject**: median net APR **< +1.5%** OR **> 2 sign-flips** in the window.
- **UNRESOLVED**: insufficient coverage (window < 14 consecutive days, completeness
  < 85%, or CEX-leg coverage < 3 majors). **Never reported as a pass.**
- `BETWEEN_THRESHOLDS`: coverage adequate, median inside [1.5%, 3%], flips ≤ 2 — the
  pre-registered gate defines neither pass nor fail there; the decision returns to the
  Instructor.

Definitions fixed before observations begin (`config.GATE_CONFIG`, embedded in every
run manifest): eligible day = UTC day with ≥1 complete paired observation; day is
positive when its median net APR > 0; persistence = positive_days/eligible_days;
sign-flips = sign changes of consecutive daily medians (zeros excluded).

**Completeness denominator (EI-STRAT-003 audit):** the denominator is ALWAYS the
fixed pre-registered window size — 14 days × 2 slots/day = **28 slots** — anchored at
the series start (earliest run timestamp, or the authorized start pinned via
`stats --window-start`). It is never derived from the observed date span, so
unobserved periods can never disappear from the denominator: the single-slot initial
sample is 1/28 = 3.6% (the pre-audit implementation computed 1/2 = 50% for the same
sample — fixed and regression-tested). The observed span is reported separately as a
diagnostic only.

**Completeness-definition metadata (EI-STRAT-004):** the hash-locked
`GATE_CONFIG["completeness_definition"]` string still carries the pre-audit
formula "(days_spanned * samples_per_day)". It is **legacy pre-registration
metadata, not the operative definition**: GATE_CONFIG is hash-locked, so the
string is retained verbatim while every `stats` report states the effective
calculation explicitly (`completeness_definition_effective` — the fixed
28-slot window above) and labels the legacy string as superseded
(`completeness_definition_metadata`, with the reason it cannot be edited).
Byte-identity of both the string and `gate_config_sha256` is
regression-tested; changing the string would change the hash and requires
explicit Instructor approval BEFORE any such change.

**Authorized-start boundary (EI-STRAT-004):** `stats --window-start` is the
Instructor-authorized series start, applied as an EXACT UTC timestamp
(inclusive ≥) against each pair's/observation's actual `collected_at_utc`
BEFORE slot aggregation/deduplication. A pre-authorization sample collected
on the same UTC date as the authorized start — even inside the same 12h slot
(the real pilot was recorded 2026-10-20T04:56:54Z, so the same-day-start
hazard is live) — can never contribute to the authorized series. The slot
grid is the 28 half-day slots from the floor-12h of the start; excluded rows
are disclosed in the report (`pairs_before_boundary_excluded`,
`boundary_excluded_primary_slots`), never deleted. The default earliest-run
anchor is labeled `default_earliest_run` with an explicit "NOT an authorized
series start" note and remains diagnostic-only (the runbook mandates
`--window-start` for any authorized evaluation). The fixed 28-slot
denominator, the pre-registered gate and its hash are unchanged.

**Three-major coverage condition (EI-STRAT-003):** a major (BTC/ETH/SOL) counts as
adequately covered when it has ≥ ceil(0.85 × 28) = **24 complete paired slots** inside
the evaluation window (the same 85% bar the per-asset gate applies). With fewer than
three adequate majors, the OVERALL verdict is **UNRESOLVED** — never PASS, never
BETWEEN_THRESHOLDS, and not FAIL either (per-asset diagnostics remain in `per_asset`).

**Threshold immutability**: `gate_config_sha256` is embedded in every manifest; `stats`
refuses to produce a report (exit 3) if any run was collected under a different gate
hash. GATE_CONFIG was NOT modified by the EI-STRAT-003 audit (byte-identity is pinned
by a test against the pre-registered hash).

The fee band (0.10–0.20% round trip, 4 taker legs) is EI-STRAT-001's pre-registered
number. Slippage is not modeled as a constant: it is **observed** as VOOI at-size
spread context where available, and every assumption that IS made (fee tier, holding
period for the non-gate amortized sensitivity) is labeled as an assumption in code and
in every report. Funding-sign changes are measured, not assumed away (HYPE Sep-28
precedent from the repo's own strategy comments).

**Fee methodology (EI-STRAT-003 audit — gate unchanged):** the pre-registered metric
subtracts the one-time 0.20% round trip directly from the annualized funding APR, i.e.
it prices exactly ONE round trip per year. That makes it a **screening proxy**, not
realizable net APR: the realizable annualized fee drag scales with turnover as
`round_trip_fee × (365 / holding_days)` — 73.0%/yr at a 1-day hold, 10.43%/yr at
7 days, 5.21%/yr at 14 days, 2.43%/yr at 30 days. This is exposed as a clearly labeled,
**non-gate** sidecar (`python -m funding_harness fees [--report <gate-report.json>]`,
`funding_harness/fees.py`): it never produces or modifies a verdict, never touches
GATE_CONFIG, and its assumptions are stated in code and in its output. Any proposal to
change the gate metric itself goes to the Instructor for explicit approval BEFORE
implementation (it would change `gate_config_sha256` and require an explicit
manifest-migration decision) — no such change is implemented here.

## 6. Failure model (why the numbers can be trusted)

1. Endpoint unreachable / non-200 → per-asset gap rows (`http_error`), HTTP status and
   payload hash preserved; run still recorded (exit 1).
2. Malformed / non-JSON payload → `malformed_payload` / `non_json_payload` gaps.
3. Asset absent from a healthy payload → `asset_not_in_source_response` gap (VOOI
   majors, Sharpe cross-exchange majors — both observed live today).
4. Required field missing/unparseable → `required_field_missing` gap; **never** a
   defaulted number.
5. Unexpected adapter crash → `source_exception` gaps for that source only; other
   sources unaffected.
6. All sources fail → exit 2 (hard failure), nothing usable this slot.
7. Structural gate: a row cannot be `complete` without a real funding rate + interval
   (unit test `test_never_fabricates_funding_zero`).
8. `verify` re-hashes every stored payload against its manifest, re-parses all JSONL,
   and flags cross-run duplicate keys whose payload hash differs (tamper/conflict
   detection).

## 7. What this tool deliberately does NOT do

- No cron job, scheduled GitHub Action, daemon, persistent process, or automatic
  schedule (explicitly reserved for separate approval).
- The only CI presence is `.github/workflows/evidence-funding-carry-tests.yml`
  (EI-STRAT-003): a narrowly scoped OFFLINE job that runs the harness pytest suite
  with the mocked transport and `FUNDING_HARNESS_OFFLINE=1` (any real network attempt
  raises at the transport layer). It has no schedule trigger, never calls `collect`,
  requires no credentials, and starts no background process.
- Does not run the paper trader, start scanner daemons, touch V1/V2 state or logs.
- No blockchain RPC/forks, no wallets/keys, no credentials, no paid services.
- Does not modify any existing file or observation anywhere; writes only under
  `evidence/funding-carry/data/`.
- Does not alter EI-S008 or PR #1 (no dependency, separate directory, separate series).
- Makes no trading decisions; the gate verdict is a *recommendation input* to the
  Instructor/Principal, not an approval.

## 8. Acceptance mapping (EI-STRAT-002 instruction → harness)

| Requirement | Where satisfied |
|---|---|
| Manually invoked read-only Python tool, free public sources, no credentials | `cli.py` (single-shot invocations); stdlib-only runtime |
| New dedicated evidence path, no modification of existing data | `evidence/funding-carry/data/` (new; per-run dirs; append-only) |
| Raw responses or bounded equivalents + normalized JSONL + unit tests for conversions/nulls/duplicates/malformed/endpoint-failure | `store.py` + `tests/` (83 offline tests incl. 418/403, malformed, missing-asset, duplicate-timestamp, tamper, fixed-denominator window, majors gate, fee sidecar, offline guard, exact-start boundary, legacy-metadata clarity) |
| Fail closed, mark gaps, never manufacture rows | `models.validate_observation`, gap-row design, exit-code contract |
| Runbook for twice-daily collection, append semantics, hash/consistency checks, derived stats | `RUNBOOK.md` + `store.verify` + `stats` |
| No cron/GHA/daemon/daemon-like scheduling | none exists; runbook states the prohibition |
| ≥14 days × 2/day, ≥85% completeness, CEX leg on ≥3 majors, honest gap reporting | `stats.py` gate engine (UNRESOLVED path unit-tested) |
| EI-STRAT-003: fixed 28-slot completeness denominator · three-major overall condition · non-gate fee sensitivity sidecar · offline CI job | `stats.py` (fixed window + majors gate) · `fees.py` + `fees` CLI · `tests/test_gate_window.py` / `test_gate_majors.py` / `test_fees_sidecar.py` / `test_offline_guard.py` · `.github/workflows/evidence-funding-carry-tests.yml` |
| EI-STRAT-004: exact authorized-start boundary before slot aggregation · legacy completeness-definition metadata labeled · authorized-start runbook procedure | `stats.py` (exact `collected_at_utc` boundary + 28-slot grid + exclusion disclosure + legacy-status block) · `tests/test_window_boundary.py` · `tests/test_completeness_definition.py` · `RUNBOOK.md` §0.1/§4 |
| Pre-registered gate thresholds unchanged | `GATE_CONFIG` + `gate_config_sha256` drift lock (exit 3) |
