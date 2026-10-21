# Config Audit — Oct 13, 2026

## Baseline
- **Inspected commit:** `0545aaae74745329e8517a6a311b550f221b040a`
- **Audit scope:** `packages/scanner/src/runners/all-runner.ts`, `config/strategies.toml`, and every strategy parameter interface in `packages/scanner/src/strategies/*.ts`.

## Corrections Applied (this sprint)

### 1. `lst_yield_comparison` — max_position_usd misused as minTvlUsd
- **Before:** `minTvlUsd: num(lstYieldCfg, 'max_position_usd', 1_000_000)` — read the position-size key (10,000) and passed it into the TVL filter, silently lowering the TVL threshold from $1M to $10k.
- **After:** Added a dedicated `min_tvl_usd` key to TOML (value: 1,000,000). `max_position_usd` is now documented as "parsed but NOT consumed — LstYieldComparisonScanner has no maxSizeUsd param; riskParams hardcodes 10,000."
- **File:** `packages/scanner/src/runners/strategy-configs.ts` (lstYield section)
- **Test:** `packages/scanner/test/strategy-configs.test.ts` → "CORRECTION 1: lst_yield_comparison" (3 tests)

### 2. `dex_cex_flashloan` — use_flashbots misused as useBalancer
- **Before:** `useBalancer: bool(dexCexCfg, 'use_flashbots', true)` — Flashbots (MEV protection on Ethereum mainnet) and Balancer V2 (flashloan provider) are unrelated concepts. The TOML key `use_flashbots` was driving flashloan provider selection.
- **After:** Added `use_balancer` and `use_aave_fallback` keys to TOML. `use_flashbots` is no longer read for this strategy. `flashloan_provider` is retained in TOML as informational only (the booleans drive actual behavior).
- **File:** `packages/scanner/src/runners/strategy-configs.ts` (dexCexFlashloan section), `config/strategies.toml`
- **Test:** `packages/scanner/test/strategy-configs.test.ts` → "CORRECTION 2: dex_cex_flashloan" (4 tests)

### 3. `solana_memecoin_arb` — broken bps→pct conversion below fee break-even
- **Before:** `minSpreadPct: num(solanaCfg, 'min_edge_bps', 50) / 100 / 10` — the unexplained `/10` factor produced 0.05 pct (5 bps), which is below the 50 bps (0.5%) round-trip PumpApi fee burden. Arbs would fire at a guaranteed loss.
- **After:** Uses standard `/100` conversion (50 bps → 0.5 pct). TOML default raised from 50 to **80 bps** (0.8 pct), giving a 0.3% profit margin above the 0.5% fee burden. The TOML file includes a comment documenting the break-even floor.
- **File:** `packages/scanner/src/runners/strategy-configs.ts` (solanaArb section), `config/strategies.toml`
- **Test:** `packages/scanner/test/strategy-configs.test.ts` → "CORRECTION 3: solana_memecoin_arb" (2 tests)

### 4. `pendle_boros` — ambiguous min_yield_pct renamed to min_spread_apr_pct
- **Before:** `minSpreadApr: num(borosCfg, 'min_yield_pct', 0.5)` — the TOML key `min_yield_pct` is ambiguous (is it absolute yield or spread? percent or decimal?). The strategy parameter `minSpreadApr` is specifically the APR *spread* between fixed and floating, in percent units.
- **After:** Renamed TOML key to `min_spread_apr_pct` (clear: APR spread in percent, 5 = 5% APR spread). The old key is no longer read.
- **File:** `packages/scanner/src/runners/strategy-configs.ts` (pendleBoros section), `config/strategies.toml`
- **Test:** `packages/scanner/test/strategy-configs.test.ts` → "CORRECTION 4: pendle_boros" (3 tests)

## Audit: Parsed-but-ignored config keys

The following TOML keys are parsed by `loadConfig()` but are **NOT consumed** by `buildStrategyConfigs()` or the strategy constructors. They are documented here for transparency.

### `max_concurrent` (all strategies)
- **Status:** Parsed, not consumed.
- **Reason:** `max_concurrent` is a `RiskParams` field, not a strategy-constructor param. Each strategy hardcodes its own `riskParams()` method. Wiring `max_concurrent` through would require modifying every strategy's `riskParams()` method to accept an override.
- **Impact:** The `max_concurrent` values in TOML (2–5 per strategy) have no effect on runtime behavior.
- **Recommendation:** Either (a) wire `max_concurrent` into each strategy's `riskParams()` override, or (b) remove the keys from TOML to avoid implying they're configurable. Track as engineering debt.

### `cooldown_ms` (perp_funding, cex_hl_funding_arb, dex_cex_flashloan, hl_spot_basis)
- **Status:** Parsed, not consumed.
- **Reason:** Same as `max_concurrent` — it's a `RiskParams` field, hardcoded per strategy.
- **Impact:** No effect on runtime behavior.

### `gas_price_cap_mult` (perp_funding)
- **Status:** Parsed, not consumed.
- **Reason:** `RiskParams` field. The global `RiskEnvelope.gasPriceCapMultiplier` is loaded from `process.env.GAS_PRICE_CAP_MULT` in `loadConfig()`, but the per-strategy TOML value is not used.

### `max_position_usd` for strategies without a maxSizeUsd constructor param
- **Affected strategies:**
  - `lst_yield_comparison` — `LstYieldComparisonParams` has no `maxSizeUsd`. `riskParams()` hardcodes 10,000.
  - `hlp_yield` — `HlpYieldParams` has no `maxSizeUsd`. `riskParams()` hardcodes 50,000.
  - `tokenized_equity` — `TokenizedEquityParams` has no `maxSizeUsd`. `riskParams()` hardcodes 500.
