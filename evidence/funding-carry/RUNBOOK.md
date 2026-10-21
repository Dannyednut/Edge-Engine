# RUNBOOK — Twice-Daily Funding-Carry Evidence Collection (EI-STRAT-002)

**Audience:** EI operator (or any Instructor-appointed runner of the evidence series).
**Constraints:** manual invocation only · read-only wrt everything else on the host ·
free public endpoints only · no credentials · no daemons/schedulers · no paper trader ·
no blockchain RPC · EI-S008 untouched.

---

## 0. When and where

- **Cadence:** exactly **twice per UTC day**, at least ~6h apart. Suggested slots:
  **08:00–10:00 UTC** and **20:00–22:00 UTC** (straddles the 08:00/16:00/00:00 CEX
  funding settlements; the harness keys observations to 12h slots, so exact minutes
  within a slot window do not matter — consistency of *slots* does).
- **Machine:** the EI research host. No API keys are needed or read; the tool must run
  from a network where the reachable-venue set is what you want recorded (venue
  blocks like Binance 418 are **per-IP facts** — do not "fix" them with VPNs; record
  them).
- **Working directory:** `evidence/funding-carry/` on branch
  `ei/funding-carry-evidence-harness`. All commands below run from there.
  `python3 -m funding_harness --help` shows the CLI.

### 0.1 Authorized series start (EI-STRAT-004/005/006 — read before any authorized run)

- **The recurring twice-daily observation series has NOT been authorized or
  started.** The only existing sample is the pre-authorization exploratory
  run `20261020T045654Z` (collected `2026-10-20T04:56:54Z`) — evidence of
  tool readiness, not part of any authorized series. It is kept intact;
  it is never deleted or rewritten.
- When the Instructor authorizes the series, record BEFORE the first
  authorized `collect`: (a) the **authorized gate-window anchor** (UTC —
  see the anchor-selection rules below) and (b) the **two daily
  collection windows** (e.g. the §0 slots). Both go into the session log.
- **The anchor must be slot-aligned (EI-STRAT-005): exactly `00:00:00Z`
  or `12:00:00Z`.** The pre-registered evaluation window is the FIXED
  14-day UTC slot window `[anchor, anchor + 14 days)` — 28 consecutive
  12h UTC slots. Because the anchor sits on a slot boundary, the exact
  authorized timestamp, the grid start and the lower data cutoff all
  coincide, and "14 full elapsed days from the exact authorized
  timestamp" describes the IDENTICAL interval — the two candidate
  readings of the pre-registration cannot diverge. A non-aligned
  `--window-start` (e.g. `08:00Z`, which would end the floor-12h grid
  13 days 16 hours = 328h after the exact start — 8h short of 14 elapsed
  days) is **refused with exit 4** and the two nearest boundaries are
  printed; nothing is ever floored silently.
- **The anchor is the gate-window anchor, NOT the time of the first
  actual collection.** The first authorized `collect` happens at or after
  the anchor, inside the first slot; whenever it actually lands (e.g.
  `13:07:33Z`), the grid stays `[anchor, anchor + 14 days)`. The first
  admitted collection is disclosed in every report as an observed fact
  (`window_semantics.first_accepted_collection_utc`) and never moves the
  window. Do not conflate the two meanings.
- **Anchor selection — practical guidance (EI-STRAT-006).** An authorized
  anchor is valid only if ALL of the following hold:
  1. **It is a valid slot boundary:** exactly `00:00:00Z` or `12:00:00Z`
     on some UTC date (`stats` refuses anything else with exit 4).
     Alignment is necessary but NOT sufficient.
  2. **It is strictly later than every pre-authorization observation.**
     The known pilot `2026-10-20T04:56:54Z` makes `2026-10-20T00:00:00Z`
     INVALID even though it is a slot boundary: it predates the pilot and
     would admit the pilot into the first slot. The generic "first
     collection expected ~08:00–10:00Z → anchor `00:00:00Z` that day"
     pattern is therefore conditional, never a rule by itself — it yields
     a valid anchor only on a UTC day with no pre-authorization sample,
     and it never overrides this bullet. Slot alignment does not detect
     pilots; this ordering rule does.
  3. **It is selected as part of explicit authorization.** The anchor is
     fixed by the Principal/Instructor's authorization act and recorded
     in the session log BEFORE the first authorized `collect`. It is
     never inferred from the pilot, never backdated from the first
     observed collection, and never derived from exploratory timing.
  4. **The historical demo is not an authorized start.** The slot-aligned
     `2026-10-20T12:00:00Z` window used as a read-only demonstration in
     EI-STRAT-005 verification is NOT an authorized start and MUST NOT be
     presented or reused as a usable future start.
  5. **The intended first collection is an observed event at or after the
     anchor** (typically inside the first slot, e.g. ~08:00–10:00Z or
     ~20:00–22:00Z per §0). It never changes the window boundaries: the
     grid stays `[anchor, anchor + 14 days)` regardless of when the first
     collection actually lands.
  No authorized timestamp is selected or announced in this runbook; the
  actual anchor decision rests with the Principal.
