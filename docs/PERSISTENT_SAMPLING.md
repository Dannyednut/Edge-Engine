# Persistent Sampling Infrastructure

**Last updated:** 2026-10-15, 04:52 UTC
**Deployed commit:** `5ffe9d6`
**Status:** ACTIVE — 11 daemons supervised and collecting

## Overview

Two zero-capital research monitors run as supervised daemons, collecting
timestamped observations to persistent JSONL files. Both are included in
`launch-all-daemons.sh` and monitored by `daemon-supervisor.sh`. The
supervisor auto-restarts crashed daemons within 60 seconds.

**Important distinction:**
- The **kHYPE DefiLlama collector** tracks yield persistence only. It does
  NOT collect on-chain reward-cadence evidence. A separate on-chain
  sampler is being deployed (see §A.2 below).
- The **PT-LIMUSD monitor** collects on-chain NAV, share price, supplies,
  redemption buffer, and PT expiry — all fields verified working after
  the EI-S007 selector fix.

---

## A. kHYPE Collectors

### A.1 DefiLlama Yield Collector (`khype-timeseries.ts`)

**Purpose:** Tracks kHYPE staking yield persistence via DefiLlama public
API. This is NOT a reward-cadence sampler — it does not read on-chain
`totalRewards()` or the kHYPE/HYPE anchor exchange rate.

**Startup command:**
```bash
cd /home/z/my-project/edge-engine
bash scripts-explore/launch-all-daemons.sh  # includes khype-timeseries
```

**Environment requirements:**
- Node.js 22+
- tsx (installed in node_modules)
- No API keys required (zero-capital, public DefiLlama API)

**Log location:** `logs/khype-timeseries.log`

**Data path:** `data/khope-study/observations.jsonl` (append-only JSONL)

**Poll interval:** 30 minutes (1800s, configurable via `KHYPE_POLL_INTERVAL_SEC`)

**What it records:**
Each observation: timestamp (UTC), source, apiStatus, fetchMs,
totalPoolsScanned, matchedPools, and per-pool metadata (poolId, chain,
project, symbol, APY, TVL). Missing data is recorded as `null` (not
zero) to distinguish from a true zero yield.

**Supervisor status:** Included in `daemon-supervisor.sh` DAEMONS array.
Auto-restarted on crash.

### A.2 On-Chain Cadence Sampler (`khype-cadence-sampler.ts`)

**Purpose:** Collects on-chain reward-cadence evidence per the EI-001-E2
protocol. This is the sampler that can actually classify the kHYPE
reward-credit cadence.

**Status:** NEWLY DEPLOYED (2026-10-15). See §A.2 detail below.

**Contracts (EI-S006 verified):**
- Accountant: `0x9209648Ec9D448EF57116B73A2f081835643dc7A`
- StakingManager: `0x393D0B87Ed38fc779FD9611144aE649BA6082109`
- kHYPE token: `0xfD739d4e423301CE9385c1fb8850539D657C296D`

**What it records:**
- UTC timestamp and block number
- `Accountant.totalRewards()` (exact bigint)
- `kHYPEToHYPE(1e18)` anchor exchange rate (exact bigint)
- `Accountant.totalStaked()` (exact bigint)
- `kHYPE.totalSupply()` (exact bigint)
- Changes in anchor and reward accumulator since previous sample
- Per-field RPC read failures
- Reward-step detection (fires when `totalRewards` changes between samples)

**Poll interval:** 30 minutes (configurable via `KHYPE_CADENCE_POLL_SEC`)

**Cadence classification rule (per EI-S006):**
Cadence remains UNRESOLVED until ≥3 distinct reward-step timestamps are
observed. Do NOT infer cadence from a period of stability or microscopic
drift. The sampler records evidence but does not classify — classification
requires manual review against the pre-registered decision rule.

**Data path:** `data/khope-study/cadence-observations.jsonl`

**Log location:** `logs/khype-cadence-sampler.log`

