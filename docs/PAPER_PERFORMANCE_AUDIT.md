# Paper-Performance Audit — Oct 13, 2026

## Executive summary

The paper trader's reported performance ($181k, +81% ROI, 100% win rate)
is **not a valid measure of strategy execution quality**. It is primarily
a yield accumulator that credits fictional income at hardcoded, unverified
rates on every 5-minute scan cycle. The 100% win rate is structurally
guaranteed by code that skips any trade with net profit ≤ 0.

This audit does not change the paper trader (operational daemon, no
authorization to modify). It documents the integrity gaps so that no
stakeholder treats the numbers as evidence of live-trading viability.

## Paper trader state (observed at 14:26 UTC)

| Metric | Value |
|--------|-------|
| Starting capital | $100,000 |
| Current capital | $181,296 |
| Realized P&L | $81,296 |
| Total trades | 7,990 |
| Winning trades | 7,990 |
| Losing trades | 0 |
| Win rate | 100.0% |
| Total fees paid | $39,950 |
| ROI | 81.30% |
| Days active | ~3 |

## Root causes of inflated performance

### 1. Hardcoded yield assumptions (lines 263, 275)

```
const hlpApr = 1.0;      // 100% APR — UNVERIFIED
const khypeApr = 0.051;  // 5.1% APR — 2.6x the verified 1.93%
```

- **HLP at 100% APR**: The HlpYieldScanner uses `minEntryAprPct: 15` as
  a threshold but does not fetch the actual APR. 100% is a hardcoded
  mid-estimate with no API verification. HLP vault APRs have historically
  ranged from -20% to +200% (highly variable); using a fixed 100%
  overstates performance.
- **kHYPE at 5.1% APR**: Our DefiLlama-verified kHYPE staking yield is
  **1.93%** (4 samples, 1.926-1.929% range). The paper trader uses 5.1%,
  which is 2.6× the verified rate. With 3× leverage (line 280), the
  effective yield is 15.3% — **7.9× the verified rate**.

### 2. Guaranteed 100% win rate (line 227)

```javascript
if (netProfit <= 0) continue;  // Skip if not profitable
```

Any trade that would result in a loss is silently skipped. This
structurally guarantees a 100% win rate. In real trading, partial fills,
slippage, and funding-rate reversals would produce losing trades.

### 3. Instant capture assumption (lines 180-201)

Every VOOI price-spread arb is assumed to:
- Execute instantly at the quoted spread (no slippage)
- Capture the full spread (no partial fills)
- Have 0.1% total fees (optimistic for atomic execution)
- Be captureable 3 times per scan per asset (the `captureCount` logic
  allows repeated captures of the same spread within one scan)

### 4. 24h funding hold completes instantly (lines 221-223)

```javascript
const fundingIncome = notional * spread / 100 * 24; // 24h hold
```

The paper trader credits 24 hours of funding income instantly on each
scan. In reality, the funding rate would change over 24 hours, the
position could be liquidated, and the spread could reverse. The
`closeReason: '12h_hold_complete'` is misleading — no actual hold occurs.

### 5. Scan-frequency yield accumulation (lines 265, 277)

The paper trader runs every 5 minutes (288 scans/day). On each scan it
credits:
- HLP yield: $5000 × 100% / 365 / 288 = $0.0476/scan = $13.70/day
- kHYPE yield: $10000 × 5.1% × 3 / 365 / 288 = $0.0145/scan = $4.19/day

Over 3 days: ~$53.67 from yield alone. This is fictional income
accumulated purely by the passage of time, not by strategy execution.

### 6. No position tracking or capital constraint

The paper trader credits profits to `currentCapital` but does not track
open positions, margin usage, or capital allocation. It simultaneously
claims to have $5000 in HLP and $10000 in kHYPE on every scan, but
these positions are never "opened" or "closed" — they just generate
yield forever. The $15,000 in alleged positions is not deducted from
the $181k capital base.

## Quantitative impact estimate

Of the $81,296 in realized P&L:
- **VOOI price-spread arbs**: ~7,990 trades × ~$10 net = ~$50k-60k
  (each trade assumes $5000 notional × ~0.2% spread × 0.99 fee factor)
- **VOOI funding arbs**: up to 3 per scan × 864 scans × ~$10 = ~$26k
  (but many scans find 0 qualifying arbs, so actual is lower)
- **HLP fictional yield**: ~$13.70/day × 3 days = ~$41
- **kHYPE fictional yield**: ~$4.19/day × 3 days = ~$13

The VOOI arb simulations are the dominant source of P&L. They use real
API spread data but apply unrealistic execution assumptions.

## Recommendations (require authorization to implement)

1. **Fetch actual HLP APR** from the HlpYieldScanner API instead of
   hardcoding 100%. If the API is unavailable, skip the HLP simulation
   rather than using a fabricated rate.
2. **Use verified kHYPE yield** (1.93% from DefiLlama) instead of 5.1%.
   Remove the 3× leverage assumption or document it as a separate
   capital-efficiency multiplier with its own risk profile.
3. **Remove the `netProfit <= 0` skip** (line 227). Losing trades must
   be recorded to produce a valid win rate.
4. **Model execution risk**: add slippage (e.g., 0.05-0.2% per leg),
   partial-fill probability, and funding-rate decay over the hold period.
5. **Track open positions and capital allocation** to prevent the
   fictional $15k from generating yield without being deducted from
   available capital.
6. **Separate "yield accumulation" from "arb execution"** in the P&L
   breakdown so stakeholders can distinguish passive income from active
   trading returns.

## What this audit does NOT do

- Does not modify the paper trader (operational daemon, no authorization).
- Does not claim the VOOI API data is wrong (the spreads are real API
  responses — the issue is the execution assumptions applied to them).
- Does not estimate live-trading performance (that would require
  modeling real slippage, latency, rejection, and funding-rate dynamics,
  which is beyond this audit's scope).

## Conclusion

The paper trader's $181k / 81% ROI / 100% win rate should not be cited
as evidence of strategy viability. The numbers are inflated by hardcoded
yield assumptions, a structural win-rate guarantee, and the absence of
execution-risk modeling. Any investor presentation or principal briefing
that references these figures must include this audit's caveats.
