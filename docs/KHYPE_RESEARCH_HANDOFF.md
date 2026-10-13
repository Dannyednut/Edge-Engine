# kHYPE Yield Study — Research Handoff

**Generated:** Oct 13, 2026, 12:30 UTC
**Author:** Edge-Engine Manager
**Status:** ONGOING (time-series collection in progress)

## Purpose

This document provides Edge Intelligence (and the principal) with a
sanitized, durable summary of the kHYPE yield time-series being collected
by the `khype-timeseries` daemon. Raw observations live in
`data/khope-study/observations.jsonl` (gitignored), so this handoff is
the committed, reviewable artifact.

## Collector status

- **Module:** `packages/scanner/src/runners/khype-timeseries.ts`
- **Daemon status:** RUNNING (verified via `ps aux` — PID matches
  `khype-timeseries.ts` process)
- **Poll interval:** 30 minutes (1800s)
- **Data source:** DefiLlama `https://yields.llama.fi/pools` (public, no auth)
- **Zero-capital:** No `.env` loading, no wallet access, no trades
- **Overlap guard:** Enabled (prevents concurrent collection cycles)
- **Hardened on:** Oct 13, 2026 (removed .env, added full pool identity,
  distinguished missing from zero, added failure logging)

## Verified pool identity

The primary subject of the study:

| Field | Value |
|-------|-------|
| Label | `khype_staking` |
| DefiLlama pool ID | `9f25a954-db87-4bb2-a8b2-4be0b843a44c` |
| Chain | Hyperliquid L1 |
| Project | kinetiq-khype |
| Symbol | KHYPE |
| APY (latest sample) | 1.92946% |
| APY base | 1.92946% |
| APY reward | null (no reward token) |
| TVL | $851,782,304 |

## Sample count and period covered

- **First sample (v1, pre-hardening):** Oct 13, 11:34 UTC
- **Hardened collector started:** Oct 13, 12:27 UTC
- **Latest sample at handoff time:** Oct 13, 12:27 UTC
- **Total samples:** 1 (hardened schema) + 2 (v1 schema, archived)
- **Period covered:** < 1 hour (collection just started)
- **Missing observations:** None yet (too early to assess)

> **Assessment:** The time-series is too short for yield-persistence
> analysis. A minimum of 24–48 hours of samples is needed before any
> conclusion about yield stability can be drawn. The collector is running
> and will accumulate samples automatically.

## Rate distribution

Insufficient data. With only 1 hardened sample, no distribution can be
computed. The single observation shows kHYPE staking APY at 1.92946%,
consistent with the prior v1 observation of 1.92748% (11:49 UTC) and
1.93% (11:34 UTC, from the initial DefiLlama pull).

## Source pool identities (watched)

The collector watches for 5 pool categories. Only `khype_staking` has
matched so far. The other 4 (`whype_khope_nest`, `whype_khope_ramses`,
`khype_morpho`, `khype_hyperlend`) did not match any pool in the latest
scan — this means either (a) those pools are not listed on DefiLlama,
or (b) their naming doesn't match our selectors. This is recorded as
"missing" (not zero) in the observation schema.

## Statement on collector runtime

**The collector was observed running at 12:30 UTC on Oct 13, 2026.**
Verification:
- Process listed in `ps aux` output: `node .../tsx/cli.mjs packages/scanner/src/runners/khype-timeseries.ts`
- Log file `logs/khype-timeseries.log` shows the startup banner and successful first sample
- Data file `data/khope-study/observations.jsonl` contains the hardened-schema observation

The daemon-supervisor.sh will auto-restart the collector if it crashes.

## Next steps for this study

1. **Wait 24–48 hours** for sufficient samples to accumulate.
2. **Re-run this handoff** with the accumulated data (sample count,
   min/max/mean/stddev APY, missing-observation count, pool-identity
   verification).
3. **If yield is stable** (low variance over 48h): document as a
   verified yield source for future capital deployment consideration.
4. **If yield is volatile**: document the volatility pattern and
   identify correlation with other HyperEVM yield pools.

## How to inspect the raw data

```bash
# Count samples
wc -l data/khope-study/observations.jsonl

# View latest sample (pretty-printed)
tail -1 data/khope-study/observations.jsonl | python3 -m json.tool

# View all samples (one per line)
cat data/khope-study/observations.jsonl | python3 -c "
import sys, json
for line in sys.stdin:
    obs = json.loads(line)
    print(f\"{obs['ts']} status={obs['apiStatus']} matched={obs['matchedPools']}\")
"
```

## Archived v1 observations

The pre-hardening observations (2 samples, old schema) are archived at
`data/khope-study/observations-v1-archived.jsonl` (gitignored). They used
a flatter schema without full pool identity and are kept for traceability
but should not be used for analysis.
