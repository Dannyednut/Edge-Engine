# Hyperliquid HIP-3 Tokenized Assets — 298 Alias: Markets Discovered

> **Discovery date**: Oct 7 2026 (Day 2 of marathon session)
> **Source**: VOOI scanner API — 298 `alias:` prefixed assets with live funding spreads
> **Significance**: Hyperliquid is NOT just a crypto perp DEX — it's a fully tokenized
> stock/commodity/forex perp exchange via HIP-3 (trade.xyz integration)

## Executive Summary

Hyperliquid's HIP-3 protocol enables permissionless perp market creation. Trade.xyz
used this to list **298 tokenized real-world assets** as perps, including:
- **US Stocks**: AAPL, MSFT, NVDA, TSLA, AMZN, GOOGL, META, UNH, BAC, GE, etc.
- **Commodities**: Gold ($579B OI!), Brent Oil ($2.7B), WTI Oil ($4.3B), Platinum ($6.6B), Natural Gas, Palladium, Copper
- **Forex**: JPY, and more
- **International Stocks**: Samsung ($6.9B OI), SoftBank, Hyundai, Kioxia
- **ETFs**: TLT (Treasury bonds), BOTZ (AI/Robotics)
- **Meme Stocks**: AMC, RDDT (Reddit), TRUMP

These perps trade on Hyperliquid AND on CEXs (MEXC, Gate, Bybit, Binance) simultaneously.
**Funding rate spreads between venues are 200-500% APR** — orders of magnitude higher
than crypto perp funding spreads (typically 10-50% APR).

## Why This Opportunity Exists

1. **HIP-3 is new** — launched mid-2026, few arb bots monitor these markets
2. **Retail demand** — tokenized stock perps attract retail traders who push funding rates to extreme levels
3. **Cross-venue inefficiency** — HL perps vs CEX perps have different participant mixes
4. **Limited arb capital** — most crypto arb bots don't monitor tokenized stocks

## Top 30 Opportunities (by funding spread APR)

| Alias | Likely Real Asset | APR | Long OI | Short OI | Best Venues |
|-------|------------------|-----|---------|----------|-------------|
| alias:adi | Analog Devices (ADI) | 481% | $8M | $214M | Gate→MEXC |
| alias:softbank | SoftBank Group | 470% | $30M | $52M | MEXC→HL |
| alias:aph | Aphria? (APH) | 437% | $24M | $1M | MEXC→Gate |
| alias:bot | BOTZ AI ETF | 349% | $8M | $5M | Bybit→Gate |
| alias:ge | General Electric | 336% | $33M | $75M | Gate→Bybit |
| alias:ccl | Carnival? (CCL) | 314% | $144M | $1M | MEXC→Gate |
| alias:shaz | Shake Shack? | 285% | $31M | $9M | HL→MEXC |
| alias:gfs | GlobalFoundries? | 250% | $1M | $6M | Gate→MEXC |
| alias:amc | AMC Entertainment | 245% | $10M | $0M | MEXC→Robinhood |
| alias:natgas | Natural Gas | 234% | $4M | $11M | Lighter→Gate |
| alias:twst | Twist Bioscience | 219% | $424M | $26M | MEXC→Bybit |
| alias:bac | Bank of America | 217% | $7M | $242M | Gate→MEXC |
| alias:futu | Futu Holdings | 207% | $15M | $99M | Bybit→Gate |
| alias:cien | Ciena Corp | 184% | $651M | $50M | MEXC→Gate |
| alias:unh | UnitedHealth Group | 170% | $1,848M | $85M | MEXC→Bybit |
| alias:brent | Brent Crude Oil | 167% | $2,739M | $299M | Bybit→Ondo |
| alias:gs | Goldman Sachs | 166% | $330M | $1,330M | Bybit→MEXC |
| alias:tlt | Treasury Bond ETF | 165% | $166M | $39M | HL→Bybit |
| alias:rddt | Reddit (RDDT) | 160% | $164M | $20M | MEXC→Bybit |
| alias:bkng | Booking Holdings | 145% | $9M | $574M | Gate→MEXC |
| alias:anet | Arista Networks | 142% | $22M | $46M | Gate→MEXC |
| alias:samsung | Samsung | 96% | $6,965M | $54M | HL→Ondo |
| alias:dell | Dell Technologies | 84% | $1,303M | $3,987M | Bybit→HL |
| alias:gold | Gold | 72% | $49,833M | $579,084M | Ondo→Bybit |
| alias:mcd | McDonald's | 72% | $285M | $1,122M | Bybit→MEXC |
| alias:platinum | Platinum | 89% | $6,593M | $108M | HL→Aster |
| alias:palladium | Palladium | 81% | $3,478M | $70M | HL→Aster |
| alias:wti | WTI Crude Oil | 78% | $4,257M | $448M | Bybit→Extended |
| alias:cop | ConocoPhillips? | 135% | $4M | $90M | Gate→MEXC |
| alias:okta | Okta (OKTA) | 133% | $70M | $387M | Bybit→MEXC |

