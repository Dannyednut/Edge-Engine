# scripts-explore/ — Research & Exploration Scripts

These are **standalone research scripts** used for rapid prototyping and discovery.
They are NOT production code — they don't use the `@edge/*` package system.

## How to use this directory

- **Active strategies**: migrated to `packages/scanner/src/strategies/`
- **Archived**: in `scripts-explore/archive/` (superseded by newer versions)
- **Remaining scripts**: research tools, one-off explorations, and utilities

## Categories

### MIGRATED TO PRODUCTION (in packages/scanner/src/strategies/)
These exploration scripts have been promoted to proper production strategies:

| Explore Script | Production Strategy | Status |
|---|---|---|
| defillama-yield-scanner.mts | defillama-yield-scanner.ts | MIGRATED |
| sweet-spot-yields.mts | defillama-yield-scanner.ts (scanSweetSpot) | MERGED |
| high-yield-stable-aggregator.mts | defillama-yield-scanner.ts | MERGED |
| multi-chain-stable-aggregator.mts | defillama-yield-scanner.ts (scanBestPerChain) | MERGED |
| solana-yield-comprehensive.mts | defillama-yield-scanner.ts | MERGED |
| hyperliquid-l1-yields.mts | defillama-yield-scanner.ts | MERGED |
| hl-l1-stable-optimizer.mts | defillama-yield-scanner.ts | MERGED |
| convex-yield-scanner.mts | defillama-yield-scanner.ts | MERGED |
| top-projects-scanner.mts | defillama-yield-scanner.ts | MERGED |
| rwa-treasury-scanner.mts | rwa-treasury-scanner.ts | MIGRATED |
| institutional-credit-scanner.mts | rwa-treasury-scanner.ts | MERGED |
| maple-finance-scanner.mts | rwa-treasury-scanner.ts | MERGED |
| stablecoin-depeg-scanner.mts | stablecoin-depeg-scanner.ts | MIGRATED |
| hl-liquidation-hunter.mts | liquidation-backrun-scanner.ts | MIGRATED |
| hl-orderbook-executor.mts | orderbook-imbalance-scanner.ts | MIGRATED |
| funding-divergence-realtime.mts | funding-divergence-scanner.ts | MIGRATED |
| airdrop-farming-scanner.mts | airdrop-farming-scanner.ts | MIGRATED |
| leverage-loop-scanner.mts | leverage-loop-scanner.ts | MIGRATED |
| whale-tracker.mts | whale-signal-scanner.ts | MERGED |
| social-signal-tracker.mts | whale-signal-scanner.ts | MERGED |
| cex-dex-bridge-scanner.mts | cex-dex-bridge-scanner.ts | MIGRATED |
| ethena-funding-deep-dive.mts | (research only — concepts in funding-divergence) | RESEARCH |
| curve-yield-scanner.mts | (concepts in defillama-yield-scanner) | MERGED |
| kamino-scanner.mts | (concepts in defillama-yield-scanner) | MERGED |
| jupiter-lend-scanner.mts | (concepts in defillama-yield-scanner) | MERGED |

### STILL USEFUL AS RESEARCH TOOLS (not migrated)
| Script | Purpose |
|---|---|
| delta-neutral-master.mts | Combines all strategies in one view (quick reference) |
| quick-opps-master.mts | Live quick opportunity ranking |
| portfolio-yield-calculator.mts | 3-scenario portfolio projection |
| cross-chain-optimizer.mts | Portfolio optimization across strategies |
| backtester.mts | Strategy backtesting with historical opp DB |
| position-sizing-kelly.mts | Kelly Criterion position sizing |
| performance-attribution.mts | P&L attribution by strategy/asset |
| hl-builder-fee-tracker.mts | Builder fee passive income calculator |
| token-snipe-scanner.mts | PumpFun new launch sniping (high risk) |
| jito-mev-scanner.mts | Solana MEV backrunning |
| triangular-arb-scanner.mts | Cross-DEX triangular arbitrage |

### INFRASTRUCTURE (used by daemons)
| Script | Purpose |
|---|---|
| paper-trader.mts | Paper trading simulator (DAEMON) |
| opp-db.mts | SQLite opportunity database (DAEMON) |
| risk-dashboard-v2.mts | Risk monitoring + kill switch (DAEMON) |
| wallet-funding-alert.mts | USDC deposit detection (DAEMON) |
| realtime-opp-alerts.mts | VOOI spread alerts (DAEMON) |
| realtime-spread-monitor.mts | Fast 5s spread alerts (DAEMON) |
| hl-funding-alerts.mts | HL funding rate alerts (DAEMON) |
| launch-all-daemons.sh | Start all background daemons |
| system-health-check.sh | One-command health verification |

### REPORT GENERATORS
| Script | Output |
|---|---|
| master-daily-report.mts | DAILY_REPORT_YYYY-MM-DD.md + Telegram |
| weekly-investor-report.mts | WEEKLY_INVESTOR_REPORT_YYYY-MM-DD.md |
| investor-one-pager.mts | INVESTOR_ONE_PAGER.md + Telegram |
| investor-onboarding-kit.mts | INVESTOR_ONBOARDING_KIT.md |
| yield-landscape-report.mts | YIELD_LANDSCAPE_REPORT_YYYY-MM-DD.md |

### HL LIVE TRADING (need USDC deposit to execute)
| Script | Purpose |
|---|---|
| hl-place-order.mts | Place HL perp order (signing verified) |
| hl-execute-order.mts | Execute HL order with builder code |
| go-live-v2.mts | Full live trading launcher |
| live-trading-executor.mts | Balance check → register builder → trade |
| vooi-live-executor.mts | VOOI + HL SDK integration |

### TECHNICAL ANALYSIS (TA tools)
atr-calculator, bollinger-bands, macd-calculator, rsi-calculator, vwap-calculator, etc.

### RESEARCH (one-off explorations)
deep-dive-*, explore-*, research-*, scan-*, etc.

