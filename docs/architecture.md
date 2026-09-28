# Architecture

Six-layer design. Each layer is independently testable and replaceable.

```
┌─────────────────────────────────────────────────────────────┐
│ 1. CONFIG LAYER                                              │
│    chains.toml + strategies.toml + .env (secrets)            │
└─────────────────────────────────────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────────┐
│ 2. SCANNER LAYER                                             │
│    Pluggable Strategy interface:                             │
│      abstract class Strategy {                               │
│        subscribesTo(): DataSource[]                          │
│        evaluate(data: DataPoint): TradeOrder[]               │
│      }                                                       │
│    Active strategies:                                        │
│      - PerpFundingStrategy (Sharpe + VOOI cross-validation)  │
│      - DexCexStrategy (TBD — week 5-6)                       │
│      - DexDexStrategy (TBD — week 5-6)                       │
│      - PredictionRulesStrategy (TBD — week 7-8)              │
│      - SportsArbStrategy (TBD — week 11)                     │
│      - JitoBackrunStrategy (TBD — week 9-10)                 │
└─────────────────────────────────────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────────┐
│ 3. DATA SOURCE LAYER                                         │
│    EVM:    viem WebSocket (newBlockHeaders)                  │
│    Solana: Helius Laserstream GRPC (TBD)                     │
│    CEX:    ccxt unified WebSocket (TBD)                      │
│    Signal: Sharpe.ai REST (32 venues funding rates)          │
│    Exec:   VOOI REST (11 perp venues)                        │
└─────────────────────────────────────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────────┐
│ 4. SIMULATOR LAYER                                           │
│    For each candidate TradeOrder:                            │
│      1. Call venue quote with actual trade size              │
│      2. Run input-amount ladder (20 steps)                   │
│      3. Compute net_profit = gross - gas - flashloan - slip  │
│      4. Return best-sized order or null                      │
└─────────────────────────────────────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────────┐
│ 5. EXECUTOR LAYER                                            │
│    EVM atomic:     Aave V3 flashLoanSimple + Flashbots bundle│
│    Solana atomic:  Jupiter Swap API + Jito/Nozomi/ZeroSlot   │
│    Perp paired:    VOOI POST /arbitrage-orders (atomic)      │
│    Spot:           ccxt (TBD)                                │
└─────────────────────────────────────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────────┐
│ 6. RISK LAYER (non-negotiable)                               │
│    preExec() guard:                                          │
│      - kill_switch_active? → reject                          │
│      - daily_loss_cap hit?  → reject + alert                 │
│      - max_concurrent hit?  → reject                         │
│      - per_trade_cap hit?   → reject                         │
│      - gas_price_cap hit?   → reject                         │
│      - cooldown active?     → reject                         │
│    onRevert(): start cooldown + record loss + alert          │
│    onFill(): record realized PnL                             │
└─────────────────────────────────────────────────────────────┘
```

## Target chains (in priority order)

1. **Arbitrum** — Uniswap V3, Sushiswap, Camelot; Aave V3 flashloans; sub-cent gas
2. **Base** — Aerodrome, Uniswap V3, BaseSwap; Aave V3; sub-cent gas
3. **Solana** — Jupiter, Raydium CLMM, Meteora DLMM; Helius Laserstream
4. **Hyperliquid** — perp funding arb vs spot DEX; native API
5. **BSC** — PancakeSwap V3; Aave V3; low gas
6. **Polygon** — QuickSwap, Uniswap V3; Aave V3; low gas
7. **zkSync** — Lighter perp DEX; Aave V3
8. **Ethereum** — mainnet; flashloan-only (gas economics bad for <$10k working cap)

## Key vendor integrations

### Sharpe.ai (signal layer)
- 32 venues funding rates + OI + volume
- Cross-exchange arbitrage scanner (fee-adjusted netApr)
- CEX-CEX spot transfer scanner (with withdrawal fees baked in)
- DEX-DEX scanner preview (gross — needs our fee calc)
- Free tier: 10k req/mo, 30 RPM — sufficient for dev
- Auth: `Bearer sk_live_...` (free tier — generate at sharpe.ai/docs/authentication)

### VOOI (execution layer for perps)
- 11 perp venues (5 DEX + 3 HIP-3 + 4 CEX)
- Public `/arbitrage-scanner` (no auth) — live funding + price spreads
- Authenticated `/arbitrage-orders` — atomic paired-leg execution
- Authenticated `/bots` — managed funding-arb bot runner
- 0 VOOI fees on MCP-routed trades (only venue fees)
- Auth: Ed25519-signed Bearer token (generate at ultra.vooi.io/api-tokens)
- **Geographic ban:** US + Singapore + Restricted Territories (principal is non-US ✓)

### Combined playbook (funding-rate arb)
1. **Discover**: Sharpe `/arbitrage/cross-exchange?minApr=5` — netApr-ranked rows
2. **Validate**: VOOI `/arbitrage-scanner?notionalUsd=10000` — execution-aware priceSpreadAtSize
3. **Filter**: both sources agree spread > threshold; legs on VOOI-supported venues
4. **Risk-check**: Sharpe `/insider-selling` and `/pump-dump` flags veto
5. **Execute**: VOOI `POST /arbitrage-orders` (primary=limit, hedge=market, fullFill, alertAndHold)
6. **Monitor**: poll `GET /arbitrage-orders` + `GET /positions`
7. **Close**: when funding spread inverts OR maxHoldHours hits

Round-trip cost on $5k notional (Hyperliquid + Lighter, both DEX):
- Entry: 0 bps maker (HL limit primary) + 0 bps taker (Lighter market hedge) + 2 bps VOOI on Lighter ≈ $1
- Exit: same ≈ $1
- Total ≈ 4 bps ≈ $2 on $5k = **0.04% break-even funding spread threshold**

Typical captures from scanner: 0.3%–1.4% per 8h — **economics work at $5k notional**.

## Decision log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-09-25 | Drop Kalshi from prediction-market scope | CFTC US-only; principal is non-US |
| 2026-09-25 | Adopt Sharpe.ai as primary signal layer | Free tier, 32 venues, fee-adjusted netApr |
| 2026-09-25 | Adopt VOOI as primary perp executor | Atomic paired-leg execution, 11 venues, 0 VOOI fees via MCP |
| 2026-09-25 | TypeScript monorepo (pnpm workspaces) | Best SDK coverage; capybot pattern |
| 2026-09-25 | Target chains: Arbitrum + Base + Solana + HL first | Sub-cent gas + best SDK coverage at <$10k scale |
| 2026-09-25 | Aave V3 flashloan provider (replaces dYdX SoloMargin) | dYdX Solo deprecated; Aave V3 multi-chain |
| 2026-09-25 | Principal directive: don't limit to <$10k; use flashloans | Expands scope to mainnet EVM + larger DEX-CEX arbs |
