# Persistent Sampling Infrastructure — P2/P3 Documentation

**Created:** 2026-10-14, 14:06 UTC
**Status:** ACTIVE — daemons supervised and collecting

## Overview

Two zero-capital research monitors run as supervised daemons, collecting
timestamped observations to persistent JSONL files. Both are restartable
via the daemon supervisor and recover automatically from crashes.

## A. kHYPE Reward Cadence Collector

### Startup command
```bash
cd /home/z/my-project/edge-engine
bash scripts-explore/launch-all-daemons.sh  # includes khype-timeseries
```

### Environment requirements
- Node.js 22+
- tsx (installed in node_modules)
- No API keys required (zero-capital, public DefiLlama API)

### Log location
`logs/khype-timeseries.log`

### Data path
`data/khope-study/observations.jsonl` (append-only JSONL)

### Poll interval
30 minutes (1800s, configurable via `KHYPE_POLL_INTERVAL_SEC`)

### What it records
Each observation: timestamp (UTC), source, apiStatus, fetchMs,
totalPoolsScanned, matchedPools, and per-pool metadata (poolId, chain,
project, symbol, APY, TVL). Missing data is recorded as `null` (not
zero) to distinguish from a true zero yield.

### Restart procedure
The daemon is included in `launch-all-daemons.sh` and monitored by
`daemon-supervisor.sh`. If it crashes, the supervisor restarts it
within 60 seconds. The double-fork pattern (`setsid bash -c '...'`)
ensures it survives terminal disconnect.

### Current sample count
9 samples (accumulating since 2026-10-13 12:27 UTC). kHYPE staking
yield stable at ~1.93% across all samples.

### kHYPE cadence protocol (per EI-S006)
The DefiLlama-based collector tracks yield persistence. The full
cadence protocol (EI-001-E2) requires on-chain `totalRewards()` reads
which are not yet wired into the TypeScript collector. The EI Python
sampler (`scripts/eis006_khype_cadence.py`) validates the protocol;
integration into the TypeScript daemon is a future task.

## B. PT-LIMUSD Monitor (EI-010-V2 corrected)

### Startup command
```bash
cd /home/z/my-project/edge-engine
# Started via double-fork daemon:
( setsid bash -c '
  cd /home/z/my-project/edge-engine
  exec >> logs/limusd-monitor.log 2>&1
  while true; do
    ./node_modules/.bin/tsx packages/scanner/src/runners/limusd-monitor.ts
    sleep 5
  done
' </dev/null >/dev/null 2>&1 & )
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

### What it records
Each observation: timestamp (UTC), block number, source, and:
- limUSD total supply (raw bigint + decimal-adjusted string, 18-dec)
- PT-limUSD total supply (raw bigint + decimal string, 6-dec)
- SY-limUSD total supply (raw bigint + decimal string, 18-dec)
- NAV from NAVOracle (raw bigint + decimal string)
- Share price (NAV / limUSD supply, exact bigint division)
- Redemption buffer (USDC.balanceOf(RedemptionPipe), raw bigint + USD)
- PT expiry (from PT.expiry(), Unix timestamp + ISO date)
- DefiLlama APY/TVL for PT and underlying pools
- Per-field read failures (distinguishes RPC failure from real zero)
- Alert list with transition-based deduplication

### Alert thresholds
- Share-price change > 0.5% per day (transition-based, 1h cooldown)
- Redemption buffer < $50,000 (pre-existing breach recorded once)

### Restart procedure
Started via double-fork daemon. Not yet in `launch-all-daemons.sh` —
must be started separately (command above). Will be added to the
launcher in a future commit.

### Current sample count
1 sample (2026-10-14T14:05:59Z). All supplies correct. NAVOracle
read failed (selector issue — documented as known limitation).

### Known limitation
The NAVOracle `getNAV()` selector (`0x41976e09`) returns empty on this
RPC node. The share price cannot be calculated without NAV. This is
documented in the observation's `readFailures` field. The EI Python
monitor uses a different RPC or selector; integration of the correct
selector is a future task.

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

### Monitored daemons (10 + limUSD = 11)
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
11. limusd-monitor (not yet in supervisor DAEMONS array — future task)

### Restart behavior
Checks every 60 seconds. If a daemon process is not found, restarts
it via the double-fork pattern.

## D. 24-hour runtime acceptance test (P3)

### Protocol
1. **Start timestamp:** 2026-10-14T14:05:59Z (first limUSD observation
   after the corrected monitor deployment at commit `bc55dba`)
2. **Deployed commit:** `bc55dba` (EI-010-V2 corrected monitor)
3. **Required window:** 24 hours from start timestamp
4. **Pass criteria:**
   - Daemon uptime evidence (no gaps > 60 minutes in observation
     timestamps without an explicit restart log entry)
   - Timestamped observations across the full 24h window
   - Zero observations with spread sign inconsistent with allMids-based
     recomputation (for @-pair normalizer)
   - Zero DefiLlama yield candidates with poolMeta="Hyperliquid Vault"
   - All read failures recorded (not hidden)
5. **Gap handling:** If continuity breaks, state the gap, restart, and
   qualify the acceptance window accordingly.

### Current status
**IN PROGRESS** — 1 sample collected. 24h window will complete at
2026-10-15T14:05:59Z. Cannot be claimed complete until the full window
elapses with the daemons running.

### Limitation
The platform session may terminate before 24 hours elapse. If the
session ends, the daemons continue running in the background (via
`setsid`), but the Manager cannot verify this without a live session.
The next session should check:
- `data/limusd-study/observations.jsonl` line count
- `data/khope-study/observations.jsonl` line count
- `logs/limusd-monitor.log` tail for recent timestamps
- `logs/khype-timeseries.log` tail for recent timestamps