- **Status:** Parsed, not consumed for these 3 strategies.
- **Recommendation:** Either wire `max_position_usd` into `riskParams()` overrides, or remove the keys from those 3 TOML sections.

### `flashloan_provider` (dex_cex_flashloan)
- **Status:** Parsed, not consumed (informational only).
- **Reason:** The strategy's flashloan provider selection is driven by the `useBalancer` and `useAaveFallback` booleans. `flashloan_provider` is retained in TOML for documentation but does not drive behavior.
- **Recommendation:** Either implement provider selection from this key (e.g., `"aave-v3"` → `useBalancer: false`), or remove it.

### `use_flashbots` (dex_cex_flashloan, mev_backrun)
- **Status:** Parsed, not consumed.
- **Reason:** Flashbots MEV protection is not yet implemented in any strategy. The `dex_cex_flashloan` section's `use_flashbots` was previously misused to control `useBalancer` (see Correction 2 above).
- **Recommendation:** Implement MEV protection or remove the keys.

### `use_jito_bundles` (mev_backrun)
- **Status:** Parsed, not consumed.
- **Reason:** Jito bundle support is not yet implemented.

### `dex_dex`, `mev_backrun`, `cross_dex_arb`, `precompile_flashloan_arb`
- **Status:** TOML sections exist, but **no strategy is instantiated** in `all-runner.ts`.
- **Reason:** These strategies were planned but not yet built (or were removed). The TOML sections are placeholders.
- **Recommendation:** Either implement and wire these strategies, or remove the TOML sections to avoid implying they're active.

## Testability improvement

Before this sprint, config values were inline in `all-runner.ts` and could not be tested without starting the trading system (which requires API clients, network access, and credentials).

**Historical extraction:** All 29 strategy constructor param objects are now built by the pure function `buildStrategyConfigs(cfg)` in `packages/scanner/src/runners/strategy-configs.ts`. This function:
- Takes an `AppConfig` and returns a typed `StrategyConfigs` object.
- Has no side effects, no client creation, no network access.
- Can be unit-tested with synthetic configs (empty, partial, malformed).
- Every unit conversion (bps → pct) and every fallback is explicit and testable.

**Test coverage:** `packages/scanner/test/strategy-configs.test.ts` — 56 tests covering:
- Empty config → all defaults
- TOML values flow through
- bps → pct conversions (6 strategies)
- The 4 specific corrections (12 tests)
- Type safety (oddsFormat, timeframe)
- Malformed input (wrong types, NaN, non-arrays)
- Per-strategy spot checks

## Update (Oct 13, 14:50 UTC): `max_concurrent` and `cooldown_ms` finding

**Investigation result:** `riskParams()` is called ONLY in tests, never in
production code. The `all-runner.ts` scanner does not invoke `riskParams()`
on any strategy — it calls `scan()` and processes the returned alerts.

This means:
1. The TOML keys `max_concurrent` and `cooldown_ms` are not consumed at runtime.
2. The hardcoded `riskParams()` values in each strategy are ALSO not consumed
   at runtime.
3. These values would only matter if an execution layer checked them before
   placing trades. No such execution layer exists — the system is alert-only
   / paper-trading.

**Disposition:** Wiring TOML into `riskParams()` would be cosmetic — it would
make tests pass with TOML-derived values but would not change any runtime
behavior. This is documented as low-priority engineering debt. When a live
execution layer is added, the wiring should be done at that point, reading
from TOML via the existing `buildStrategyConfigs()` infrastructure.

**Priority downgrade:** P4 (was P3) — deferred until execution layer exists.


## Update — 2026-10-21 (post-merge strategy-wiring review)

The live runner now uses `buildStrategyConfigs(cfg)`; older passages in this document describing the pre-refactor drift are historical. The follow-up change in the Draft strategy-wiring PR wires one more candidate as monitoring-only.

- `cross_dex_arb`: selected as a discovery candidate only. The prior scanner assigned a zero price to every pool, so it emitted no valid cross-DEX comparison. The replacement uses GeckoTerminal's exact base/quote token relationship IDs and canonicalizes pair orientation. It explicitly leaves net profit unavailable and marks every alert non-executable because fees, trade-size slippage, gas and execution routes have not been validated.
- `dex_dex`: duplicate placeholder consolidated into `cross_dex_arb`; do not keep two config sections implying distinct implementations.
- `mev_backrun`: remains unwired. The config's Jito/Flashbots flags are not implementations; production support needs a defined chain-specific transaction stream, searcher/relay integration, simulation, inclusion economics and risk policy.
- `precompile_flashloan_arb`: remains unwired. The current POC compares a HyperCore oracle price with a mark price rather than a validated HyperSwap quote and includes hard-coded sample BTC prices. Hyperliquid documents that CoreWriter actions are processed later than the EVM transaction, so the perp leg cannot be treated as an atomic in-callback repayment leg for a same-transaction flashloan. See https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore.
- GeckoTerminal documents a one-minute cache, beta schema and approximate 10 calls/minute public rate limit. The scanner caches for at least 60 seconds and is discovery/monitoring-only. See https://api.geckoterminal.com/docs/index.html.
- Ramses documents dynamic swap fees. A constant generic 0.30% fee assumption is not reliable enough to claim net profitability. See https://ramsesx.org/.

The earlier section-count findings predate this change. Revalidate TOML sections and runner instantiations on each future audit; configured, instantiated, monitoring-only, economically verified and executable are distinct states.
