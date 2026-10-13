# Edge Engine — Enterprise Operations Manual

**Version:** 2.0 — October 13, 2026
**Manager:** Super Z (AI Agent)
**Principal:** Dannyednut
**Repo:** github.com/Dannyednut/Edge-Engine

---

## 1. SYSTEM ARCHITECTURE

### 1.1 Production Code (packages/)

The enterprise runs on a monorepo with 15 packages:

| Package | Role | Status | Notes |
|---------|------|--------|-------|
| @edge/types | Shared TypeScript types | BUILT | 229 lines — Strategy, Opportunity, Alert interfaces |
| @edge/config | TOML + .env loader | BUILT | 213 lines — loads chains.toml + strategies.toml |
| @edge/alerts | Telegram bot | BUILT | 4 files — listener, alerter, inbox |
| @edge/pnl | SQLite P&L ledger | BUILT | 244 lines — tracks all positions + P&L |
| @edge/risk | Pre-exec risk guard | BUILT | 158 lines — kill switch, position limits |
| @edge/data-sources | EVM RPC adapters | BUILT | 152 lines — viem clients for 7 chains |
| @edge/sharpe-client | Sharpe.ai API client | BUILT | 263 lines — perp funding data |
| @edge/vooi-client | VOOI Perps API client | BUILT | 234 lines — cross-venue arb scanner |
| @edge/pumpapi-client | Pump.fun API client | BUILT | 499 lines — Solana memecoin data |
| @edge/backpack-client | Backpack exchange client | BUILT | 282 lines — Solana perp DEX |
| @edge/executor | Atomic execution layer | BUILT | 7 files — viem wallet, Euler/Kinetiq/HyperLend/CoreWriter/CEX/BuilderCode clients |
| @edge/scanner | Strategies + runners | BUILT | 32 strategies + 26 runners + 4 lib modules |
| @edge/orchestrator | Subagent coordination | BUILT | 6 agents — research, engineering, monitoring, execution, economics, operations |
| @edge/enterprise | Business operations | BUILT (no dist) | 4 modules — operations, risk, client, reporting |
| @edge/simulator | Strategy simulator | PLACEHOLDER | No package.json, no src/ — needs building |

### 1.2 Strategy Portfolio (32 strategies)

**Original 22 strategies** (Briefs 01-03):
1. PerpFundingStrategy — cross-venue perp funding arb
2. CexHlFundingArbStrategy — CEX spot + HL perp carry
3. DexCexFlashloanStrategy — DEX-CEX spot arb via flashloan
4. SolanaMultiAmmArbStrategy — Solana memecoin cross-AMM
5. PredictionArbStrategy — Polymarket YES/NO arb
6. SportsArbStrategy — Pinnacle vs soft books
7. PendleBorosScanner — Pendle BOROS yield
8. TokenizedEquityScanner — HL alias: markets (pre-IPO)
9. CexLikeDexPriceArbStrategy — CEX-like DEX price arb
10. HlAmmArbScanner — HL AMM arbitrage
11. HlLstArbScanner — HL LST arbitrage
12. GoldArbScanner — PAXG/XAUT gold arb
13. EquityPerpCrossVenueScanner — HL ↔ Backpack equity perps
14. LstYieldComparisonScanner — 32 Pendle LST markets
15. PtKhypeYieldArbScanner — PT-kHYPE fixed vs floating
16. PtYieldArbScanner — cross-LST PT yield arb
17. EulerLendingArbScanner — Euler HL cross-vault rate spreads
18. HlSpotBasisScanner — 329 HL spot pairs vs perp basis
19. HlpYieldScanner — HLP vault yield monitoring
20. CrossDexArbScanner — cross-DEX spot arb
21. PrecompileFlashloanArbStrategy — HyperEVM precompile arb
22. VooiExecutor — VOOI atomic paired-leg execution

**10 new strategies** (migrated from scripts-explore, Oct 12-13):
23. DefiLlamaYieldScanner — 16,950 yield pools across 75 chains
24. RwaTreasuryScanner — RWA Treasury yields ($9.13B TVL)
25. StablecoinDepegScanner — depeg arbitrage (buy below $1, short above)
26. LiquidationBackrunScanner — liquidation cascade prediction
27. OrderbookImbalanceScanner — L2 imbalance scalping signals
28. FundingDivergenceScanner — cross-venue funding rate divergence
29. AirdropFarmingScanner — 13 active airdrop campaigns
30. LeverageLoopScanner — recursive yield farming
31. WhaleSignalScanner — whale activity + TVL momentum
32. CexDexBridgeScanner — CEX-DEX bridge arbitrage

### 1.3 Executor Layer (packages/executor/)

