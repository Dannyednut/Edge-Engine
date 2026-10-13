# Edge-Engine

**Research and paper-trading arbitrage engine** monitoring Hyperliquid, Ethereum, Solana, HyperEVM, and 8+ CEX/DEX venues. All performance figures shown below are from **simulated paper trading** and have **not been independently audited**. No live trades have been executed.

[![Status](https://img.shields.io/badge/status-RESEARCH%2FPAPER-yellow)]()
[![Track Record](https://img.shields.io/badge/paper%20P%26L-not%20audited-lightgrey)]()
[![Win Rate](https://img.shields.io/badge/paper%20win%20rate-not%20audited-lightgrey)]()
[![Strategies](https://img.shields.io/badge/strategies-29-orange)]()
[![Tests](https://img.shields.io/badge/tests-124-brightgreen)]()

> **Disclaimer:** The paper-trader performance figures referenced in this
> repository (including any ROI, win-rate, or trade-count numbers in the
> worklog or daemon output) are produced by a simulation that does not
> execute real trades, does not experience real slippage or rejection, and
> has not been audited by any independent party. They should not be
> interpreted as a forecast or guarantee of live-trading results.

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

## Background Daemons (10 + 1 supervisor)

1. telegram-listener — receive principal commands
2. command-handler — process inbox
3. realtime-opp-alerts — VOOI spread alerts (60s)
4. opp-database — SQLite opp recording (5min)
5. hl-funding-alerts — extreme funding alerts (60s)
6. paper-trader — simulated trading (continuous, SIMULATED — NOT LIVE)
7. risk-dashboard — kill switch + risk monitoring (30s)
8. wallet-funding-alert — USDC deposit detection (30s)
9. realtime-spread-monitor — fast price spread alerts (5s)
10. khype-timeseries — kHYPE yield time-series collector (30min, zero-capital research)
11. daemon-supervisor — auto-restarts dead daemons (60s, started separately)

> **Inventory note:** `launch-all-daemons.sh` starts daemons 1–10.
> `daemon-supervisor.sh` is started separately and monitors all 10 daemons
> plus itself. Both scripts must be run for a full startup.

## Track Record (PAPER TRADING — NOT LIVE, NOT AUDITED)

**WARNING: These are simulated results from a paper trading bot.**
**No live trades have been executed. No real capital is deployed.**
**These results have NOT been independently audited.**
**Past simulation performance does not guarantee future live results.**
**The simulation does not model real slippage, rejection, or latency.**

| Metric | Value |
|--------|-------|
| Starting capital | $100,000 (simulated, not audited) |
| Current capital | ~$172,000 (simulated, not audited) |
| ROI | ~+72% (simulated, not audited) |
| Total trades | ~6,900 (simulated, not audited) |
| Win rate | 100% (simulated, not audited — see note below) |
| Days active | 3 |

> **Note on the 100% win rate:** The paper trader only records completed
> arbitrage cycles where both legs fill at the expected price. It does not
> model partial fills, rejections, or leg-failure risk. A 100% win rate in
> simulation is not indicative of real-world performance.

| Parameter | Value |
|-----------|-------|
| Max daily loss | $200 |
| Max per-trade loss | $50 |
| Max concurrent positions | 3 |
| Position sizing | Half-Kelly, max 20% per position |
| Kill switch | Automated |

## License

UNLICENSED — proprietary.