- Always pass the authorized anchor to stats:
  `python3 -m funding_harness stats --window-start <slot-aligned UTC ts>`.
  The boundary is applied as an **exact timestamp against each pair's/
  observation's actual `collected_at_utc` before slot aggregation** — a
  pre-start sample on the same UTC date is excluded from the authorized
  series and disclosed in the report
  (`evaluation_window.pairs_before_boundary_excluded`,
  `evaluation_window.boundary_excluded_primary_slots`). The fixed 28-slot
  denominator and the gate are unchanged.
- **Never use the default anchor for authorized evaluation while the pilot
  run exists.** Without `--window-start` the window anchors at the earliest
  run timestamp — the pilot's own date — and the report labels this as
  `anchor_role: "diagnostic_earliest_run_derived_not_authorized"` with an
  explicit "NOT an authorized series start" note (the default anchor is
  first-collection-derived — exactly the conflation the authorized rule
  avoids). Default-anchor reports are diagnostics only.

## 1. Collection (≈ 15–60 seconds)

```bash
cd evidence/funding-carry
python3 -m funding_harness collect
```

Read the printed table line by line. Expected steady state from 2026-10-20:

```
hyperliquid 3 obs · bybit 3 · okx 3 · gate 3 · bitget 3 · sharpe 144+ refs
binance 3 gaps (HTTP 418) · mexc 3 gaps (HTTP 403) · vooi 3 gaps (majors absent)
RESULT: collection recorded WITH GAPS   (exit code 1)
```

Exit codes: **0** no gaps · **1** recorded with gaps (normal while Binance/MEXC are
blocked) · **2** hard failure (zero complete observations — rerun once after ~5 min;
if it persists, log the incident and continue the series; the gap is data, not an
excuse to skip) · **3** gate-config drift (stop, report to Instructor).
(`stats` exit codes: **0** verdict · **1** UNRESOLVED · **3** gate-config drift ·
**4** non-slot-aligned `--window-start` refusal, EI-STRAT-005.)

**If a previously-healthy venue shows gaps for 3+ consecutive runs**, note it in the
session log — that is a coverage regression the final report must disclose.

## 2. What gets written (append-only; never edit by hand)

```
data/runs/<run_id>/            ← one new directory per invocation; never reused
  observations.jsonl           complete canonical rows (one JSON object per line)
  gaps.jsonl                   explicit missing-source rows (http_error, ...)
  pairs.jsonl                  derived HL-vs-CEX net-APR estimates for this run
  raw/<source>/<name>.json     exact response bytes (or bounded projection,
                               flagged in the sibling .meta.json)
  raw/<source>/<name>.meta.json  url, status, elapsed, full-body sha256, size
  run_manifest.json            config snapshot + gate hash + counts + payload hashes
data/derived/gate-report-*.json  output of `stats`
```

Rules: never modify or delete a run directory; never edit JSONL lines; if a run is
unambiguously invalid (e.g. collected with a broken config), leave it in place and
document it — the verifier and the Instructor's audit trail prefer honest artifacts
over tidy ones. Re-running a slot is safe: the second run creates a separate directory
and cross-run duplicate/conflict detection in `verify` handles the overlap.

## 3. Consistency / hash checks

Run after any anomaly, and at least weekly:

```bash
python3 -m funding_harness verify
```

Checks: every stored raw file re-hashes against its manifest entry (full payloads);
bounded projections cross-check meta vs manifest sha256; every JSONL line parses; every
observation's structural schema validates; cross-run duplicate observation keys with
*different* payload hashes are flagged (a re-collection with changed data). Exit 0 =
clean; exit 1 = investigate before the next `stats`. Expected output today: 28+ raw
files checked, 0 mismatches.

## 4. Derived statistics / gate verdict

```bash
python3 -m funding_harness stats
```

- Before day 14 the verdict will be **UNRESOLVED** — that is correct behavior, not an
  error (stats exit 1). It also prints per-asset medians, persistence, flips,
  completeness and the honest coverage statement with the full gap summary.
- The report JSON (in `data/derived/`) embeds `gate_config_sha256`; `stats` refuses to
  run against runs collected under a different gate configuration (exit 3).
- **The thresholds are pre-registered (EI-STRAT-001 §4.2): median net APR > +3% with
  ≥70% daily persistence = pass; < +1.5% or > 2 sign-flips = fail; insufficient
  coverage = UNRESOLVED. Do not edit `config.GATE_CONFIG`. If the Instructor ever
  approves a threshold change, that is a new decision recorded BEFORE the next
  collection — never retroactively.**
