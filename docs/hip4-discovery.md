# Hyperliquid HIP-4 Discovery — Oct 13 2026

## Discovery

Via `spotMetaAndAssetCtxs` API endpoint, found **329 `@`-prefixed spot assets** on Hyperliquid.
These are non-canonical spot assets (not native HL perps). The `@` prefix indicates they are
permissionlessly listed spot assets — which includes HIP-4 outcome markets as a subset.

## Asset Categories (by price analysis)

### Tokenized Assets (prices > $1)
- `@109`: $93.03 (likely tokenized equity or commodity)
- `@144`: $86,538 (likely tokenized BTC)
- `@288`: $1,375 (likely tokenized ETH)
- `@155`: $2,721 (unknown)
- `@160`: $121.77 (unknown)
- `@276`: $561.94 (unknown)
- `@191`: $4,162 (unknown)
- `@591`: $11.51 (unknown)

### Stablecoins (price ≈ $1)
- `@173`: $0.99975 (USDC or similar)

### HIP-4 Prediction Markets (prices 0-1, representing probabilities)
- `@198`: $0.0063 (0.6% YES probability)
- `@216`: $0.241 (24.1% YES)
- `@258`: $0.029 (2.9% YES)
- `@223`: $0.0925 (9.3% YES)
- `@166`: $0.178 (17.8% YES)
- `@272`: $0.0199 (2.0% YES)
- `@193`: $0.0097 (1.0% YES)
- `@303`: $0.0735 (7.4% YES)
- `@590`: $0.068 (6.8% YES)

### Memecoins / Other
- `@51`: $1.36
- Plus ~310 more assets at various prices

## Volume Analysis (Top 20 by 24h volume)

| Asset | Price | 24h Volume |
|-------|-------|------------|
| @109 | $93.03 | $63.7M |
| @144 | $86,538 | $23.1M |
| @288 | $1,375 | $14.1M |
| @155 | $2,721 | $13.6M |
| @160 | $121.77 | $8.4M |
| @198 | $0.0063 | $3.6M |
| @276 | $561.94 | $2.9M |
| @216 | $0.241 | $1.3M |
| @173 | $0.99975 | $744k |
| @258 | $0.029 | $648k |

**Total 24h volume across `@`-assets**: $200M+ (significant liquidity)

## Arb Implications

### 1. Cross-Venue Tokenized Asset Arb
- `@144` at $86,538 could be tokenized BTC
- Compare against: HL perp BTC mark price, Binance BTC spot, etc.
- If `@144` trades at premium/discount → arb opportunity

### 2. HIP-4 vs Polymarket/Kalshi
- HIP-4 prediction markets (prices 0-1) can be compared against:
  - Polymarket (USDC-denominated prediction markets)
  - Kalshi (USD-denominated regulated prediction markets)
- Existing PredictionArbScanner (Strategy 5) already compares Polymarket vs Kalshi
- NEW: Add HIP-4 as third venue for same events

### 3. Spot-Perp Basis
- `@144` (BTC spot) vs HL BTC perp → basis trade
- Similar to existing tokenized equity basis (Strategy 8)

## Next Steps

1. **Decode `@`-asset names** — the `@N` notation doesn't reveal the underlying.
   Need to find an API that maps `@N` to asset names (e.g., "@144" → "tBTC").

2. **Build HIP-4 scanner** — filter `@`-assets with prices in 0-1 range,
   match against Polymarket/Kalshi events by probability.

3. **Build tokenized spot arb scanner** — compare `@`-assets with prices > $1
   against HL perps and CEX spot prices.

4. **Research Hydromancer API** — they mentioned "outcome" endpoints that may
   provide market descriptions for `@`-assets.

## API Endpoint

```typescript
// Fetch all @-prefixed spot assets
const r = await fetch('https://api.hyperliquid.xyz/info', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'spotMetaAndAssetCtxs' }),
});
const [meta, ctxs] = await r.json();
const atAssets = meta.universe.filter(u => u.name.startsWith('@'));
// Each asset has: name, index, tokens, isCanonical
// Corresponding context has: markPx, prevDayPx, dayNtlVlm
```

## Open Questions

- What do the `@N` names map to? (Need metadata API)
- Are HIP-4 markets settled in USDC or HYPE?
- What's the settlement mechanism (binary 0/1 payout)?
- Can we trade these via the standard HL order API?
