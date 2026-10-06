# HYPE LST Atlas — All Liquid Staked HYPE Tokens on HyperEVM

> **Discovery date**: Oct 13 2026 (via Pendle V2 API — 50 HL markets queried)
> **Total LST TVL on HyperEVM**: $1.05B+ across 17 distinct HYPE LSTs

## Summary Table

| Symbol | Address | Floating APY | PT Implied APY | TVL $ | Notes |
|--------|---------|--------------|----------------|-------|-------|
| kHYPE | `0xfD739d4e423301CE9385c1fb8850539D657C296D` | 2.37% | 1.92% | $734.7M | Kinetiq — dominant LST |
| vkHYPE | `0x9ba2edc44e0a4632eb4723e81d4142353e1bb160` | 6.32% | 2.35% | $242.1M | Validator-scoped kHYPE — **highest floating yield** |
| liquidHYPE | `0x441794d6a8f9a3739f5d4e98a728937b33489d29` | 2.71% | — | $33.5M | Liquid stake |
| stHYPE | `0xffaa4a3d97fe9107cef8a3f48c069f577ff76cc1` | 2.56% | **17.96%** | $12.9M | **Huge PT spread — fixed yield opportunity** |
| LHYPE | `0x5748ae796ae46a4f1348a1693de4b50560485562` | 2.52% | — | $10.9M | |
| hbHYPE | `0x96c6cbb6251ee1c257b2162ca0f39aa5fa44b1fb` | 0.62% | — | $7.7M | Hyperborrow HYPE |
| beHYPE | `0xd8FC8F0b03eBA61F64D08B0bef69d80916E5DdA9` | 2.21% | — | $4.1M | |
| haHYPE | `0xfde5b0626fc80e36885e2fa9cd5ad9d7768d725c` | 4.79% | 43.52% | $4.0M | PT implied likely stale |
| hyWHYPE(mHYPE)-4 | `0xe4847cb23dad9311b9907497ef8b39d00ac1de14` | 0.27% | — | $4.0M | Maturity-4 wrapper |
| hakHYPE | `0x1368ee9d1212ae5b26ff166049220051a9eebc42` | 3.88% | — | $1.5M | |
| xHYPE | `0xac962fa04bf91b7fd0dc0c5c32414e0ce3c51e03` | 4.98% | — | $1.4M | |
| hHyperEvmWHYPE | `0x0d745eaa9e70bb8b6e2a0317f85f1d536616bd34` | 0.88% | — | $1.4M | |
| dnHYPE | `0x949a7250bb55eb79bc6bcc97fcd1c473db3e6f29` | 10.46% | — | $0.9M | Discount noted |
| HYPED | `0x4d0ff6a0dd9f7316b674fb37993a3ce28bea340e` | 2.31% | — | $0 | Test/empty |
| HYPE++ | `0x195eb4d088f222c982282b5dd495e76dba4bc7d1` | 48.22% | — | $0.1M | Suspiciously high yield |

## Non-HYPE Yield Tokens Found (Also on Pendle)

| Symbol | Address | APY | TVL $ | Description |
|--------|---------|-----|-------|-------------|
| hbUSDT | `0x5e105266db42f78fa814322bce7f388b4c2e61eb` | 6.61% | $17.1M | Yield-bearing USDT (Hyperborrow) |
| sUSDe | `0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2` | 7.46% | $12.2M | Ethena sUSDe on HL |
| wVLP | `0xd66d69c288d9a6fd735d7be8b2e389970fc4fd42` | 3.61% | $7.5M | Wrapped VLP (HyperSwap) |
| AVLT | `0xd0ee0cf300dfb598270cd7f4d0c6e0d8f6e13f29` | 17.51% | $4.9M | HyperSwap vault LP |
| HLPe | `0x54a98ff45a7dbdf30c54e32fd330d3ea582a5559` | — | $4.6M | HLP escrow token |
| hwHLP | `0x9fd7466f987fd4c45a5bbde22ed8aba5bc8d72d1` | — | $4.1M | Wrapped HLP |
| wNLP | `0x4cc221cf1444333510a634ce0d8209d2d11b9bba` | 8.05% | $3.1M | Wrapped NLP (Nevyn) |
| hwHYPE | `0x4de03ca1f02591b717495cfa19913ad56a2f5858` | 8.45% | $2.4M | Wrapped HYPE |
| limUSD | `0x1822bd335489d84abdd0779a7dcaeda0625e83c8` | 7.61% | $1.8M | Liminal stablecoin |
| hbUSDC | `0x057ced81348d57aad579a672d521d7b4396e8a61` | 5.86% | $0.4M | Yield-bearing USDC |
| WHLP | `0x1359b05241ca5076c9f59605214f4f84114c0de8` | — | $1.3M | Wrapped HLP variant |