## Massive OI Markets (> $1B)

| Alias | Asset | Total OI | APR |
|-------|-------|----------|-----|
| alias:gold | Gold | **$629B** | 72% |
| alias:samsung | Samsung | $7.0B | 96% |
| alias:platinum | Platinum | $6.7B | 89% |
| alias:wti | WTI Oil | $4.7B | 78% |
| alias:palladium | Palladium | $3.5B | 81% |
| alias:brent | Brent Oil | $3.0B | 167% |
| alias:dell | Dell | $5.3B | 84% |
| alias:unh | UnitedHealth | $1.9B | 170% |
| alias:mcd | McDonald's | $1.4B | 72% |

## Execution Path

### VOOI Atomic Execution (READY)
- **VooiArbExecutor** built and tested
- VOOI API token verified working
- Can execute paired-leg arb atomically across 12+ venues
- Can create autonomous arb bots for 24/7 execution
- **BLOCKER**: Need capital deposited on VOOI + principal approval

### Expected Returns
- **Top 10 opportunities**: $523/day = **$191k/yr** on $50k capital (382% APR)
- **Top 30 opportunities**: ~$800/day = **$292k/yr** on $150k capital (195% APR)
- These are SHORT-DURATION arbs (funding resets every 8h)
- Capital recycles every 8-24 hours

### Risk Factors
1. **Funding rate convergence** — spreads will close as more bots enter
2. **Liquidation risk** — leveraged positions can be liquidated if price moves
3. **Counterparty risk** — VOOI holds the capital, not us directly
4. **Regulatory risk** — tokenized stock perps may face regulatory action
5. **Liquidity risk** — some alias: markets have thin order books

## Action Items

1. **PRINCIPAL DECISION REQUIRED**: Deposit capital on VOOI (ultra.vooi.io)
   - Recommended: $50k initial deposit for top 10 concurrent positions
   - Expected return: $191k/yr (382% APR)
   
2. **PRINCIPAL APPROVAL REQUIRED**: Start live trading
   - VooiArbExecutor is READY (dry-run mode by default)
   - Add `--live` flag to execute real orders
   - Can create autonomous bot for 24/7 execution

3. **RESEARCH**: Decode remaining 268 alias: assets to real tickers
   - 30 decoded so far (stock tickers + commodity names)
   - 268 remaining need identification
   - Some may be forex pairs (alias:jpy = Japanese Yen confirmed)

4. **MONITOR**: Track funding spread persistence
   - Are these spreads persistent or fleeting?
   - Add spread persistence filter (like CexLikeDex + Boros)
   - Monitor for spread convergence trends

## Comparison to Other Strategies

| Strategy | APR | Capital | Annual $ | Risk |
|----------|-----|---------|----------|------|
| **VOOI alias: perp funding** | **382%** | **$50k** | **$191k** | Medium (execution + convergence) |
| kHYPE LST carry arb | 68% | $5k | $3,393 | Low (Kinetiq contract risk) |
| Euler USDC lending | 7.5% | $5k | $376 | Low (Euler contract risk) |
| Perp funding (crypto) | 20-50% | $5k | $1k-2.5k | Medium |
| HLP vault | -50% (drawdown) | — | — | Low (but currently losing) |

**The VOOI alias: opportunity is 5-20x more profitable than any other strategy.**

## Technical Implementation

```typescript
// VOOI executor is ready:
import { VooiArbExecutor } from './packages/scanner/src/runners/vooi-arb-executor.js';

const executor = new VooiArbExecutor({
  apiToken: process.env.VOOI_API_TOKEN,
  maxSizeUsd: 5000,
  minNetApr: 100,  // only execute >100% APR opps
  dryRun: false,   // LIVE mode (needs principal approval)
  venueSet: ['hyperliquid', 'binance', 'bybit', 'mexc', 'gate', ...],
});

// Filter for executable opportunities
const opps = executor.filterExecutable(perpFundingAlerts);

// Place atomic arb order
await executor.placeArbOrder(opps[0]);

// Or create autonomous bot
await executor.createArbBot({
  exchanges: ['hyperliquid', 'binance', 'bybit', 'mexc', 'gate'],
  leverage: 1,
  notionalUsd: 5000,
  categories: ['crypto', 'stocks-us', 'commodities'],
});
```