---

## B. PT-LIMUSD Monitor (`limusd-monitor.ts`)

### Startup command
```bash
cd /home/z/my-project/edge-engine
bash scripts-explore/launch-all-daemons.sh  # includes limusd-monitor
```

### Environment requirements
- Node.js 22+
- tsx (installed in node_modules)
- No API keys required (zero-capital, public HyperEVM RPC + DefiLlama)

### Log location
`logs/limusd-monitor.log`

### Data path
`data/limusd-study/observations.jsonl` (append-only JSONL)
`data/limusd-study/monitor-state.json` (alert cooldown state)

### Poll interval
10 minutes (600s, configurable via `LIMUSD_POLL_INTERVAL_SEC`)

### Contract identities (EI-S007 verified, re-checked 2026-10-14)
- limUSD (underlying): `0x1822bd335489d84abdd0779a7dcaeda0625e83c8` (18 dec)
- PT-limUSD-26NOV2026: `0x6b7cea9d070bbffd8205f256897319139cdef399` (6 dec)
- SY-limUSD: `0xcf6b4c156f51818922b98524dc832e352f40d516` (18 dec)
- Pendle market: `0xfc93d1ada3277e6274c3905db0a2c81ac1252025`
- NAVOracle: `0x47f8d4847f528C18Ea5A6dcb9E0940F6b2977CA7`
- RedemptionPipe: `0x2E8c1256356e261150120a384d95DC0d0D00ae29`
- USDC: `0xb88339CB7199b77E23DB6E890353E22632Ba630f` (6 dec)

### Function selectors (EI-S007 corrected, keccak256-verified)
- `getNAV()` = `0x0126c606` (was `0x41976e09` — wrong, reverted on every node)
- `expiry()` = `0xe184c9be` (was `0x96c8ef5d` — wrong, reverted on PT token)

Both selectors are exported as constants (`GETNAV_SELECTOR`, `EXPIRY_SELECTOR`)
and imported by tests to prevent drift.

### What it records
Each observation: timestamp (UTC), block number, source, and:
- limUSD total supply (raw bigint + decimal-adjusted string, 18-dec)
- PT-limUSD total supply (raw bigint + decimal string, 6-dec)
- SY-limUSD total supply (raw bigint + decimal string, 18-dec)
- NAV from NAVOracle (raw bigint + decimal string) — **WORKING** since EI-S007 fix
- Share price (NAV / limUSD supply, exact bigint division) — **WORKING**
- Redemption buffer (USDC.balanceOf(RedemptionPipe), raw bigint + USD)
- PT expiry (from PT.expiry(), Unix timestamp + ISO date) — **WORKING**
- DefiLlama APY/TVL for PT and underlying pools
- Per-field read failures (distinguishes RPC failure from real zero)
- Alert list with transition-based deduplication

### Alert thresholds
- Share-price change > 0.5% per day (transition-based, 1h cooldown)
- Redemption buffer < $50,000 (pre-existing breach recorded once)

### Supervisor status
Included in `daemon-supervisor.sh` DAEMONS array (since commit `5ffe9d6`).
Auto-restarted on crash.

### First corrected observation
**Timestamp:** 2026-10-14T16:36:56Z (block 48534795)
**Commit:** `7448155` (EI-S007 selector fix)
**Result:** All fields successful:
- navRaw: 8846850525638012173056602 → navUsd: 8,846,850.53 USDC
- sharePrice: 1.035621 (matches EI-S007 cross-check)
- ptExpiry: 1795651200 → 2026-11-26
- redemptionBufferUsd: 0 (real zero, not read failure)
- readFailures: [] (all reads succeeded)

### Overlap protection
The `collecting` flag is reset in a `try/finally` block, ensuring it is
always cleared even if an unexpected throw occurs mid-collection.

---

## C. Supervisor