## Top Yield Opportunities (vs kHYPE baseline 2.37%)

| LST | Floating % | Implied % | Spread vs kHYPE | TVL $ | Action |
|-----|-----------|-----------|-----------------|-------|--------|
| stHYPE PT | 2.56 | **17.96** | **+15.58%** | $12.9M | **BUY stHYPE PT — lock 17.96% fixed yield** |
| vkHYPE | 6.32 | 2.35 | +3.95% | $242.1M | Hold vkHYPE for floating 6.32% (no AMM liquidity) |
| AVLT | 17.51 | 33.51 | +31.13% | $4.9M | Monitor — likely illiquid, verify volume |
| hwHYPE | 8.45 | 29.94 | +27.56% | $2.4M | Monitor — likely illiquid |
| haHYPE PT | 4.79 | 43.52 | +41.14% | $4.0M | Stale/illiquid — skip without deeper DD |
| wNLP | 8.05 | 65.61 | +63.24% | $3.1M | Stale/illiquid — skip without deeper DD |
| dnHYPE | 10.46 | — | +8.09% | $0.9M | Small TVL — monitor for growth |
| sUSDe | 7.46 | — | +5.09% | $12.2M | **Best stablecoin yield on HL** |
| hbUSDT | 6.61 | — | +4.24% | $17.1M | Yield-bearing USDT |
| limUSD | 7.61 | 11.01 | +8.64% | $1.8M | Liminal stablecoin — small TVL |

## Kinetiq Staking Contracts (verified on-chain Oct 13 2026)

| Contract | Address | Purpose |
|----------|---------|---------|
| KHYPE_TOKEN | `0xfD739d4e423301CE9385c1fb8850539D657C296D` | The kHYPE ERC20 token |
| STAKING_MANAGER | `0x393D0B87Ed38fc779FD9611144aE649BA6082109` | Handles stake/unstake/claim |
| STAKING_ACCOUNTANT | `0x9209648Ec9D448EF57116B73A2f081835643dc7A` | Accounting / exchange rate |
| VALIDATOR_MANAGER | `0x4b797A93DfC3D18Cf98B7322a2b142FA8007508f` | Validator registry |

### Verified Live Parameters
- `minStakeAmount()` = 5 HYPE
- `maxStakeAmount()` = 0 (no max currently)
- `withdrawalDelay()` = 604,800 seconds = **7 days**
- `unstakeFeeRate()` = 0.10%
- `totalStaked()` = 52.2M HYPE
- `totalQueuedWithdrawals()` = 501,940 HYPE
- `whitelistEnabled()` = false (open to all)

## Action Items

1. **BUILD**: stHYPE PT yield arb — buy stHYPE PT (locks 17.96% fixed yield) using kHYPE (2.37% floating) as funding source. Spread: 15.58% APR on $12.9M TVL.
2. **MONITOR**: AVLT, hwHYPE, haHYPE PTs — implied yields look attractive but need liquidity verification.
3. **MONITOR**: sUSDe (7.46%) and hbUSDT (6.61%) — yield-bearing stablecoins, potential funding source for perp arbs.
4. **EXPAND**: LstYieldComparisonScanner to include all 17 LSTs (currently uses Pendle API which already covers them).
5. **AVOID**: HYPE++ (48% APY, $0.1M TVL — likely honeypot), haHYPE PT (43% implied — likely stale).

## ⚠️ CORRECTION (Oct 13 2026): Most high-yield PT markets are EXPIRED

After building the PtYieldArbScanner (Strategy 16) and filtering expired markets, only 4 PT markets remain active:

| LST | Maturity | Days to Maturity | Implied % | Underlying % | Spread % | TVL $ |
|-----|----------|------------------|-----------|--------------|----------|-------|
| stHYPE | 2027-01-28 | 113 | 2.10% | 1.97% | +0.13% | $1.4M |
| haHYPE | 2027-01-28 | 113 | 2.98% | 2.14% | +0.84% | $0.1M |
| kHYPE | 2027-03-25 | 169 | 1.92% | 2.37% | **-0.45%** | $3.2M |
| vkHYPE | 2027-03-25 | 169 | 2.35% | 0.00% | +2.35% | $0.3M |

**Conclusion**: The 17.96% stHYPE PT yield, 43.52% haHYPE PT, 29.94% hwHYPE PT, 33.51% AVLT PT — these were ALL stale data from EXPIRED Pendle markets. Real actionable PT yield spreads are tiny (<3%).

**Implication**: The kHYPE LST carry arb (Strategy 11, ~$68/cycle on $5k) remains the highest-yield opportunity on HyperEVM. PT yield arb is NOT a viable standalone strategy on HL right now — Pendle market maturity is too short and post-expiry yields are noise.

The PtYieldArbScanner remains in place — it will catch genuine spreads if/when new PT markets launch with meaningful yields.
