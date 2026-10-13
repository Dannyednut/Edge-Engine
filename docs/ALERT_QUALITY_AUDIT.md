# Alert-Quality Audit — Oct 13, 2026

## Executive summary

Of 34,776 opportunities recorded in the database, **62.4% have negative
spreads** (not actionable), only **21.4% exceed the 0.5% minimum edge**,
and **0 alerts have been sent** despite the alert pipeline being active.
The opportunity database is accumulating noise, not signal.

## Methodology

- **Source:** `data/opportunities.db` (SQLite, 4.0MB)
- **Sample:** All 34,776 records (full population, not a sample)
- **Timestamp:** Oct 13, 2026, 14:29 UTC
- **Tools:** Python `sqlite3` module (no `sqlite3` CLI available)

## Findings

### 1. Spread distribution (full population, n=34,776)

| Category | Count | Percentage |
|----------|-------|------------|
| Positive spread | 13,083 | 37.6% |
| Negative spread | 21,693 | 62.4% |
| Spread > 0.5% (min edge) | 7,438 | 21.4% |

**Problem:** 62.4% of recorded "opportunities" have negative spreads —
they are price differences in the wrong direction, not arbitrage
opportunities. Recording them pollutes the database and makes it
impossible to assess true opportunity frequency.

**Root cause:** The `opp-db` daemon appears to record every price
difference it sees, regardless of direction or magnitude. The `all-runner.ts`
scanner applies a `min_edge_bps` filter for alerts but the `opp-db`
recorder does not apply the same filter.

### 2. Zero alerts sent

| Metric | Value |
|--------|-------|
| Opportunities recorded | 34,776 |
| Alerts sent | 0 |

**Problem:** Despite 7,438 opportunities exceeding the 0.5% min edge,
zero alerts have been sent to Telegram. This means either:
- The alert pipeline is broken (alerts not reaching Telegram)
- The alert dedup window (5 min) is suppressing all alerts
- The alert filter in `all-runner.ts` is too aggressive (e.g., requiring
  `netApr >= 8` for perp alerts, `netProfitUsd >= 20` for dex-cex)

**Evidence:** The `alerts` table in the database is empty. The Telegram
listener log shows the bot is running and connected. The gap is between
opportunity detection and alert dispatch.

### 3. Top assets by opportunity count

| Asset | Count | Avg spread | Assessment |
|-------|-------|------------|------------|
| alias:brent | 3,976 | +0.08% | Oil future alias — low spread, likely illiquid |
| FOLKS | 3,570 | -0.22% | Negative avg — mostly noise |
| alias:natgas | 3,192 | -0.13% | Natural gas alias — negative avg |
| alias:anthropic | 2,720 | -0.04% | Private company perp — cannot verify execution |
| alias:openai | 2,720 | -0.02% | Private company perp — cannot verify execution |
| RSR | 2,650 | -0.16% | Negative avg — mostly noise |
| SIREN | 2,560 | -0.08% | Negative avg — mostly noise |
| alias:oura | 1,632 | -0.42% | Private company perp — negative avg |
| ONE | 1,392 | -0.07% | Negative avg — mostly noise |
| CATE | 816 | -1.14% | Strongly negative — pure noise |

**Problems:**
- **"alias:" assets** (brent, natgas, anthropic, openai, oura) are
  Hyperliquid HIP-3 alias markets — synthetic instruments that reference
  external assets. These may not be executable via standard perp
  infrastructure and their settlement is different from standard perps.
- **8 of 10 top assets have negative average spreads** — they are
  generating mostly noise, not opportunities.
- **FOLKS** appears 3 times in the recent actionable list with identical
  spread and profit values — suggesting duplicate recording within a
  single scan cycle.

### 4. Recent actionable opportunities (spread > 0.5%)

| Time | Type | Asset | Spread | Est. profit ($5k) |
|------|------|-------|--------|--------------------|
| 14:29 | PRICE | SI | 0.507% | $10.34 |
| 14:29 | PRICE | alias:play | 0.522% | $11.08 |
| 14:29 | PRICE | USO | 0.556% | $12.80 |
| 14:29 | PRICE | IBB | 0.558% | $12.89 |
| 14:29 | PRICE | SECZ | 0.562% | $13.12 |
| 14:29 | PRICE | FOLKS | 0.542% | $12.10 (×3 duplicates) |
| 14:29 | PRICE | POD | 0.585% | $14.27 |

**Problems:**
- **SI** (Silver), **USO** (Oil ETF), **IBB** (Biotech ETF) — these are
  traditional finance instruments, not crypto. They may be HIP-3 alias
  markets with different settlement and execution characteristics.
- **FOLKS appears 3 times** with identical values — duplicate recording
  bug.
- All spreads are barely above the 0.5% threshold — in real execution
  with fees (0.1-0.3% per leg) and slippage (0.05-0.2%), most of these
  would be unprofitable.

## Recommendations

### P1 — Stop recording negative-spread "opportunities"
The `opp-db` daemon should apply the same `min_edge_bps` filter as the
alert pipeline. Recording negative spreads wastes storage and makes the
database useless for opportunity-frequency analysis.

### P2 — Fix the alert dispatch gap
Investigate why 7,438 actionable opportunities produced 0 alerts. Check:
- The `realtime-opp-alerts.mts` daemon's filter thresholds
- The alert dedup window (5 min may be too aggressive)
- The Telegram alerter's error handling (silent failures?)

### P3 — Classify and filter alias markets
"alias:" assets (brent, natgas, anthropic, openai, oura, play) should be
tagged as a separate market type. They have different settlement,
execution, and risk characteristics. The scanner should either:
- Exclude them by default (safer)
- Tag them in alerts so the principal knows they're alias markets
- Add a separate `include_alias_markets` config flag

### P4 — Fix duplicate recording
FOLKS appearing 3× with identical values suggests the `opp-db` recorder
is inserting the same opportunity multiple times per scan. Add a
unique constraint on (ts, type, asset, venues) or dedup before insert.

### P5 — Add execution-feasibility check
A 0.5% spread on an alias market with unknown liquidity is not the same
as a 0.5% spread on BTC/ETH with deep order books. The opportunity
record should include a `liquidity_usd` or `executable` field so the
principal can filter by real executability.

## Sample denominator disclosure

- **Total opportunities in database:** 34,776 (full population)
- **Time period:** ~3 days of continuous scanning
- **Scan frequency:** ~5 seconds (realtime-spread-monitor)
- **Alerts sent:** 0
- **Alerts expected (spread > 0.5%):** 7,438
- **Alert dispatch rate:** 0/7,438 = 0%

This is a 0% alert dispatch rate on actionable opportunities. The alert
pipeline is non-functional for this dataset.