- **Completeness denominator (EI-STRAT-003):** reported completeness always uses the
  fixed pre-registered denominator of **28 slots** (14 days × 2/day) anchored at the
  series start — never the observed span. A partially observed window therefore reads
  as partially complete (the first single slot = 1/28 = 3.6%); unobserved periods can
  never disappear from the denominator. If the Instructor authorizes an official
  series start, pass `stats --window-start <slot-aligned UTC ts>` (§0.1) so the
  anchor is pinned rather than inferred.
- **Authorized-start boundary is an exact timestamp (EI-STRAT-004):** `--window-start`
  is compared (inclusive ≥) against every pair/observation's actual `collected_at_utc`
  at second resolution BEFORE slot aggregation/dedup, so a pre-authorization sample
  collected before the anchor cannot contribute to the authorized series. Excluded
  rows are disclosed, never deleted.
- **Authorized window semantics (EI-STRAT-005):** the pre-registered design is the
  **fixed 14-day UTC slot window** `[anchor, anchor + 14 days)` — 28 consecutive 12h
  UTC slots; the denominator is 28 slots, never elapsed-seconds from an arbitrary
  timestamp. `--window-start` is therefore the **gate-window anchor** and must be
  **slot-aligned: exactly `00:00:00Z` or `12:00:00Z`** — non-aligned values are
  refused (exit 4) with the nearest boundaries named, never floored. For an aligned
  anchor the alternative reading ("14 full elapsed days from the exact authorized
  timestamp") describes the identical interval, so the pre-registered 28-slot
  interpretation holds either way without touching `GATE_CONFIG` or its hash. The
  timestamp is the gate-window anchor, **not** the time of the first actual
  collection; the first admitted collection is disclosed
  (`window_semantics.first_accepted_collection_utc`) and never moves the grid.
  Every report carries the full rule in `window_semantics`.
- **Completeness-definition metadata (EI-STRAT-004):** the hash-locked
  `GATE_CONFIG["completeness_definition"]` string ("…(days_spanned * samples_per_day)")
  is **legacy pre-registration metadata** — the effective calculation is the fixed
  28-slot window above. Every stats report carries
  `completeness_definition_metadata` (legacy status + why the string cannot be
  edited) and `completeness_definition_effective` (the operative definition); both the
  string and `gate_config_sha256` are regression-pinned byte-identical. Editing the
  string would change the hash and requires explicit Instructor approval.
- **Overall verdict requires three adequately covered majors:** BTC, ETH and SOL each
  need ≥ 24 complete paired slots inside the window (the 85% bar); with fewer, the
  overall verdict is UNRESOLVED regardless of the per-asset numbers.
- **Fee context (non-gate):** `python3 -m funding_harness fees` prints the labeled
  sensitivity sidecar (one-time 0.20% round trip amortized over 1/7/14/30-day holds).
  It never affects the gate verdict; the pre-registered metric remains a screening
  proxy that prices exactly one round trip per year.

## 5. Periodic duties (weekly is enough)

1. `verify` (§3).
2. Skim the newest `pairs.jsonl` primary legs — sanity: HL leg at clamp on most days?
   CEX legs plausible (|APR| < ~50%)? SOL/ETH sign changes?
3. Confirm gap composition is stable (binance 418, mexc 403, vooi no-majors). New gap
   reasons deserve a look at `raw/<source>/*.meta.json`.
4. Keep the raw evidence local; if disk pressure appears, raw payloads may be archived
   (tar, never edited) — observations/pairs/manifests stay intact.

## 6. Prohibitions (restated — they are part of the design)

- Do NOT wrap `collect` in cron/systemd/GitHub Actions/any scheduler. The twice-daily
  cadence is a human discipline requirement; automation of the schedule requires
  separate Instructor/Principal approval (EI-STRAT-002 §6).
- Do NOT start the paper trader, scanner daemons, or any repo exploration script.
- Do NOT touch `data/khope-study/`, `data/limusd-study/`, any paper-trader state/log,
  the production schedule, PR #1, or any EI-S008 monitor/observation/decision file.
- Do NOT add credentials, paid APIs, VPN/proxy evasion of IP blocks, or blockchain RPC.
- Do NOT fill gaps by hand; gaps are findings.

## 7. End-of-window reporting (after ≥14 consecutive days)

The Instructor-facing report bundles: the `stats` gate report (or the UNRESOLVED
explanation), `verify` output, the gap ledger across the window, per-asset daily
medians vs the Sharpe third-party reference, and the clamp-pinned share time series.
Missing-source periods are reported as missing — they are never counted as successful
coverage.
