# Edge-Engine

Unified arbitrage engine — DEX/CEX/perps/prediction/sports/MEV. Continuous monitoring + atomic execution.

**Status:** Brief 02 — scaffold + first live scanner (perp funding) shipped.
**Principal:** Dannyednut (non-US jurisdiction)
**Cadence:** Continuous monitoring with Telegram alerts; periodic briefs (PDF).

## What's here

```
edge-engine/
├── config/
│   ├── chains.toml              # 8 chains wired up
│   └── strategies.toml          # 6 strategy configs
├── packages/
│   ├── types/                   # @edge/types — shared domain types
│   ├── config/                  # @edge/config — TOML + env loader
│   ├── alerts/                  # @edge/alerts — Telegram bot
│   ├── pnl/                     # @edge/pnl — SQLite PnL ledger + risk state
│   ├── risk/                    # @edge/risk — pre-exec guard + kill switch
│   ├── data-sources/            # @edge/data-sources — viem EVM adapters
│   ├── sharpe-client/           # @edge/sharpe-client — Sharpe.ai API client
│   ├── vooi-client/             # @edge/vooi-client — VOOI Perps API client
│   ├── scanner/                 # @edge/scanner — strategies + runners
│   ├── simulator/               # @edge/simulator — TBD (week 4-5)
│   └── executor/                # @edge/executor — TBD (week 5+)
├── docs/                        # design docs
├── scripts/                     # ops scripts
└── .env.example                 # secrets template
```

## Quick start

```bash
# 1. Install deps
pnpm install

# 2. Configure secrets
cp .env.example .env
# Edit .env — fill in any missing values (most are pre-filled from principal)

# 3. Build everything
pnpm build

# 4. Test Telegram bot (also discovers your chat ID)
pnpm --filter @edge/alerts test

# 5. Test RPC connectivity (all 8 chains)
pnpm --filter @edge/data-sources test

# 6. Run discovery — see what Sharpe + VOOI return
pnpm --filter @edge/scanner start:discover

# 7. Run the perp-funding scanner (live, sends Telegram alerts)
pnpm --filter @edge/scanner start:funding
```

## Strategy status

| Strategy | Landscape | Status |
|----------|-----------|--------|
| Perp funding (Sharpe + VOOI) | F — Perps/funding | 🟢 LIVE — scanner runs every 60s |
| DEX-CEX (flashloan) | A — DEX-CEX | 🟡 Building (week 5-6) |
| DEX-DEX (flashloan) | C — DEX-DEX | 🟡 Building (week 5-6) |
| Prediction (Polymarket/Azuro/Overtime/Zeitgeist/Manifold) | D — Prediction | 🟡 Building (week 7-8) — Kalshi dropped (principal non-US) |
| Sports (Pinnacle + soft books) | E — Sports | 🟡 Building (week 11) |
| Solana MEV (Jito backrun) | G — MEV | 🟡 Building (week 9-10) |

## Architecture

Six layers (see Brief 01 PDF, Chapter 4):

1. **Config** — `chains.toml` + `strategies.toml` + `.env` secrets
2. **Scanner** — pluggable Strategy interface (capybot pattern)
3. **Data sources** — per-chain viem adapters + Sharpe + VOOI REST clients
4. **Simulator** — TBD; input-amount ladder + Uniswap V3 Quoter
5. **Executor** — TBD; Aave V3 flashloan + Flashbots bundle (EVM), Jupiter + Jito (Solana), VOOI paired-leg (perps)
6. **Risk** — pre-exec guard + daily loss cap + cooldown + kill switch

## Risk envelope (enforced in code)

| Parameter | Value at $10k |
|-----------|---------------|
| Max daily loss | $200 (2%) |
| Max per-trade loss | $50 (0.5%) |
| Max concurrent arbs | 3 |
| Gas price cap | 3× chain median |
| Cooldown after loss | 5 min |
| Leverage cap (perps) | 3× notional / 1× collateral |

## Secrets management

- All secrets in `.env` (gitignored)
- `.env.example` checked in as template
- For production: use 1Password CLI or `pass` to inject env vars at deploy time
- Never commit `.env`, `*.key`, `secrets/`

## Alerts

Telegram bot is the primary alert channel.  Severity → channel:
- `info` / `opportunity` / `warning` → Telegram
- `critical` → Telegram + email (future)
- `kill-switch` → Telegram + SMS (future)

Bot commands (planned):
- `/pause <reason>` — activates kill switch
- `/resume` — deactivates kill switch
- `/status` — current PnL + open positions
- `/close <position>` — manually close a position

## Repo

- GitHub: https://github.com/Dannyednut/Edge-Engine
- Branch protection: `main` requires PR review
- CI: GitHub Actions runs typecheck + tests on every PR (planned)

## License

UNLICENSED — proprietary to principal.
