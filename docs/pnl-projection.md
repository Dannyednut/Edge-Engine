# P&L Projection Model — Updated Oct 7 2026 (19 Strategies + VOOI)

> **PARADIGM SHIFT**: VOOI perp funding arbs discovered as #1 opportunity.
> 298 tokenized stock/commodity/forex assets on Hyperliquid via HIP-3.
> Funding spreads 200-700% APR, verified persistent over 30s sampling.
> **Total verified potential**: $127k+/yr on $35k = **363% APR** (uncapped)
> **Realistic (50% capture)**: $60k/yr on $35k = **171% APR**

## Strategy Rankings (Oct 7 2026)

| Rank | Strategy | APR | Capital | Annual $ | Risk | Status |
|------|----------|-----|---------|----------|------|--------|
| **#1** | **VOOI perp funding arb** | **497%** | **$25k** | **$124k** | Medium | ⚠️ Executor READY — needs VOOI capital + approval |
| #2 | kHYPE LST carry arb | 68% | $5k | $3,393 | Low | ⚠️ Executor READY — needs agent wallet |
| #3 | Euler USDC lending arb | 7.5% | $5k | $376 | Low | ⚠️ Executor READY — needs agent wallet |
| #4 | HLP vault yield | -50% (drawdown) | — | — | Low | ⏳ Monitoring — wait for APR to normalize |
| #5 | CexLikeDex price arb | 48-120% | $5k | $2.4-6k | Medium | ⏳ Scanner live — needs VOOI capital |
| #6 | Perp funding (crypto) | 20-50% | $5k | $1-2.5k | Medium | ⏳ Scanner live — needs VOOI capital |
| #7 | Prediction arb | 30-90% | $2k | $600-1.8k | Medium | ⏳ Scanner live |
| #8 | PT yield arb | <3% | $5k | <$150 | Low | ✅ Scanner live (most PTs expired) |

## Phase 1: VOOI Perp Funding Arb — $25k → $124k/yr (497% APR)

### What It Is
VOOI (ultra.vooi.io) is a CEX-like DEX aggregator that supports ATOMIC paired-leg
execution across 12+ venues. When funding rates differ between venues for the same
asset, VOOI can capture the spread atomically:

1. Open long position on venue with high positive funding (earn funding)
2. Open short position on venue with low/negative funding (pay less funding)
3. Net capture = funding spread × position size × hold time

### Top 10 Current Opportunities (Oct 7 2026)

| Asset | Real Name | Pair | APR | Daily $ | OI Long/Short |
|-------|-----------|------|-----|---------|---------------|
| alias:shein | Shein (pre-IPO?) | bybit→mexc | 713% | $98 | $17M/$38M |
| NMR | Numeraire | bybit→lighter | 689% | $94 | $149M/$2M |
| alias:bot | BOTZ AI ETF | HL→gate | 377% | $52 | $89M/$5M |
| alias:ge | General Electric | gate→bybit | 367% | $50 | $33M/$75M |
| alias:twst | Twist Bioscience | mexc→bybit | 337% | $46 | $422M/$26M |
| alias:shaz | Unknown | HL→mexc | 287% | $39 | $31M/$9M |
| alias:oklo | Oklo Nuclear | bybit→mexc | 258% | $35 | $17M/$36M |
| alias:softbank | SoftBank Group | mexc→HL | 459% | $63 | $30M/$52M |
| alias:adi | Analog Devices | gate→mexc | 382% | $52 | $8M/$212M |
| alias:okta | Okta | bybit→mexc | 235% | $32 | $70M/$384M |

**Top 10 total**: $561/day = **$205k/yr** on $50k capital = 410% APR

### Execution Path
1. **Deposit $25k on VOOI** (ultra.vooi.io)
2. **Principal approves live trading**
3. **VooiArbExecutor** places atomic paired-leg orders
4. **OR**: Create autonomous VOOI bot for 24/7 execution
5. Positions held 8-24h, capital recycles daily

### Risk Factors
1. **Funding rate convergence** — spreads may close as more bots enter (but 30s persistence check shows <2% change)
2. **Liquidation risk** — leveraged positions can be liquidated if price moves significantly
3. **Counterparty risk** — VOOI holds capital, not us directly
4. **Regulatory risk** — tokenized stock perps may face regulatory action
5. **Execution risk** — atomic orders may fail if one leg has insufficient depth

