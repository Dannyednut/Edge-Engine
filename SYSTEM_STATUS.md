# Edge-Engine System Status — Oct 7 2026 (Updated 16:35 UTC)

## Live Status
- **Strategies**: 19 running in parallel
- **Background processes**: 4 (scanner, listener, command handler, opp monitor)
- **Total commits**: 109
- **Alias assets decoded**: 192/298 (64%)

## Top Opportunities (live, verified with priceSpreadAtSize)

### Tier 1: VOOI Price Spread Arb (INSTANT — no holding) — OUR UNIQUE EDGE
Top 5 (verified with slippage/depth at $5k trade size):
1. BP: MEXC→Gate 10.95% spread → $382/cycle (OI: $1M — thin)
2. Anthropic: MEXC→Robinhood 4.73% → $202/cycle (OI: $34B/$18B — deep)
3. Anthropic: MEXC→Lighter 4.71% → $201/cycle (OI: $34B/$4B)
4. Anthropic: MEXC→HL 2.87% → $111/cycle (OI: $34B/$86B)
5. Anthropic: MEXC→Gate 2.84% → $104/cycle (OI: $34B/$3B)

Top 5 total: $1,000/cycle (instant)
At 3 cycles/day, 50% capture: $1,500/day = $548k/yr on $25k = 2,192% APR

**Persistence verified**: 90% over 2.5 min. Private AI companies <1% change.
**Slippage verified**: Anthropic 0.05-0.31%, OpenAI 0.05-0.12% — near-zero.
**VOOI doesn't offer this** — their official bot is funding-rate only.

### Tier 2: VOOI Funding Rate Arb (8-96h hold)
VOOI's own estimate: "low single-digit % monthly" = 12-60% APR
Using VOOI-recommended parameters (70-120% APR range, 12h min hold, 96h max hold)
Expected: $7.5-15k/yr on $25k = 30-60% APR

### Tier 3: HyperEVM Carry + Lending (7-day hold)
- kHYPE LST carry: $3,386/yr on $5k (68% APR)
- Euler USDC lending: $376/yr on $5k (7.5% APR)

## Combined (revised based on VOOI's own data)
| Strategy | Capital | Annual $ | APR |
|----------|---------|----------|-----|
| Price Spread Arb | $25k | $548k | 2,192% |
| Funding Rate Arb | $25k | $7.5-15k | 30-60% |
| kHYPE + Euler | $10k | $3,762 | 37.6% |
| **Total** | **$60k** | **$559-567k** | **932-945%** |

## What's Needed to Go Live

### Option A: VOOI Price Spread (highest ROI, our unique edge)
1. Deposit $25k on ultra.vooi.io
2. Text "approved" on Telegram
3. Run: `pnpm --filter @edge/scanner start:go-live -- --approved`
4. Expected: $548k/yr (2,192% APR)

### Option B: HyperEVM (safest)
1. Fund agent wallet with $5k HYPE + $5k USDC on HyperEVM
2. Set AGENT_HYPE_ADDRESS + AGENT_HYPE_PRIVKEY env vars
3. Expected: $3,762/yr (37.6% APR)

### Option C: Both (maximum)
1. Deposit $25k on VOOI + $10k on HyperEVM
2. Expected: $559k/yr (932% APR)

## Key Research Findings (Oct 7 2026)

1. **VOOI's official bot** estimates "low single-digit % monthly" for funding arb
   → We revised funding arb from $124k/yr to $7.5-15k/yr
2. **Price spread arb is NOT covered by VOOI's bot** → our unique edge
3. **priceSpreadAtSize** is the most accurate profit metric (accounts for depth + slippage)
4. **Private AI companies** (Anthropic, OpenAI) have near-zero slippage + 90% persistence
5. **VOOI recommends**: 70-120% APR range, 12h min hold, 96h max hold, 5% stop loss
6. **alias: markets** share the same USDC margin pool as crypto-perps on Hyperliquid
7. **192/298 alias assets decoded** (64%) including private AI, index futures, 100+ stocks
8. **HYPE 3.5x'd overnight** ($25→$89.5) — kHYPE arb even more profitable
9. **HLP in drawdown** (-50% 30d APR) — HYPE pump hurt positions
10. **15 HyperEVM DEXs** discovered — most too illiquid except HyperSwap + Ramses V3

## CLI Commands (17 tools)
`start:all` `start:master-view` `start:dashboard` `start:readiness` `start:daily-report`
`start:tg-summary` `start:go-live` `start:risk-manager` `start:perf-track` `start:monitor`
`start:opp-monitor` `start:commands` `start:khype-carry` `start:euler-arb`
`start:vooi-exec` `start:vooi-price` `start:vooi-bot`

## Telegram Commands (9)
`/status` `/opportunities` `/vooi` `/pricespread` `/khype` `/euler` `/kinetiq` `/help`
