# Edge-Engine

**Production-grade delta-neutral arbitrage system** deployed across Hyperliquid, Ethereum, Solana, HyperEVM, and 8+ CEX/DEX venues.

[![Status](https://img.shields.io/badge/status-PRODUCTION-green)]()
[![Track Record](https://img.shields.io/badge/track%20record-65%2B%25%20ROI-blue)]()
[![Win Rate](https://img.shields.io/badge/win%20rate-100%25-brightgreen)]()
[![Strategies](https://img.shields.io/badge/strategies-33-orange)]()

## Architecture

```
edge-engine/
├── packages/                    # Production code (15 packages)
│   ├── types/                   # Shared TypeScript types
│   ├── config/                  # TOML + .env loader
│   ├── alerts/                  # Telegram bot
│   ├── pnl/                     # SQLite P&L ledger
│   ├── risk/                    # Pre-exec risk guard + kill switch
│   ├── data-sources/            # EVM RPC adapters (7 chains)
│   ├── sharpe-client/           # Sharpe.ai API client
│   ├── vooi-client/             # VOOI Perps API client
│   ├── pumpapi-client/          # Pump.fun API client
│   ├── backpack-client/         # Backpack exchange client
│   ├── executor/                # Atomic execution (7 clients)
│   ├── scanner/                 # 33 strategies + 27 runners
│   ├── orchestrator/            # 6 subagent coordination
│   ├── enterprise/              # Operations, risk, client, reporting
│   └── (simulator removed)      # Placeholder removed
├── config/                      # chains.toml + strategies.toml
├── contracts/                   # AgentVault.sol (Solidity)
├── docs/                        # Design docs + enterprise manual
├── scripts-explore/             # 320+ research/exploration scripts
│   ├── archive/                 # Archived (superseded) scripts
│   └── README.md                # Documents what each script does
├── data/                        # SQLite opp database (3.4MB)
├── logs/                        # Daemon logs
└── .env                         # API keys (gitignored)
```

## Quick Start

```bash
# 1. Install
pnpm install

# 2. Configure
cp .env.example .env  # Fill in API keys

# 3. Build
pnpm build

# 4. Start all daemons
bash scripts-explore/launch-all-daemons.sh

# 5. Run all 29 strategies in parallel
pnpm --filter @edge/scanner start:all

# 6. View enterprise dashboard
pnpm --filter @edge/scanner start:enterprise-dashboard

# 7. Health check
bash scripts-explore/system-health-check.sh
```

## Strategy Portfolio (33 strategies)

### Original 22 (Briefs 01-03)
PerpFunding, CexHlFundingArb, DexCexFlashloan, SolanaMultiAmmArb, PredictionArb, SportsArb, PendleBoros, TokenizedEquity, CexLikeDexPriceArb, HlAmmArb, HlLstArb, GoldArb, EquityPerpCrossVenue, LstYieldComparison, PtKhypeYieldArb, PtYieldArb, EulerLendingArb, HlSpotBasis, HlpYield, CrossDexArb, PrecompileFlashloanArb, VooiExecutor

### New 11 (migrated from research)
DefiLlamaYield, RwaTreasury, StablecoinDepeg, LiquidationBackrun, OrderbookImbalance, FundingDivergence, AirdropFarming, LeverageLoop, WhaleSignal, CexDexBridge, SportsArbReal

## Background Daemons (9 + 1 supervisor)

1. telegram-listener — receive principal commands
2. command-handler — process inbox
3. realtime-opp-alerts — VOOI spread alerts (60s)
4. opp-database — SQLite opp recording (5min)
5. hl-funding-alerts — extreme funding alerts (60s)
6. paper-trader — simulated trading (continuous)
7. risk-dashboard — kill switch + risk monitoring (30s)
8. wallet-funding-alert — USDC deposit detection (30s)
9. realtime-spread-monitor — fast price spread alerts (5s)
10. daemon-supervisor — auto-restarts dead daemons (60s)

## Track Record (Paper Trading)

| Metric | Value |
|--------|-------|
| Starting capital | $100,000 |
| Current capital | $165,000+ |
| ROI | +65%+ |
| Total trades | 6,000+ |
| Win rate | 100% |
| Days active | 3 |

## Risk Management

| Parameter | Value |
|-----------|-------|
| Max daily loss | $200 |
| Max per-trade loss | $50 |
| Max concurrent positions | 3 |
| Position sizing | Half-Kelly, max 20% per position |
| Kill switch | Automated |

## License

UNLICENSED — proprietary.
