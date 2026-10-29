# Strategy Wiring and Validity Audit — 2026-10-21

## Executive finding

No: “configured”, “instantiated”, “produces a signal”, “economically valid”, and “executable” are different states. Before this change, `config/strategies.toml` had 33 section headers while `all-runner.ts` instantiated 29 strategies and `buildStrategyConfigs()` returned 29 config objects. Four sections were not wired: `dex_dex`, `mev_backrun`, `cross_dex_arb`, and `precompile_flashloan_arb`.

This change wires one viable subset only: `cross_dex_arb` becomes a **monitoring-only cross-DEX reference-price divergence scanner**. It is not an execution strategy and does not claim positive net returns. The duplicate `dex_dex` section is removed.

## Candidate disposition

| Candidate | Current assessment | Disposition |
| --- | --- | --- |
| Cross-DEX price divergence on HyperEVM | Public pool reference prices can detect a gross divergence if exact token identities and price orientation are reconciled. Reserves do not establish executable depth. | Wire for info-only monitoring, using exact token relationship IDs, reserve floor and one-minute cache. Net profit remains unavailable. |
| Generic `dex_dex` | Duplicates the cross-DEX concept but has no dedicated implementation. | Remove duplicate config section and consolidate under `cross_dex_arb`. |
| MEV backrun | TOML mentions Jito/Flashbots flags, but the flags alone do not supply a chain-specific mempool/transaction feed, relay integration, transaction simulation, inclusion guarantee, or net economics. | Keep unwired; research these components as a separate task. |
| HyperEVM precompile + flashloan + HyperCore perp | Existing prototype compares a HyperCore oracle price to mark price, not an actual DEX quote; includes fabricated fixed BTC prices and an unverified scale. The CoreWriter order path is processed after the EVM transaction, so treating a perp order and flashloan repayment as one atomic callback is invalid. | Do not wire. Keep as a prototype only; any redesign must use inventory-backed execution or a model that does not depend on CoreWriter completing inside the EVM transaction. |

## Cross-DEX implementation contract

- Query the public GeckoTerminal pool listing for Ramses V3, HyperSwap V2 and HyperSwap V3 on HyperEVM.
- Request the documented API version; canonicalize a pair by exact token relationship IDs rather than display symbols or names.
- Orient each price to a canonical “token1 per token0” basis, including reverse-order pools.
- Ignore pools with missing/invalid prices or reserves below the configured floor.
- Cache results for at least 60 seconds to respect the documented public API cache/rate limit.
- Emit only `severity: info` alerts. Every result has `monitoringOnly: true`, `executable: false`, `estimatedProfitUsd: null` and `netProfitUsd: null`.
- No claim of profitable arbitrage is allowed until pool-specific fees, executable trade-size quotes, slippage, gas, routing and execution/atomicity have been independently validated.

Public references:
- GeckoTerminal API schema, cache and rate notes: https://api.geckoterminal.com/docs/index.html
- GeckoTerminal pool price fields: https://apiguide.geckoterminal.com/changelogs
- Ramses dynamic-fee description: https://ramsesx.org/
- Hyperliquid CoreWriter timing: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore

## Verification required before acceptance

- CI tests must pass on the exact Draft PR head.
- Tests must cover reverse token ordering, exact token identity, reserve floor, API error fail-closed behavior, one-minute request cache, null profit fields, and info-only alert dispatch.
- This change does not invoke the scanner, run a live scan, call public APIs from tests, or authorize collection, deployment, live trading or capital movement.
