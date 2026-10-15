# Persistent Sampling Infrastructure

**Last updated:** 2026-10-15, 08:04 UTC
**Latest repository commit:** `ffd5831` (docs-only, CI pending)
**Prior CI-verified commit:** `5b6d376` — https://github.com/Dannyednut/Edge-Engine/actions/runs/38697902457
**Code loaded by running processes:** `ffd5831` (processes started 08:04:12 UTC, HEAD at that time; docs-only changes since `5b6d376` do not affect daemon source)
**Status:** ACTIVE — 12 daemons supervised with PID-file duplicate prevention

## Overview

Two zero-capital research monitors run as supervised daemons, collecting
timestamped observations to persistent JSONL files. Both are included in
`launch-all-daemons.sh` (12 daemons) and `daemon-supervisor.sh` (12
daemons in DAEMONS array). The supervisor auto-restarts crashed daemons
within 60 seconds.

**PID-file duplicate prevention:**
- Each daemon writes its wrapper PID to `run/<name>.pid`
- `is_running()` / `is_managed()` checks PID file + process alive + tsx in cmdline
- Stale PID files are automatically removed
- Running the launcher twice skips already-running daemons
- Supervisor checks wrapper processes (not just tsx child) to prevent
  duplicate wrappers during the 5-second restart sleep

---

## A. kHYPE Collectors

### A.1 DefiLlama Yield Collector (`khype-timeseries.ts`)
DefiLlama-only — tracks yield persistence, NOT reward cadence.
- **Log:** `logs/khype-timeseries.log`
- **Data:** `data/khope-study/observations.jsonl`
- **Poll:** 30 min
- **Supervised:** Yes (in launcher + supervisor DAEMONS array)

### A.2 On-Chain Cadence Sampler (`khype-cadence-sampler.ts`)
Records on-chain reward-cadence evidence per EI-001-E2 protocol.
- **Log:** `logs/khype-cadence-sampler.log`
- **Data:** `data/khope-study/cadence-observations.jsonl`
- **State:** `data/khope-study/cadence-state.json`
- **Poll:** 30 min
- **Supervised:** Yes (in launcher + supervisor DAEMONS array)

**Contracts (EI-S006 verified):**
- Accountant: `0x9209648Ec9D448EF57116B73A2f081835643dc7A`
- StakingManager: `0x393D0B87Ed38fc779FD9611144aE649BA6082109`
- kHYPE token: `0xfD739d4e423301CE9385c1fb8850539D657C296D`

**Selectors (keccak256-verified):**
- `totalRewards()` = `0x0e15561a` (on Accountant)
- `kHYPEToHYPE(uint256)` = `0x759bc2fc` (on Accountant, NOT StakingManager)
- `totalStaked()` = `0x817b1cd2`
- `totalSupply()` = `0x18160ddd`

**State-commit ordering:** `rewardStepCount` is STAGED and committed only
after successful JSONL append. On append failure, no state advances.

**Cadence:** UNRESOLVED — 0 reward steps detected. Needs ≥3 distinct
reward-step timestamps per EI-S006 decision rule.

---

## B. PT-LIMUSD Monitor (`limusd-monitor.ts`)

- **Log:** `logs/limusd-monitor.log`
- **Data:** `data/limusd-study/observations.jsonl`
- **State:** `data/limusd-study/monitor-state.json`
- **Poll:** 10 min
- **Supervised:** Yes (in launcher + supervisor DAEMONS array)

**Contract identities (EI-S007 verified):**
- limUSD: `0x1822bd335489d84abdd0779a7dcaeda0625e83c8` (18 dec)
- PT-limUSD: `0x6b7cea9d070bbffd8205f256897319139cdef399` (6 dec)
- SY-limUSD: `0xcf6b4c156f51818922b98524dc832e352f40d516` (18 dec)
- Market: `0xfc93d1ada3277e6274c3905db0a2c81ac1252025`
- NAVOracle: `0x47f8d4847f528C18Ea5A6dcb9E0940F6b2977CA7`
- RedemptionPipe: `0x2E8c1256356e261150120a384d95DC0d0D00ae29`
- USDC: `0xb88339CB7199b77E23DB6E890353E22632Ba630f` (6 dec)

**Selectors (EI-S007 corrected):**
- `getNAV()` = `0x0126c606`
- `expiry()` = `0xe184c9be`

**Alert semantics (EI-S008 corrected):**
- **Buffer transitions:** True OK↔BREACH tracking. OK→BREACH alerts,
  BREACH→OK recovery alerts, no spam on continued breach. Re-breach
  after recovery fires a new alert. NOT subject to cooldown.
- **Daily decline:** Time-aware annualized rate. Alerts when daily rate
  exceeds 0.5%/day. Subject to 1h cooldown.
- **2% baseline veto:** Baseline persisted on first observation, never
  resets during decline. Decline >2% → veto flag + alert. Subject to 1h
  cooldown. Veto flag always set in observation regardless of cooldown.
