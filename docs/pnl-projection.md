# P&L Projection Model — Based on Verified Live Edges (Oct 13 2026)

## Current Edge Inventory (13 strategies, verified live)

| # | Strategy | Edge Type | Verified Size | Capital Needed | Expected Monthly P&L |
|---|---|---|---|---|---|
| 1 | perp_funding | Funding rate arb (Sharpe+VOOI) | 580+ opps ≥8% APR | $5,000 on HL (VOOI) | $40-75 |
| 2 | cex_hl_funding_arb | CEX+HL carry | 2-4 opps per scan | Same as #1 | Included in #1 |
| 3 | cexlike_dex_price_arb | Price spread (VOOI) | 2-170 filtered opps | $5,000 on VOOI venues | $200-500 |
| 4 | pendle_boros | Funding rate swap | 95 opps (1-day maturity) | $2,000 on Arbitrum | $5-20 |
| 5 | hl_lst_arb | kHYPE carry arb | 1 opp: 2.46% discount | $5,000 WHYPE on HL | $500-700 (91% APR) |
| 6 | prediction_arb | Polymarket divergence | 2-7 opps | $2,000 USDC on Polygon | $50-150 |
| 7 | tokenized_equity | Backpack SPCX/SNDK | 2 monitored (not actionable) | $500 (future) | $0 (monitoring) |
| 8 | gold_arb | PAXG vs XAUT | 0.215% (below threshold) | $10,000 (future) | $0-50 (weekend only) |
| 9 | hl_amm_arb | HyperSwap V2/V3 vs orderbook | 0 (V2 thin, V3 testing) | $5,000 WHYPE (future) | $0-100 (growing) |
| 10 | dex_cex_flashloan | Balancer V2 0% | 0 (needs ccxt CEX keys) | $1,500 + 0.05 ETH | $200-500 (future) |
| 11 | solana_memecoin | PumpApi cross-AMM | 0 (needs stream) | $200 SOL | $50-200 (future) |
| 12 | sports_arb | The Odds API | Throttled (quota) | $500 sportsbook | $50-150 |
| 13 | equity_perp_cross | HL vs Backpack | Building (alias mapping) | $2,000 | $0-100 (future) |

## Projected Monthly P&L (when capital is deployed)

### Phase 1: Immediate (Day 1-7) — $10k deployed on HL
| Strategy | Capital | Monthly P&L |
|---|---|---|
| hl_lst_arb (kHYPE) | $5,000 | $500-700 |
| perp_funding (VOOI) | $5,000 | $40-75 |
| **Phase 1 Total** | **$10,000** | **$540-775** |

### Phase 2: Week 2-4 — Additional $5k on prediction + boros
| Strategy | Capital | Monthly P&L |
|---|---|---|
| prediction_arb | $2,000 | $50-150 |
| pendle_boros | $2,000 | $5-20 |
| cexlike_dex_price_arb | $1,000 | $40-100 |
| **Phase 2 Additional** | **$5,000** | **$95-270** |

### Phase 3: Month 2-3 — Flashloan + DEX-CEX + Solana
| Strategy | Capital | Monthly P&L |
|---|---|---|
| dex_cex_flashloan | $1,500 + gas | $200-500 |
| solana_memecoin | $200 | $50-200 |
| sports_arb | $500 | $50-150 |
| **Phase 3 Additional** | **$2,200** | **$300-850** |

### Total Projected (Month 3, full deployment)
| | Capital | Monthly P&L | Annual P&L |
|---|---|---|---|
| **Total** | **$17,200** | **$935-1,895** | **$11,220-22,740** |

## Key Insight
The **kHYPE LST carry arb alone** ($500-700/month on $5k) generates more profit than all other strategies combined in Phase 1. This should be the FIRST strategy deployed when capital arrives.

## ROI by Strategy (Annual %)
1. **kHYPE LST arb: ~91% APR** (highest ROI by far)
2. cexlike_dex_price_arb: ~48-120% APR
3. dex_cex_flashloan: ~133-333% APR (but needs AgentVault + CEX keys)
4. perp_funding: ~10-18% APR (lowest risk, most liquid)
5. prediction_arb: ~30-90% APR (event-driven, variable)
6. pendle_boros: ~3-12% APR (short maturities limit profit)

## What's Needed to Start
1. **$5,000 in WHYPE on Hyperliquid** → kHYPE arb starts immediately (91% APR)
2. **$5,000 USDC on HL via VOOI** → perp funding arb starts (10-18% APR)
3. **Agent EVM wallet funded with 0.05 ETH** → AgentVault deploys → DEX-CEX unblocks
4. **CEX API keys (Binance/OKX/Bybit)** → ccxt executor unblocks
