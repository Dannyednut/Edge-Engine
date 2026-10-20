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
  series start date, pass `stats --window-start <UTC>` so the anchor is pinned rather
  than inferred.
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