| Client | Chain | Purpose | Status |
|--------|-------|---------|--------|
| index.ts | Multi-chain | Wallet client, chain definitions, AgentVault integration | BUILT |
| euler-client.ts | HyperEVM | Euler V2 deposit/borrow/repay/withdraw | BUILT |
| kinetiq-client.ts | HyperEVM | kHYPE staking/unstaking | BUILT |
| hyperlend-client.ts | HyperEVM | HyperLend supply/borrow | BUILT |
| corewriter-client.ts | HyperEVM | CoreWriter protocol | BUILT |
| cex-executor.ts | Multi-CEX | Binance/Bybit order execution via ccxt | BUILT |
| builder-code-client.ts | Hyperliquid | Register + manage builder code | BUILT |

### 1.4 Smart Contracts (contracts/)

| Contract | Chain | Purpose | Status |
|----------|-------|---------|--------|
| AgentVault.sol | HyperEVM | Atomic execution vault — flashloan + whitelist + profit routing | WRITTEN, needs deployment |

### 1.5 Configuration (config/)

| File | Purpose | Content |
|------|---------|---------|
| chains.toml | Chain RPC endpoints | 8 chains: Ethereum, Arbitrum, Base, Optimism, Polygon, BSC, Solana, HyperEVM |
| strategies.toml | Strategy parameters | 6 strategy configs: perp_funding, dex_cex, dex_dex, prediction_arb, sports_arb, mev_backrun |

### 1.6 Background Daemons (9 running)

| # | Daemon | Script | Poll | Purpose |
|---|--------|--------|------|---------|
| 1 | telegram-listener | packages/alerts/src/listener.ts | Continuous | Receive principal commands |
| 2 | command-handler | packages/scanner/src/runners/command-handler.ts | Continuous | Process inbox |
| 3 | realtime-opp-alerts | scripts-explore/realtime-opp-alerts.mts | 60s | VOOI spread alerts |
| 4 | opp-database | scripts-explore/opp-db.mts | 5min | SQLite opp recording |
| 5 | hl-funding-alerts | scripts-explore/hl-funding-alerts.mts | 60s | Extreme funding alerts |
| 6 | paper-trader | scripts-explore/paper-trader.mts | Continuous | Simulated trading |
| 7 | risk-dashboard | scripts-explore/risk-dashboard-v2.mts | 30s | Kill switch + risk monitoring |
| 8 | wallet-funding-alert | scripts-explore/wallet-funding-alert.mts | 30s | USDC deposit detection |
| 9 | realtime-spread-monitor | scripts-explore/realtime-spread-monitor.mts | 5s | Fast price spread alerts |

### 1.7 Enterprise Modules (packages/enterprise/)

| Module | Purpose | Key Functions |
|--------|---------|---------------|
| operations-manager | Daily cycle + process supervision | loadState, saveState, ensureProcessesRunning, checkInbox |
| risk-manager | Risk limits + enforcement | canTrade, checkPositionSize, checkDrawdown, recordPosition |
| client-manager | Client tiers + vault/SaaS/SDK | registerClient, recordDeposit, calculatePerformanceFee |
| report-generator | Daily/monthly/vault reports | generateDailyReport, generateMonthlyReport |

### 1.8 Orchestrator Agents (packages/orchestrator/)

| Agent | Role | Status |
|-------|------|--------|
| ResearchAgent | Continuous edge discovery + market monitoring | BUILT (254 lines) |
| EngineeringAgent | Parallel module construction + code review | BUILT (98 lines) |
| MonitoringAgent | Scanner + listener 24/7, anomaly surfacing | BUILT (158 lines) |
| ExecutionAgent | Live trade execution, position management | BUILT (121 lines) |
| EconomicsAgent | Capital allocation, P&L tracking, rebalancing | BUILT (145 lines) |
| OperationsAgent | Deployments, secrets, infra, GitHub, health | BUILT (82 lines) |

---

## 2. PERFORMANCE

### 2.1 Paper Trader (live simulation)

| Metric | Value |
|--------|-------|
| Starting capital | $100,000 |
| Current capital | $159,053+ |
| Realized P&L | +$59,053+ |
| ROI | +59%+ |
| Total trades | 4,000+ |
| Win rate | 100% |
| Days active | 3 |

### 2.2 Opportunity Database

| Metric | Value |
|--------|-------|
| Database | data/opportunities.db (SQLite) |
| File size | 3.3 MB |
| Total opportunities recorded | 19,000+ |
| Recording interval | Every 5 minutes |

### 2.3 Alerts Delivered

| Type | Total Fired |
|------|-------------|
| Price spread alerts | 200+ |
| HL funding rate alerts | 20+ |
| All delivered to Telegram | chat ID 5068957503 |

---

## 3. GAPS & ACTION ITEMS