- **State-commit ordering:** ALL state mutations (bufferBreachActive,
  sharePriceBaseline, lastSharePrice, cooldown timestamps) are STAGED
  in local variables and committed ONLY after successful JSONL append.
  On append failure: NO state mutation occurs — transitions are not
  consumed, cooldowns are not advanced, baselines are not set.
- **Observation consistency:** `bufferBreachActive` in the observation
  uses the STAGED value (the state intended for this sample), not the
  old state.

---

## C. Supervisor

**Startup:**
```bash
cd /home/z/my-project/edge-engine
( setsid bash -c '
  cd /home/z/my-project/edge-engine
  exec >> logs/daemon-supervisor.log 2>&1
  bash scripts-explore/daemon-supervisor.sh
' </dev/null >/dev/null 2>&1 & )
```

**Monitored daemons (12):**
1. telegram-listener
2. command-handler
3. realtime-opp-alerts
4. opp-db
5. hl-funding-alerts
6. paper-trader
7. risk-dashboard
8. wallet-funding-alert
9. realtime-spread-monitor
10. khype-timeseries
11. khype-cadence-sampler
12. limusd-monitor

All 12 are in both `launch-all-daemons.sh` and `daemon-supervisor.sh`
DAEMONS array. PID files in `run/<name>.pid`.

---

## D. 24-hour runtime acceptance test

### Window history
**Window 1 (COMPROMISED):** Start `2026-10-14T16:36:56Z`. Gap `18:47:59Z → 04:51:31Z` (~10h). FAIL.
**Window 2 (INVALIDATED):** Start `2026-10-15T04:51:31Z`. Controlled restart at `06:36:56Z` (code update to `2337e45`).
**Window 3 (INVALIDATED):** Start `2026-10-15T06:36:56Z`. Controlled restart at `06:52:24Z` (code update to `232137c`).
**Window 4 (INVALIDATED):** Start `2026-10-15T06:52:24Z`. Controlled restart at `07:07:46Z` (code update to `e836183`).
**Window 5 (INVALIDATED):** Start `2026-10-15T07:07:46Z`. Controlled restart at `07:18:37Z` (code update to working tree subsequently committed as `5b6d376`).
**Window 6 (INVALIDATED):** Start `2026-10-15T07:18:37Z`. Container restart at ~08:01 UTC killed all processes. Not a controlled restart — the host environment restarted.
**Window 7 (CURRENT):** Start `2026-10-15T08:04:12Z` (confirmed from `ps -eo lstart`). HEAD at start: `ffd5831` (docs-only change from `5b6d376` — no daemon source affected). Nominal completion: `2026-10-16T08:04:12Z`. Status: PENDING.

Note: Windows 1-5 were invalidated by controlled restarts for code updates.
Window 6 was invalidated by an environment/container restart (~08:01 UTC)
that killed all processes. Window 7 is the current window. The daemons
loaded commit `ffd5831` which is a docs-only change from the CI-verified
`5b6d376` — no daemon source code was affected.

Startup/commit claim qualification (Window 6):
  Process start: 2026-10-15T07:18:37Z (ps -eo lstart)
  Commit 5b6d376: 2026-10-15T07:18:45Z (git log --format=%cI)
  8s gap: processes started from working tree 8s before commit.
  Evidence: git status clean post-commit (0 uncommitted files).
  Qualification: Manager-reported. No contemporaneous tree hash was
  recorded at process start. The clean working tree is consistent with
  but does not independently prove the loaded source matched the commit.
  This claim has not been independently verified by EI.

### Pass criteria
1. No gaps > 60 minutes in observation timestamps
2. Timestamped observations across full 24h from raw JSONL
3. All LIMUSD observations have non-null NAV/sharePrice/expiry
4. `readFailures` accurately reports problems
5. No duplicate-worker evidence
6. All read failures recorded

### Evidence paths
- LIMUSD: `data/limusd-study/observations.jsonl`
- kHYPE cadence: `data/khope-study/cadence-observations.jsonl`
- kHYPE DefiLlama: `data/khope-study/observations.jsonl`
- Logs: `logs/<daemon-name>.log`
- Supervisor: `logs/daemon-supervisor.log`
- Evidence bundles: `/home/z/my-project/download/evidence-bundle-*.tar.gz`

---

## E. Manager-reported vs independently-verified evidence

**Manager-reported:** Process status via `ps aux`, sample counts via `wc -l`,
log freshness via `tail`. The `data/` and `logs/` directories are gitignored.

**Independently-verified (EI-S007/S008):** Contract identities, selectors,
supply values, NAV, share price, redemption buffer — all verified via
independent on-chain reads.

**Evidence bundles:** Exported to `/home/z/my-project/download/` with
SHA-256 hashes and manifests. EI can retrieve these for independent review.
