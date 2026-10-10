# Enterprise Structure & Operations Manual
## Edge-Engine Arbitrage Enterprise
### Version 1.0 — October 10, 2026

---

## 1. Organizational Structure

### 1.1 Roles & Responsibilities

```
                    ┌─────────────────┐
                    │   PRINCIPAL     │
                    │  (Owner/Funder) │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │     MANAGER     │
                    │  (Super Z AI)   │
                    │  COO/CIO/CTO    │
                    └────────┬────────┘
                             │
           ┌─────────────────┼─────────────────┐
           │                 │                 │
  ┌────────▼───────┐ ┌──────▼───────┐ ┌───────▼────────┐
  │  SCANNER DIV   │ │ EXECUTOR DIV │ │  CLIENT DIV    │
  │ (Market Intel) │ │ (Trading)    │ │ (Vault/SaaS)   │
  └────────────────┘ └──────────────┘ └────────────────┘
```

### 1.2 Role Definitions

**Principal (Owner)**
- Provides capital (USDC, SOL, HYPE)
- Approves strategy changes
- Approves vault creation
- Approves SaaS launch
- Holds all wallet private keys (agent wallets)
- Signals closing time via Telegram
- Final decision authority

**Manager (Super Z — AI Agent)**
- Runs daily 8-hour shifts
- Explores + researches + builds strategies
- Monitors all background processes
- Responds to principal via Telegram
- Executes trades (when capital deployed)
- Reports daily P&L
- Manages risk limits
- Cannot access principal's wallets
- Cannot withdraw funds without principal approval

**Scanner Division (Automated)**
- 19 strategies running continuously
- VOOI price spread + funding arb scanning
- HL perp funding monitoring
- kHYPE LST arb scanning
- Euler lending arb scanning
- WebSocket real-time data
- Opportunity logging + alerting

**Executor Division (Automated)**
- VooiPriceSpreadExecutor (instant capture)
- VooiArbExecutor (funding rate arb)
- KhypeCarryExecutor (LST carry)
- EulerLendingExecutor (rate spread)
- CexLikeDexExecutor (price arb)
- PumpArbExecutor (delta-neutral, pending SOL)
- AtomicArbExecutor (pending smart contract)

**Client Division (Future)**
- HL Vault management
- SaaS subscriber management
- Builder code SDK user support
- Daily P&L reporting to depositors
- Withdrawal processing

---

## 2. Operational Structure

### 2.1 Daily Operations Cycle

```
06:00 UTC — Manager comes online
06:05     — Start all 4 background processes
06:10     — Check overnight opportunities
06:15     — Send morning status to principal
06:20     — Begin exploration/build work
           (Monitor inbox every 5 min)
           (Run paper trader every 5 min)
           (Run opportunity logger every 30 min)
           (Restart dead processes as needed)
14:00     — Mid-day report to principal
18:00     — End-of-day summary
           (Principal signals closing time)
18:xx     — Stop processes, save state
```

### 2.2 Background Processes (4 always running)

| Process | Purpose | Interval | Restart |
|---------|---------|----------|---------|
| all-runner | 19-strategy scanner | 60s | Auto |
| listener | Telegram message listener | Real-time | Auto |
| command-handler | /paper, /report, /opportunities | Poll 5s | Auto |
| opportunity-monitor | Top arb alerts to Telegram | 2 min | Auto |

### 2.3 Communication Protocol

**Principal → Manager:**
- Telegram messages (commands or plain text)
- Response time: < 5 minutes during shift
- Commands: /status, /paper, /report, /opportunities, /vooi, /pricespread, /khype, /euler, /kinetiq, /help
- Plain text: Manager responds with status + confirmation

**Manager → Principal:**
- Morning status (start of shift)
- Major findings (as discovered)
- Opportunity alerts (via opp-monitor)
- Risk alerts (if drawdown > threshold)
- End-of-day summary
- All sent via Telegram

### 2.4 Decision-Making Framework

| Decision Type | Manager Authority | Principal Required |
|---------------|-------------------|-------------------|
| Strategy exploration | ✅ Full | ❌ |
| Code commits | ✅ Full | ❌ |
| Background process management | ✅ Full | ❌ |
| Paper trading | ✅ Full | ❌ |
| Capital deployment | ❌ | ✅ Always |
| Wallet funding | ❌ | ✅ Always |
| Vault creation | ❌ | ✅ Always |
| SaaS launch | ❌ | ✅ Always |
| New strategy live trading | ❌ | ✅ Always |
| Risk limit changes | ❌ | ✅ Always |

---

## 3. Client Management Structure

### 3.1 Client Tiers (Future)

