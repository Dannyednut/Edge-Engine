# Execution Priority — What to Execute First When Capital Arrives

**Last updated:** Oct 7 2026
**Author:** Edge Scanner Agent (Manager)
**Status:** Ready for principal review

## Executive Summary

When the agent wallet is funded and AgentVault is deployed, we have 8 strategies ready to execute. Not all are equal — some are ready to trade immediately, some need more integration work, some need more capital. This document prioritizes the execution order by expected revenue per unit of effort.

## Priority 1: Perp Funding Arb via VOOI (Day 1)

**Why first:** Highest APR, lowest capex, no AgentVault needed.

| Parameter | Value |
|---|---|
| Strategy | perp_funding + cex_hl_funding_arb |
| Executor | VOOI POST /arbitrage-orders (atomic paired-leg) |
| Capital needed | $5,000 USDC on Hyperliquid (via VOOI) |
| Expected APR | 9-11% (HL funding floor 10.95% vs CEX ~0%) |
| Expected monthly P&L | $75-92 |
| Setup time | 1 hour (register VOOI, fund HL account, set AUTO_EXECUTE=true) |
| Risk | Funding inversion (HYPE went -6.88% — sign guard handles this) |
| Dependencies | VOOI API token (have it), HL account funded with USDC |

**Steps to execute:**
1. Principal creates Hyperliquid account, deposits $5,000 USDC
2. Principal registers on VOOI (ultra.vooi.io), connects HL wallet, generates API token
3. Agent sets `AUTO_EXECUTE=true DRY_RUN=false` in .env
4. Agent starts `pnpm --filter @edge/scanner start:funding-combined`
5. VOOI executor places atomic paired-leg orders when spread > 8% APR
6. RiskGuard enforces $200 daily loss cap, $50 per-trade cap, 72h max hold

## Priority 2: Prediction Market Arb (Day 2-3)

**Why second:** No crypto infrastructure needed beyond a Polygon wallet. Fastest to deploy after perp funding.

| Parameter | Value |
|---|---|
| Strategy | prediction_arb |
| Executor | Direct on-chain via Polymarket CTF contract |
| Capital needed | $2,000 USDC on Polygon |
| Expected monthly P&L | $50-150 (event-driven, variable) |
| Setup time | 2 hours (create Polymarket wallet, fund with USDC, wire execution) |
| Risk | Resolution-rule divergence, capital lock 7-60 days |
| Dependencies | Polymarket wallet with USDC |

## Priority 3: DEX-CEX Flashloan Arb (Day 5-7)

**Why third:** Needs AgentVault + ccxt integration. Higher capex but flashloan-funded (capital efficient).

| Parameter | Value |
|---|---|
| Strategy | dex_cex_flashloan |
| Executor | AgentVault.balancerFlashLoanArb() on Arbitrum/Base |
| Capital needed | 0.05 ETH for gas + $1,500 working capital for CEX inventory |
| Flashloan size | Up to $50,000 per trade (Balancer V2, 0% fee) |
| Expected monthly P&L | $200-500 (depends on edge frequency) |
| Setup time | 3-5 days (deploy AgentVault, integrate ccxt, whitelist DEX routers) |
| Risk | CEX leg not atomic (bridge latency), slippage |
| Dependencies | AgentVault deployed, ccxt CEX API keys, Balancer V2 on Arbitrum |

**Steps to execute:**
1. Fund agent EVM wallet with 0.05 ETH on Base
2. Run `pnpm --filter @edge/contracts deploy --chain=base`
3. Principal verifies contract on Basescan
4. Principal funds AgentVault with $1,500 USDC
5. Principal whitelists Uniswap V3 + Aerodrome routers
6. Integrate ccxt for CEX spot legs (Binance/OKX/Bybit API keys)
7. Agent starts flashloan executor

## Priority 4: Pendle Boros Funding Rate Swap Arb (Day 7-14)

**Why fourth:** Real new landscape but current markets have 1-day maturity (tiny absolute profit). Wait for longer-dated markets.

| Parameter | Value |
|---|---|
| Strategy | pendle_boros |
| Executor | Pendle Boros API (Arbitrum) |
| Capital needed | $2,000-5,000 USDC on Arbitrum |
| Expected monthly P&L | $20-50 (at current 1-day maturities); $100-300 when 30-day markets appear |
| Setup time | 1 day (Pendle account, Arbitrum wallet) |
| Risk | Funding rate moves against position before maturity |
| Dependencies | Pendle Boros API access, Arbitrum wallet with USDC |

## Priority 5: Tokenized Equity Basis Arb (Week 3+)

**Why last:** Markets exist but are illiquid (49-53% spreads). Wait for Q4 DTCC tokenization launch.

| Parameter | Value |
|---|---|
| Strategy | tokenized_equity |
| Executor | Backpack Exchange (spot buy + perp short) |
| Capital needed | $500-2,000 USDC on Backpack |
| Expected monthly P&L | $0 currently (not actionable); $200-500 when spreads tighten |
| Setup time | 1 day (Backpack account, API keys) |
| Risk | Illiquidity, basis moves against position, Backpack counterparty risk |
| Dependencies | Backpack API keys, spreads < 2% + depth > $500 |

## Capital Allocation Summary

| Priority | Strategy | Capital | Expected Monthly P&L |
|---|---|---|---|
| 1 | Perp funding (VOOI) | $5,000 | $75-92 |
| 2 | Prediction (Polymarket) | $2,000 | $50-150 |
| 3 | DEX-CEX flashloan | $1,500 + 0.05 ETH gas | $200-500 |
| 4 | Pendle Boros | $2,000 | $20-50 (growing) |
| 5 | Tokenized equity | $500 | $0 (monitoring) |
| — | Buffer/reserve | $500 | — |
| **Total** | | **$11,500** | **$345-792/month** |

## What Needs to Happen First

1. **Principal funds agent EVM wallet** — 0.05 ETH on Base for gas
2. **Principal creates Hyperliquid account** — deposit $5,000 USDC
3. **Principal registers on VOOI** — connect HL wallet, generate API token
4. **Agent deploys AgentVault** on Base (60 seconds once wallet funded)
5. **Agent sets AUTO_EXECUTE=true** — perp funding scanner starts live trading

From that point, the system is generating real P&L. Everything else builds on top.