### 3.1 Critical (blocks live trading)

| Gap | Impact | Fix |
|-----|--------|-----|
| Wallet not funded with USDC | Cannot execute live trades | Principal deposits USDC to 0x7cE80... |
| AgentVault.sol not deployed | No atomic flashloan execution | Deploy to HyperEVM |
| Simulator package empty | No strategy simulation | Build or remove placeholder |

### 3.2 Important (improves operations)

| Gap | Impact | Fix |
|-----|--------|-----|
| Scanner dist/ not built | Strategies only run via tsx (slow startup) | Run pnpm build |
| Enterprise dist/ not built | Enterprise modules run via tsx | Add tsconfig.json + build |
| strategies.toml outdated | Only 6 strategies configured (we have 32) | Update with all 32 strategies |
| COINGLASS_API_KEY unused | Missing liquidation data | Integrate into liquidation-backrun-scanner |
| ODDSSHOPPER_API_KEY unused | Missing sports odds data | Integrate into sports-arb strategy |
| ODDS_API_KEY unused | Missing sports odds data | Integrate into sports-arb strategy |
| scripts/ (root) has 100+ files | Confusion with scripts-explore/ | Consolidate or archive |

### 3.3 Nice to have (quality of life)

| Gap | Impact | Fix |
|-----|--------|-----|
| No automated tests | Can't verify strategies without manual run | Add vitest tests |
| No CI/CD | No automated build verification | Add GitHub Actions |
| No monitoring dashboard | Principal can't see status at a glance | Build web dashboard |
| scripts-explore/ still has 280+ files | Cluttered | Continue archiving migrated scripts |

---

## 4. API KEYS & INTEGRATIONS

| API Key | Provider | Used In | Status |
|---------|----------|---------|--------|
| HELIUS_API_KEY | Helius (Solana RPC) | data-sources, solana scanners | ACTIVE |
| ALCHEMY_API_KEY | Alchemy (EVM RPC) | data-sources | ACTIVE |
| SHARPE_API_KEY | Sharpe.ai | sharpe-client | ACTIVE |
| VOOI_API_TOKEN | VOOI Perps | vooi-client | ACTIVE |
| TELEGRAM_BOT_TOKEN | Telegram | alerts package | ACTIVE |
| PUMPAPI_PRIVATE_KEY | Pump.fun | pumpapi-client | ACTIVE |
| COINGLASS_API_KEY | Coinglass | NOT INTEGRATED | AVAILABLE |
| ODDSSHOPPER_API_KEY | OddsShopper | NOT INTEGRATED | AVAILABLE |
| ODDS_API_KEY | The Odds API | NOT INTEGRATED | AVAILABLE |
| AGENT_EVM_PRIVATE_KEY | EVM wallet | executor, HL signing | READY (needs USDC) |
| AGENT_SOLANA_PRIVATE_KEY | Solana wallet | pumpapi-client | READY (needs SOL) |

---

## 5. DAILY OPERATIONS CYCLE

### 5.1 Shift Start (when principal says "continue")
1. Check daemon health: `bash scripts-explore/system-health-check.sh`
2. Restart dead daemons: `bash scripts-explore/launch-all-daemons.sh`
3. Check paper trader status: read paper-trading-state.json
4. Check opp database: verify recent snapshots
5. Send Telegram status update to principal

### 5.2 During Shift
1. Research new opportunities (run scanners)
2. Build new strategies (migrate to packages/)
3. Monitor alerts (real-time spread + funding)
4. Commit + push every hour
5. Send Telegram updates every 30 min

### 5.3 Shift End
1. Generate daily report: `npx tsx scripts-explore/master-daily-report.mts`
2. Update weekly investor report if needed
3. Commit + push final state
4. Send end-of-shift Telegram summary
5. Verify all daemons still running

---

## 6. RISK MANAGEMENT

### 6.1 Risk Limits (from .env)

| Parameter | Value |
|-----------|-------|
| MAX_DAILY_LOSS_USD | $200 |
| MAX_PER_TRADE_LOSS_USD | $50 |
| MAX_CONCURRENT_ARBS | 3 |
| GAS_PRICE_CAP_MULT | 3x chain median |
| COOLDOWN_MS | 5 minutes |
| LEVERAGE_CAP | 3x notional |

### 6.2 Kill Switch Triggers
- Daily loss > $200
- Single trade loss > $50
- Concurrent positions > 3
- Margin usage > 80%

### 6.3 Risk Dashboard
- Running as daemon (30s polling)
- State: /tmp/risk-state.json
- Kill switch flag: /tmp/kill-switch-fired

---

*This document is the single source of truth for enterprise operations.*
*Maintained by: Super Z (Manager)*
*Last updated: October 13, 2026*