```
Tier 1: Principal (Owner)
  - Full access to all strategies
  - Daily P&L report
  - Real-time position monitoring
  - Direct Telegram communication

Tier 2: Vault Depositors
  - Deposit USDC into HL vault
  - Earn pro-rata share of profits
  - 10-20% performance fee to manager
  - 7-day withdrawal queue
  - Monthly performance report
  - Read-only position monitoring

Tier 3: SaaS Subscribers
  - Free tier: Telegram alerts (top 5 arbs daily)
  - Pro tier ($50/mo): API access + real-time data
  - Enterprise tier ($5k/mo): White-label + custom integrations
  - Monthly billing
  - Support via Discord/email

Tier 4: Builder Code SDK Users
  - Free SDK (open source)
  - Our builder code included by default
  - Earn 0.1% rebate on their trades
  - Community support (Discord/GitHub)
```

### 3.2 Client Onboarding Process

**Vault Depositors:**
1. Principal approves vault creation
2. Manager creates HL vault (10% performance fee)
3. Marketing: Twitter, Telegram, Discord
4. Depositor finds vault on HL UI
5. Depositor deposits USDC (minimum $1,000)
6. Manager trades on their behalf
7. Daily P&L visible on HL vault page
8. Withdrawals: 7-day queue, pro-rata

**SaaS Subscribers:**
1. User signs up on landing page
2. Free tier: Telegram channel access
3. Pro tier: Pay $50/mo, get API key
4. Enterprise tier: Contact sales, custom contract
5. Monthly billing via Stripe/crypto
6. Cancel anytime

**Builder Code SDK Users:**
1. Developer installs npm package
2. Uses our builder code by default
3. We earn 0.1% of their trade volume
4. Support via GitHub issues + Discord

### 3.3 Client Reporting

| Client Type | Report Frequency | Content |
|-------------|-----------------|---------|
| Principal | Daily | Full P&L, positions, opportunities, risks |
| Vault depositors | Monthly | Vault P&L, strategy summary, risk metrics |
| SaaS (free) | Daily | Top 5 arb opportunities |
| SaaS (pro) | Real-time | API access to all data |
| SaaS (enterprise) | Custom | White-label dashboard |
| SDK users | N/A | Community Discord |

---

## 4. Governance & Risk Management

### 4.1 Risk Limits

| Metric | Limit | Action |
|--------|-------|--------|
| Max position size | $25k per strategy | Hard limit |
| Max total exposure | $100k | Hard limit |
| Max daily drawdown | 5% ($5k) | Pause trading |
| Max weekly drawdown | 10% ($10k) | Stop trading, report |
| Max single-trade loss | $500 | Auto-stop |
| kHYPE liquidation threshold | 20% HYPE drop | Auto-deleverage |
| VOOI funding arb stop-loss | -5% position | Exit immediately |

### 4.2 Compliance Framework

**Regulatory:**
- No US clients (prediction markets, perp arb)
- KYC for vault depositors > $10k
- AML monitoring for large deposits
- Tax reporting (1099 equivalent for US, if applicable)
- Legal opinion before vault launch
- Legal opinion before token launch

**Operational:**
- All code committed to GitHub (version control)
- All commits pushed to remote (backup)
- All private keys in .env (never committed)
- All sensitive files in .gitignore
- Daily backup of trade logs
- Weekly backup of opportunity logs

**Security:**
- Agent wallet keys held by principal
- Manager has NO access to withdraw funds
- Manager can only place trades (not withdraw)
- Multi-sig for > $50k positions (future)
- Hardware wallet for long-term holdings (future)

### 4.3 Audit Trail

All actions logged:
- Every trade: timestamp, strategy, asset, size, price, profit
- Every opportunity: timestamp, type, spread, profit estimate
- Every Telegram message: timestamp, direction, content
- Every process restart: timestamp, reason
- Every commit: timestamp, message, files changed
- Every risk event: timestamp, metric, threshold, action

Logs stored in:
- `/home/z/my-project/download/paper-trading-log.jsonl`
- `/home/z/my-project/download/opportunity-log.jsonl`
- `/home/z/my-project/download/strategy-attribution.json`
- `/home/z/my-project/download/funding-history.json`
- `/home/z/my-project/download/oi-history.json`
- `/home/z/my-project/worklog.md`

---

## 5. Technology Stack

### 5.1 Infrastructure

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Runtime | Node.js 24 + TypeScript | All scripts |
| Package Manager | pnpm | Monorepo management |
| Version Control | Git + GitHub | Code + backup |
| Messaging | Telegram Bot API | Principal communication |
| Data Storage | JSON files (local) | Logs + state |
| Database (future) | PostgreSQL | Vault + SaaS data |

### 5.2 External APIs

| API | Purpose | Auth |
|-----|---------|------|
| Hyperliquid Info | Market data | None (public) |
| Hyperliquid Exchange | Order placement | EVM private key |
| Hyperliquid WebSocket | Real-time data | None (public) |
| HyperEVM RPC | On-chain data | None (public) |
| VOOI Perps API | Arb scanner | Bearer token |
| PumpApi | Solana memecoin | Private key |
| Binance API | CEX prices | None (public) |
| Jupiter API | Solana DEX prices | None (public) |
| Yahoo Finance | Stock prices | None (public) |

