# HyperEVM DEX Landscape — 15 DEXs Discovered

> **Discovery date**: Oct 7 2026 via GeckoTerminal API
> **Significance**: HyperEVM has 15+ active DEXs, but most have low liquidity

## DEX Rankings (by GeckoTerminal listing order)

| # | DEX Name | GeckoTerminal ID | Type | Status |
|---|----------|------------------|------|--------|
| 1 | HyperSwap V2 | hyperswap-v2 | Uniswap V2 fork | ✅ Integrated (factory + router) |
| 2 | HyperSwap V3 | hyperswap-v3 | Uniswap V3 fork | ✅ Integrated (factory + router + 27 pools) |
| 3 | Kittenswap V2 | kittenswap | Algebra V2 | ⚠️ Low liquidity ($361 top vol) |
| 4 | Laminar | laminar | Unknown | Not researched |
| 5 | Kittenswap V3 | kittenswap-v3 | Algebra V3 | Not researched |
| 6 | Curve (HyperEVM) | curve-hyperevm | Curve (stableswap) | Not researched |
| 7 | Gliquid | gliquid | Unknown | Not researched |
| 8 | Hybra Finance | hybra-finance | Intent-based DEX | Not researched (gasless swaps) |
| 9 | ManaSwap | manaswap | Unknown | Not researched |
| 10 | Hypercat | hypercat | Unknown | Not researched |
| 11 | Hybra Finance V3 | hybra-finance-v3 | Unknown | Not researched |
| 12 | Ramses V3 | ramses-v3-hyperevm | Concentrated liquidity | Not researched |
| 13 | Ramses Legacy | ramses-legacy-hyperevm | V2-style | Not researched |
| 14 | HyperBrick | hyperbrick | Unknown | Not researched |
| 15 | Project X | project-x | Unknown | Not researched |

## Liquidity Analysis

### Top Kittenswap Pools (sampled Oct 7 2026)
| Pool | 24h Volume | Reserve |
|------|-----------|---------|
| PiP/WHYPE | $361 | $11.6k |
| PURR/WHYPE | $133 | $3.6k |
| LHYPE/WHYPE | $95 | $152.7k |
| FLIP/WHYPE | $26 | $82.7k |

**Conclusion**: Kittenswap has insufficient liquidity for profitable arb.
Top pool has only $361 daily volume — not enough to overcome fees + slippage.

### HyperSwap (for comparison)
- HyperSwap V2: $57M TVL (dominant)
- HyperSwap V3: $2M daily volume
- Already integrated in edge-engine

## Cross-DEX Arb Potential

The same tokens (WHYPE, USDC, kHYPE, etc.) trade on multiple DEXs.
In theory, if a token trades at different prices on HyperSwap vs Kittenswap,
that's a cross-DEX arb opportunity.

**Reality**: Kittenswap liquidity is too thin. A $5k arb would move the price
significantly, eating the spread. Not actionable at current liquidity levels.

## Future Research

1. **Monitor Kittenswap liquidity growth** — if TVL increases 10x, revisit
2. **Research Hybra Finance** — intent-based DEX with gasless swaps (interesting)
3. **Research Ramses V3** — concentrated liquidity, may have better pools
4. **Research Curve** — stableswap for stablecoin pairs (USDC/USDT/USDH)

## Action Items

- **SKIP**: Kittenswap cross-DEX arb (insufficient liquidity)
- **MONITOR**: Hybra Finance (intent-based, may offer unique opportunities)
- **MONITOR**: Ramses V3 (concentrated liquidity, may have deep pools)
- **MONITOR**: Curve (stablecoin arb potential)
