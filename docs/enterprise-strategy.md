# Enterprise Strategy — Risk-Free Capital Growth

**Vision:** Accept investor capital, grow it at the highest possible return with ZERO risk of loss.
**Arbitrage is ONE pillar.** Yield capture, lending, LPing, options, and staking are other pillars.

## Capital Allocation Framework

### Tier 1: Guaranteed Return (Zero Price Risk)
| Strategy | Expected APR | Capital Lock | Risk | Status |
|---|---|---|---|---|
| kHYPE LST carry arb | ~212% | 7-9 days | Kinetiq smart contract | ✅ Built |
| HyperLend lending (WHYPE) | 14-63% | None | HyperLend smart contract | ✅ Built |
| HLP yield | 10-30% | None | HL protocol (lowest) | 🟡 Researching |
| Pendle PT fixed yield | 2-18% | Until expiry | Pendle smart contract | ✅ Built |

### Tier 2: Delta-Neutral (Hedged Price Risk)
| Strategy | Expected APR | Capital Lock | Risk | Status |
|---|---|---|---|---|
| Perp funding arb (VOOI) | 9-11% | 7-14 days | Funding inversion | ✅ Built |
| CexLikeDex price arb | Variable | Instant | Execution risk | ✅ Built |
| Pendle Boros funding swap | 5-25% | Until maturity | Funding rate shift | ✅ Built |
| Gold arb (PAXG vs XAUT) | Variable | Instant | Depeg risk | ✅ Built |

### Tier 3: Structural Yield (Protocol Risk)
| Strategy | Expected APR | Capital Lock | Risk | Status |
|---|---|---|---|---|
| HyperSwap V3 stablecoin LP | 5-20% | None | IL (minimal for stables) | 🟡 To build |
| Points farming (hedged) | Variable | Variable | Protocol + airdrop uncertainty | 🟡 To research |
| Options income (Hypercall) | 10-50% | Until expiry | Price risk if unhedged | 🟡 To research |
| LST yield rotation (vkHYPE) | +4.08% | Variable | Staking protocol risk | ✅ Built |

### Tier 4: Atomic Arbitrage (Zero Risk if Reverted)
| Strategy | Expected APR | Capital Lock | Risk | Status |
|---|---|---|---|---|
| DEX-CEX flashloan arb | Variable | Instant (atomic) | Gas cost on revert | ✅ Built |
| HL AMM vs orderbook arb | Variable | Instant (atomic) | Gas cost on revert | ✅ Built |
| DEX-DEX triangular arb | Variable | Instant (atomic) | Gas cost on revert | ✅ Built |

## Investor Capital Flow

```
Investor deposits USDC
    ↓
Capital allocated across tiers:
    40% → Tier 1 (kHYPE arb + HLP + lending) — guaranteed base yield
    30% → Tier 2 (funding arb + price arb) — delta-neutral carry
    20% → Tier 3 (LPing + farming + options) — structural yield
    10% → Tier 4 (flashloan arb) — atomic opportunities
    ↓
Returns flow back to investor as USDC
    ↓
Agent takes performance fee (TBD — typically 20% of profits)
```

## What Makes This Different From a Hedge Fund

1. **Zero directional risk** — no long/short positions without hedges
2. **Transparent** — all positions visible on-chain
3. **Liquid** — most positions can be exited within 7-9 days
4. **Non-correlated** — returns don't depend on market direction
5. **Multiple engines** — if one strategy stops working, others continue

## Current State (Oct 13 2026)

- 14 strategies built + verified live
- 19 packages in monorepo
- kHYPE arb alone: $120.20 per $5k per 8-day cycle (~212% APR)
- Phase 1 projected: $557-792/month on $10k
- Phase 3 projected: $935-1,895/month on $17.2k
- Still waiting on: agent wallet funding for live execution