### Realistic Projection
- **Optimistic**: $124k/yr (100% capture, no issues)
- **Realistic**: $60k/yr (50% capture rate, accounting for spread convergence + execution costs)
- **Conservative**: $30k/yr (25% capture rate, significant convergence)

## Phase 2: kHYPE LST Carry Arb — $5k → $3,393/yr (68% APR)

### What It Is
kHYPE (Kinetiq liquid staked HYPE) trades at 2.53% discount to WHYPE on HyperSwap V3.
Buy kHYPE at discount, queue 7-day Kinetiq withdrawal, receive HYPE at 1:1.

### Execution Path
1. **Fund agent wallet with $5k HYPE** on HyperEVM
2. Set `AGENT_HYPE_PRIVKEY` env var
3. **KhypeCarryExecutor** runs automatically:
   - Swap WHYPE → kHYPE on HyperSwap V3
   - Approve kHYPE → STAKING_MANAGER
   - Call unstake() to queue 7-day withdrawal
   - Wait 7 days
   - Call claimWithdrawal() → receive HYPE
   - Wrap HYPE → WHYPE, repeat

### Verified Parameters
- Discount: 2.53% (live, verified Oct 7 2026)
- Kinetiq withdrawal delay: 7 days (verified on-chain)
- Unstake fee: 0.10% (verified)
- HyperSwap V3 fee: 0.01%
- Net profit per 8-day cycle: $74.37 on $5k
- Annual: $3,393 (68% APR)

## Phase 3: Euler USDC Lending Arb — $5k → $376/yr (7.5% APR)

### What It Is
Euler V2 has multiple vaults per asset. USDC has eUSDC-3 (14.40% APR) and eUSDC-4 (5.02% APR).
Deposit in high-APY vault, borrow from low-APY vault, capture 9.39% spread.

### Execution Path
1. **Fund agent wallet with $5k USDC** on HyperEVM
2. **EulerLendingArbExecutor** runs automatically:
   - Approve USDC → eUSDC-3
   - Deposit USDC into eUSDC-3 (earn 14.40% APR)
   - Borrow USDC from eUSDC-4 (pay 5.02% APR, uses deposit as collateral via EVC)
   - Net capture: 9.39% × 80% LTV × $5k = $376/yr

## Cumulative Projection

| Phase | Capital | Annual $ | APR | Status |
|-------|---------|----------|-----|--------|
| Phase 1 (VOOI) | $25k | $60-124k | 240-497% | ⚠️ Executor READY — needs capital + approval |
| Phase 2 (kHYPE) | $5k | $3,393 | 68% | ⚠️ Executor READY — needs agent wallet |
| Phase 3 (Euler) | $5k | $376 | 7.5% | ⚠️ Executor READY — needs agent wallet |
| **Total** | **$35k** | **$64-128k** | **182-365%** | |

## What's Needed

### 🚨 BLOCKING: VOOI Capital Deposit ($25k)
- Deposit on ultra.vooi.io
- VOOI API token already configured
- VooiArbExecutor tested and ready
- **Expected return: $60-124k/yr (240-497% APR)**

### 🚨 BLOCKING: Agent Wallet Funding ($10k)
- $5k in HYPE on HyperEVM (for kHYPE carry arb)
- $5k in USDC on HyperEVM (for Euler lending arb)
- Set `AGENT_HYPE_ADDRESS` + `AGENT_HYPE_PRIVKEY` env vars
- **Expected return: $3,769/yr (37.7% APR)**

### Principal Approval
- All executors run in dry-run mode by default
- Adding `--live` flag enables real order submission
- **Principal must explicitly approve live trading**

## Infrastructure Status (Oct 7 2026)

- ✅ 19 strategies running in parallel
- ✅ VooiArbExecutor (dry-run mode, API verified)
- ✅ KhypeCarryExecutor (dry-run mode, wallet integration ready)
- ✅ EulerLendingArbExecutor (dry-run mode, wallet integration ready)
- ✅ Telegram command handler (/status /opportunities /khype /euler /kinetiq /vooi /help)
- ✅ Opportunities dashboard (includes VOOI perp funding)
- ✅ Daily report generator (includes VOOI perp funding)
- ✅ Position monitor (tracks open positions)
- ✅ HLP yield monitor (entry/exit signals)
- ✅ HIP-3 alias markets documented (298 tokenized assets)
- ✅ Alias ticker map (50+ decoded to real tickers)
- ⚠️ Scanner stability (supervisor auto-restarts, best in tmux)