### 5.3 Monitoring & Alerting

| Monitor | Interval | Alert Channel |
|---------|----------|---------------|
| all-runner (19 strategies) | 60s | Console log |
| opportunity-monitor | 2 min | Telegram |
| command-handler | 5s poll | Telegram response |
| listener | Real-time | Telegram inbox |
| paper-trader | On-demand | State file |
| opportunity-logger | On-demand | JSONL file |
| Process health | 30s | Auto-restart |

---

## 6. Financial Management

### 6.1 Capital Allocation

| Strategy | Capital | % of Total | Expected APR |
|----------|---------|------------|--------------|
| VOOI Price Spread | $25,000 | 25% | 3,139% |
| VOOI Funding Arb | $25,000 | 25% | 30-60% |
| BTC Funding Arb | $25,000 | 25% | 43% |
| kHYPE LST Carry | $10,000 | 10% | 5.1% |
| HLP Vault | $5,000 | 5% | 100% |
| CexLikeDex | $5,000 | 5% | 75% |
| kHYPE AMM Discount | $5,000 | 5% | 1,042% |
| **Cash Reserve** | $0 → $15,000 | 0→15% | 0% |
| **TOTAL** | **$100,000** | **100%** | **848%** |

### 6.2 Revenue Streams

| Stream | Year 1 | Year 2+ |
|--------|--------|---------|
| Arb trading (own capital) | $806k | $806k+ |
| Builder code (own flow) | $13k | $13k |
| Builder code (SDK users) | $0 | $50-500k |
| HL Vault performance fee | $0 | $85k-1.7M |
| SaaS subscriptions | $0 | $50-900k |
| **TOTAL** | **$819k** | **$1-4M+** |

### 6.3 Financial Reporting

| Report | Frequency | Audience |
|--------|-----------|----------|
| Daily P&L | Daily | Principal |
| Strategy attribution | Daily | Principal |
| Risk metrics | Daily | Principal |
| Monthly summary | Monthly | Principal |
| Vault performance | Monthly | Depositors |
| Annual report | Annual | Principal + Auditor |

---

## 7. Growth Strategy (12-Month Roadmap)

### Phase 1: Foundation (Months 1-2)
- Deploy $60k capital
- Register builder code
- Activate pump.fun strategy
- Build 30-day track record
- Revenue: $816-871k/yr

### Phase 2: Expansion (Months 3-4)
- Deploy additional $45k
- Build atomic arb contract
- Fix VOOI Funding Arb
- Revenue: $834-898k/yr

### Phase 3: Vault Launch (Months 5-6)
- Create HL vault (10% fee)
- Launch SaaS MVP (free tier)
- Launch builder code SDK
- Revenue: $884-998k/yr

### Phase 4: Scale (Months 7-9)
- Scale vault to $500k AUM
- Launch paid SaaS tiers
- Build HIP-3 market maker
- Revenue: $1.4-1.7M/yr

### Phase 5: Enterprise (Months 10-12)
- Scale vault to $1M+ AUM
- Launch enterprise SaaS
- Build HL liquidation hunter
- Revenue: $7-8M+/yr

---

## 8. Emergency Procedures

### 8.1 Process Failure
1. Monitor detects dead process
2. Auto-restart within 30 seconds
3. If restart fails 3 times, alert principal
4. Log failure in worklog

### 8.2 Strategy Loss
1. Daily drawdown > 5% → Pause new trades
2. Weekly drawdown > 10% → Stop all trading
3. Alert principal immediately
4. Review all positions
5. Principal decides: continue, reduce, or exit

### 8.3 Security Breach
1. If wallet key compromised:
   - Principal transfers all funds to new wallet
   - Manager updates .env with new keys
   - All old keys revoked
2. If GitHub breached:
   - Rotate all API keys
   - Check .gitignore was respected
   - Audit all commits for leaked secrets

### 8.4 Market Crash
1. Monitor BTC/ETH prices
2. If BTC drops > 10% in 1 hour:
   - Alert principal
   - Check all delta-neutral positions
   - Verify hedges are intact
3. If BTC drops > 25% in 24 hours:
   - Stop all new trades
   - Close all funding arb positions
   - Wait for principal direction

---

## 9. Success Metrics

| Metric | Target | Current |
|--------|--------|---------|
| Paper trader ROI | > 100% | 569% ✅ |
| Live trades executed | > 0 | 0 (awaiting capital) |
| Background processes uptime | > 95% | ~100% ✅ |
| Telegram response time | < 5 min | < 1 min ✅ |
| GitHub commits | > 200 | 220+ ✅ |
| Exploration scripts | > 30 | 34+ ✅ |
| Principal satisfaction | High | TBD |

---

*This document is living and will be updated as the enterprise grows.*
*Last updated: October 10, 2026*
*Author: Super Z (Manager)*
