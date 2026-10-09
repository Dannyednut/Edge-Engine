# VOOI Bot Reality Check — Official VOOI Funding Arb Bot Analysis

> **Source**: https://github.com/vooi-app/vooi-funding-bot-example
> **Date**: Oct 7 2026

## Key Findings from VOOI's Official Bot

### Realistic Return Expectations
- **VOOI's own estimate**: "low single-digit percentages monthly, highly variable"
- This means ~1-5% per month = 12-60% APR (NOT the 500-3000% we estimated)
- The high APRs we see are REAL but they don't last — they "collapse fast"

### Bot Configuration (from .env.example)
| Parameter | Value | Our Setting |
|-----------|-------|-------------|
| Leg collateral | $10 | $5,000 |
| Max notional per position | $100 | $5,000 |
| Leverage target | 10x | 1x |
| Leverage cap | 5x | 1x |
| Max margin per exchange | $120 | $25,000 |
| Min net APR | 70% | 200% |
| **Max net APR** | **120%** | **No cap** |
| APR upper cap | 200% | No cap |
| Max slippage per leg | 2% (200 bps) | Not filtered (NOW FIXED) |
| Max adverse basis | 0.3% (30 bps) | Not filtered |
| Max hold hours | 96 (4 days) | 24h |
| Stop loss | 5% of collateral | Not set (NOW ADDED) |
| Min hold hours | 12 | 0 |

### Critical Insights
1. **VOOI recommends $10 per leg** — they use HIGH leverage (10x) to get $100 notional
   - We planned $5,000 per position at 1x — this is actually SAFER but uses more capital
2. **Max APR cap of 120%** — they filter OUT opportunities >120% APR because they "collapse fast"
   - Our top opportunities (500-1000%+ APR) may be ephemeral
3. **12-hour minimum hold** — they don't close positions for 12h after opening
   - This prevents "chasing noise" — funding pays hourly, not minutely
4. **Adverse basis check (30 bps)** — they reject entries where the price spread is already >0.3%
   - This is for FUNDING arbs, not PRICE arbs (different strategy)
5. **96-hour max hold** — they hold for up to 4 days
   - Our price spread arbs are INSTANT (no hold) — different and better

### What This Means for Our Strategy

#### Funding Rate Arb (8-24h hold)
- VOOI's realistic estimate: 12-60% APR (not 500%+)
- The 500%+ APRs are REAL but DECAY FAST
- VOOI recommends 70-120% APR as the sweet spot
- Expected realistic return: $25k × 30% APR = $7,500/yr (not $124k/yr)

#### Price Spread Arb (INSTANT capture)
- This is a DIFFERENT strategy from VOOI's funding bot
- VOOI's bot is for FUNDING rate capture (held 12-96h)
- Our price spread arb is for PRICE differences (instant, no hold)
- VOOI doesn't have an official price spread bot — this is our UNIQUE edge
- The 4-5% price spreads in private AI companies are STRUCTURAL (not ephemeral)
- Persistence verified at 90% over 2.5 min

### Revised Projections

| Strategy | Capital | Old Estimate | Revised Estimate | APR |
|----------|---------|-------------|-----------------|-----|
| VOOI Price Spread (instant) | $25k | $1.2M/yr | $449k/yr* | 1,796% |
| VOOI Funding Rate (8-24h) | $25k | $124k/yr | $7.5-15k/yr** | 30-60% |
| kHYPE LST Carry | $5k | $3,393/yr | $3,393/yr | 68% |
| Euler USDC Lending | $5k | $376/yr | $376/yr | 7.5% |
| **Total** | **$60k** | **$1.33M/yr** | **$460k/yr** | **767%** |

*Price spread arb: $986/cycle × 3 cycles/day × 50% capture × 365 = $540k → $449k after VOOI fees
**Funding arb: VOOI's own "low single-digit % monthly" = 12-60% APR on $25k

### Action Items
1. **Price spread arb is our #1 strategy** — VOOI doesn't have this, it's unique to us
2. **Funding rate arb should use VOOI's parameters** — 70-120% APR filter, 12h min hold, 96h max hold
3. **Use leverage to increase capital efficiency** — VOOI uses 10x, we use 1x
4. **Add adverse basis check** — reject entries where price spread >0.3% for funding arbs
5. **Add APR ratio filters** — reject 1h spikes vs 24h (BOT_APR_RATIO_1H_TO_24H_MAX=5)
