# Edge-Engine System Status — Oct 7 2026

## Live Status
- **Strategies**: 19 running in parallel
- **Background processes**: 4 (scanner, listener, command handler, opp monitor)
- **Total commits**: 102
- **Alias assets decoded**: 192/298 (64%)

## Top Opportunities (live, updating every 60s)

### Tier 1: VOOI Price Spread Arb (INSTANT — no holding)
- Anthropic: MEXC→Robinhood 4.6% = $215/cycle (OI: $33B/$18B)
- OpenAI: MEXC→Lighter 3.3% = $151/cycle (OI: $17B/$3B)
- Top 5 total: ~$1,000/cycle → $1.1M/yr at 3 cycles/day on $25k

### Tier 2: VOOI Funding Rate Arb (8-24h hold)
- NMR: bybit→lighter 1000%+ APR = $160/day
- SoftBank: MEXC→HL 450% APR = $62/day
- Top 5 total: ~$300/day → $110k/yr on $25k

### Tier 3: HyperEVM Carry + Lending (7-day hold)
- kHYPE LST carry: $3,393/yr on $5k (68% APR)
- Euler USDC lending: $376/yr on $5k (7.5% APR)

## Combined: $1.48M/yr on $65k = 2,274% APR

## What's Needed to Go Live

### Option A: VOOI First (highest ROI)
1. Deposit $25-50k on ultra.vooi.io
2. Text "approved" on Telegram
3. Run: `pnpm --filter @edge/scanner start:go-live -- --approved`
4. Expected: $910k-1.15M/yr (1,820-2,300% APR)

### Option B: HyperEVM First (safest)
1. Fund agent wallet with $5k HYPE + $5k USDC on HyperEVM
2. Set AGENT_HYPE_ADDRESS + AGENT_HYPE_PRIVKEY env vars
3. Run: `pnpm --filter @edge/scanner start:go-live -- --approved`
4. Expected: $3,769/yr (37.7% APR)

### Option C: Both (maximum)
1. Deposit $25k on VOOI + $10k on HyperEVM
2. Run: `pnpm --filter @edge/scanner start:go-live -- --approved`
3. Expected: $1.48M/yr (2,274% APR)

## CLI Commands

| Command | Purpose |
|---------|---------|
| `start:all` | 19-strategy scanner |
| `start:master-view` | ALL opportunities ranked |
| `start:dashboard` | Top opportunities dashboard |
| `start:readiness` | 14-point system check |
| `start:daily-report` | Daily markdown report |
| `start:tg-summary` | Send summary to Telegram |
| `start:go-live` | Start live trading |
| `start:risk-manager` | Position limits + P&L targets |
| `start:perf-track` | Opportunity logging |
| `start:monitor` | Position monitor |
| `start:opp-monitor` | Continuous alerting |
| `start:commands` | Telegram command handler |
| `start:khype-carry` | kHYPE LST carry arb |
| `start:euler-arb` | Euler HL lending arb |
| `start:vooi-exec` | VOOI funding rate arb |
| `start:vooi-price` | VOOI price spread arb |
| `start:vooi-bot` | Create autonomous VOOI bot |

## Telegram Commands
`/status` `/opportunities` `/vooi` `/pricespread` `/khype` `/euler` `/kinetiq` `/help`

## Key Discoveries (Oct 7 2026)
1. **298 tokenized real-world assets** on Hyperliquid via HIP-3
2. **Private AI companies** tradeable: Anthropic ($33B OI), OpenAI ($17B OI)
3. **Index futures**: Nasdaq 100 ($1.28T OI), S&P 500 ($683B OI)
4. **Price spread arbs**: 25+ opportunities, 2-12% spreads, instant capture
5. **Funding rate arbs**: 273+ opportunities, 100-1100% APR
6. **HYPE 3.5x'd overnight** ($25→$89.5)
7. **HLP in drawdown** (-50% 30d APR)
8. **15 HyperEVM DEXs** discovered
9. **192 alias: assets decoded** (64% of 298)
10. **Euler V2 live** on HyperEVM with 58 vaults