### Startup command
```bash
cd /home/z/my-project/edge-engine
( setsid bash -c '
  cd /home/z/my-project/edge-engine
  exec >> logs/daemon-supervisor.log 2>&1
  bash scripts-explore/daemon-supervisor.sh
' </dev/null >/dev/null 2>&1 & )
```

### Monitored daemons (11)
1. telegram-listener
2. command-handler
3. realtime-opp-alerts
4. opp-db
5. hl-funding-alerts
6. paper-trader
7. risk-dashboard
8. wallet-funding-alert
9. realtime-spread-monitor
10. khype-timeseries (DefiLlama yield collector)
11. limusd-monitor (PT-LIMUSD on-chain monitor)

Note: `khype-cadence-sampler` (A.2) is newly deployed and will be added
to the supervisor in a follow-up commit.

### Restart behavior
Checks every 60 seconds. If a daemon process is not found, restarts
it via the double-fork pattern.

### Duplicate-worker protection
The launcher uses `pkill` before starting to prevent duplicates. The
supervisor checks `ps aux | grep tsx.*<script>` before restarting. The
limUSD monitor also has an in-process `collecting` flag with try/finally
to prevent overlapping collection cycles within a single process.

**Limitation:** There is no PID-file-based lock. If `launch-all-daemons.sh`
is run while daemons are already running, it may start duplicate processes.
Always run `pkill -f 'tsx'` before re-launching.

---

## D. 24-hour runtime acceptance test (P3)

### Acceptance window history

**Window 1 (COMPROMISED):**
- Start: 2026-10-14T16:36:56Z (commit `7448155`, corrected monitor)
- Gap: 2026-10-14T18:47:59Z → 2026-10-15T04:51:31Z (~10 hours)
- Cause: Daemons died during session boundary; restarted on 2026-10-15T04:51Z
- Verdict: FAIL — gap exceeds 60-minute threshold. Window does NOT count.

**Window 2 (CURRENT — in progress):**
- Start: 2026-10-15T04:51:31Z (first observation after restart)
- Deployed commit: `7afc07d`
- Nominal completion: 2026-10-16T04:51:31Z
- Status: PENDING — accumulating observations

### Session-boundary limitation
The Manager's attended session may end at any time. When the session ends,
the daemons continue running via `setsid` but the Manager cannot verify
this without a live session. If a gap is detected on the next session,
the window is restarted from the first post-gap observation per the
documented protocol. A successful 24h window requires uninterrupted
daemon operation across session boundaries.

### Pass criteria
1. No gaps > 60 minutes in observation timestamps without an explicit
   restart log entry
2. Timestamped observations across the full 24h window from raw JSONL
3. All LIMUSD observations have non-null NAV/share-price/expiry fields
4. `readFailures` accurately reports any problems
5. No duplicate-worker evidence
6. All read failures recorded (not hidden)

### Evidence paths
- LIMUSD observations: `data/limusd-study/observations.jsonl`
- LIMUSD logs: `logs/limusd-monitor.log`
- kHYPE DefiLlama observations: `data/khope-study/observations.jsonl`
- kHYPE cadence observations: `data/khope-study/cadence-observations.jsonl`
- kHYPE logs: `logs/khype-timeseries.log`, `logs/khype-cadence-sampler.log`
- Supervisor log: `logs/daemon-supervisor.log`

---

## E. Manager-reported vs independently-verified evidence

**Manager-reported** (this document):
- Process status via `ps aux`
- Sample counts via `wc -l` on JSONL files
- Log freshness via `tail` on log files

**Independently-verified** (EI-S007):
- Contract identities (on-chain name/symbol/decimals reads)
- Function selectors (keccak256 computation)
- Supply values (independent eth_call reads)
- NAV and share price (independent NAVOracle reads)
- Redemption buffer (independent USDC.balanceOf reads)

Manager-reported process status is NOT the same as independently-archived
timestamped evidence. The `data/` and `logs/` directories are gitignored
and not committed to the repo. EI cannot verify Manager-side runtime
claims from outside the environment.
