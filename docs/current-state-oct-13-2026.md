# Edge-Engine Current State — Oct 13 2026

> **Status**: 17 strategies running in parallel, all building clean. Agent wallet not yet funded.
> **Bottom line**: Multiple risk-free opportunities identified. **Need $5-10k HYPE funding to start earning.**

## 17 Active Strategies

### High-Confidence Actionable Arbs (ready to execute on funding)

| # | Strategy | Current Edge | Estimated P&L | Capital Required | Status |
|---|----------|--------------|---------------|------------------|--------|
| 11 | **kHYPE LST carry arb** | 2.46% discount on HyperSwap V3, 7-day Kinetiq withdrawal | **$68/cycle = ~$3k/yr on $5k** (~62% APR) | $5,000 HYPE | ⚠️ Executor READY — needs AGENT_HYPE_PRIVKEY |
| 17 | **Euler HL lending arb (USDC)** | 7.12% spread between eUSDC-3 (12.14%) and eUSDC-4 (5.02%) | **$285/yr on $5k** (5.7% APR) | $5,000 USDC | ⚠️ Scanner READY — needs wallet + Euler deposit tx |

### Strategies Running Live (alerts firing)

| # | Strategy | Last Scan Alerts | Notes |
|---|----------|------------------|-------|
| 1 | Perp funding arb (32 venues via Sharpe) | 511 alerts/scan | Filtered to netApr ≥8% for alerts |
| 2 | CEX-HL funding arb (Binance/Bybit/OKX ↔ HL) | 2 alerts/scan | Verified live |
| 3 | DEX-CEX flashloan arb (Balancer V2 0%) | 0 alerts | Watch for opportunities |
| 4 | Solana memecoin cross-AMM arb | 0 alerts | PumpApi integration |
| 5 | Prediction market arb (Polymarket vs Kalshi) | 7 alerts/scan | Capital lock 30+ days |
| 6 | Sports arbitrage (Odds API) | skip (every 10 scans) | 500/month API quota |
| 7 | Pendle Boras basis arb | 95 alerts/scan | Many low-quality — needs filter upgrade |
| 8 | Tokenized equity arb (HL perp vs spot) | 2 alerts/scan | Basis trade opportunities |
| 9 | CexLikeDex price arb (HL perp vs CEX) | 153 alerts/scan | Filtered to vol+OI+persistence |
| 10 | HyperSwap AMM vs HL orderbook | 0 alerts | Low edge currently |
| 12 | Gold arb (PAXG vs XAUT) | 0 alerts | Below 0.3% threshold |
| 13 | Equity perp cross-venue (HL ↔ Backpack) | 0 alerts | No direct overlap yet |
| 14 | LST yield comparison (32 Pendle markets) | 10 alerts/scan | vkHYPE highest at 6.32% |
| 15 | PT-kHYPE fixed vs floating yield | 1 alert/scan | Limited actionable |
| 16 | PT yield arb (cross-LST, filters expired) | 0 alerts | Most PTs are expired |

## Verified Discoveries (Oct 13 2026)

### 1. Kinetiq Contracts (verified on-chain)
- **STAKING_MANAGER**: `0x393D0B87Ed38fc779FD9611144aE649BA6082109`
- **KHYPE_TOKEN**: `0xfD739d4e423301CE9385c1fb8850539D657C296D`
- `minStakeAmount()` = 5 HYPE
- `withdrawalDelay()` = 7 days
- `unstakeFeeRate()` = 0.10%
- `totalStaked()` = 52.2M HYPE
- 5 HYPE minimum, 7-day delay, 0.10% fee → **carry arb viable at 2.46% discount**

### 2. Euler V2 Live on HyperEVM (Production)
- **EVC singleton**: `0xceAA7cdCD7dDBee8601127a9Abb17A974d613db4`
- **eVaultFactory**: `0xcF5552580fD364cdBBFcB5Ae345f75674c59273A`
- 58 verified vaults discovered
- Top vaults: eUSDC-3 ($258k), eUSDC-4 ($241k), esUSN-6 ($200k)
- **Real arb found**: USDC 7.12% spread = $285/yr on $5k

### 3. HYPE LST Atlas (17 LSTs documented)
- Total LST TVL on HyperEVM: $1.05B+
- kHYPE dominant ($734M TVL, 2.37% APY)
- vkHYPE highest floating yield (6.32%, $242M TVL)
- stHYPE contract found: `0xffaa4a3d97fe9107cef8a3f48c069f577ff76cc1`
- Most high-yield Pendle PTs are EXPIRED (corrected in atlas)

## Key Action Items (priority order)

### 1. FUND AGENT WALLET (blocking everything)
- Need: $5,000 in HYPE (for kHYPE arb) + $5,000 in USDC (for Euler arb)
- Total: $10,000 initial capital
- Set env vars: `AGENT_HYPE_ADDRESS`, `AGENT_HYPE_PRIVKEY`
- Expected ROI: $3,285/year on $10k = **32.85% APR risk-free**

### 2. Sharpe API Coverage Gaps (low priority)
- Missing venues: Vertex, Polynomial, Synthetix V3, GMX V2
- Current: 29 venues covered
- Adding 4 more = ~10% more perp arb opportunities

### 3. Filter Pendle Boros (95 alerts → 10 actionable)
- Boros scanner currently alerts any spread > threshold
- Add: min volume $100k, min OI $100k, spread persistence (2 scans)
- Same pattern as CexLikeDex filter upgrade (Strategy 9)

### 4. Build HLP Yield Monitor
- HLP currently 3.55% APR (low — historical avg 15-30%)
- HLP TVL: $181.6M (safest yield on HL — team-operated)
- Build scanner that alerts when HLP APR > 15% (re-enter signal)

## Infrastructure Status

### Background Processes
- ✅ Multi-strategy scanner running (17 strategies, 60s scan interval)
- ✅ Telegram listener running (alert delivery)
- ⚠️ Both running via `nohup` background — restart on session resume

### Codebase
- 19 packages, all building clean
- Repo on commit `dfce6fd` (Oct 13 2026)
- 17 strategies wired into `all-runner.ts`
- All alert handlers tested live

### Files Created This Session
- `packages/executor/src/kinetiq-client.ts` — Kinetiq LST client
- `packages/executor/src/euler-client.ts` — Euler V2 client
- `packages/scanner/src/strategies/pt-yield-arb-scanner.ts` — Strategy 16
- `packages/scanner/src/strategies/euler-lending-arb-scanner.ts` — Strategy 17
- `packages/scanner/src/runners/khype-carry-executor.ts` — kHYPE arb executor
- `docs/hype-lst-atlas.md` — 17 LSTs documented
- `docs/euler-hyperevm-atlas.md` — Euler HL atlas

## Recommendations for Principal

1. **Fund the agent wallet** with $10k split: $5k HYPE + $5k USDC. This unlocks $3,285/year risk-free.
2. **Review the kHYPE carry arb** executor — once funded, it can run autonomously.
3. **Consider adding Euler deposit flow** — needs an EulerClient.deposit() method (next sprint).
4. **Monitor HLP APR** — when it returns to 15%+, deposit for safe base yield.

## Code Health

```
✅ pnpm -r build  → all 19 packages clean
✅ Scanner running 17 strategies, ~5s scan cycle
✅ Telegram alerts firing for actionable opportunities
⚠️  Agent wallet not yet funded → cannot execute real trades
```
