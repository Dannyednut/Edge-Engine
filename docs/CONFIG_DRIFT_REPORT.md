# Config Drift Report — Oct 13, 2026

## Issue
`config/strategies.toml` is parsed by `loadConfig()` and stored in `cfg.strategies`,
but `packages/scanner/src/runners/all-runner.ts` does NOT reference `cfg.strategies`.

## Evidence
- `packages/config/src/index.ts` line 89: parses strategies.toml
- `packages/config/src/index.ts` line 125: stores in `cfg.strategies`
- `packages/scanner/src/runners/all-runner.ts`: 0 references to `cfg.strategies`
- All strategy parameters are hardcoded in all-runner.ts (e.g., `minSpreadApr: 0.08`)

## Impact
- Changing `config/strategies.toml` has NO effect on runtime behavior
- Parameters must be changed in source code directly
- This creates a maintenance risk: operators may edit the toml expecting changes

## Recommendation
Option A (quick): Add a comment to strategies.toml noting it is not yet consumed
Option B (proper): Refactor all-runner.ts to read parameters from cfg.strategies

## Status
**OPEN** — needs engineering work to resolve
**Risk**: LOW (no runtime impact, but maintenance confusion)
**Owner**: Manager
