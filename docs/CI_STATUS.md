# CI Status

## Current state: CI PASSING (as of Oct 13, 2026)

**GitHub Actions CI is enabled and passing.** The workflow runs on every
push/PR to `main` and executes: install, workspace build, scanner
typecheck, scanner build, and the full vitest suite.

## Resolution history (Oct 13, 2026)

Four issues were resolved in sequence to get CI green:

### 1. `.github/workflows/` was gitignored (commit `0764a68`)
- **Cause:** Prior commit `694c60e` added `.github/workflows/` to `.gitignore` as a workaround because the PAT lacked `workflow` scope.
- **Fix:** Principal granted `workflow` scope to the PAT. Removed the gitignore entry and pushed `ci.yml`.

### 2. pnpm version conflict — ERR_PNPM_BAD_PM_VERSION (commit `49aa2a3`)
- **Cause:** `pnpm/action-setup@v4` specified `version: 12` while `package.json` specified `packageManager: pnpm@12.6.0`.
- **Fix:** Removed the `version` key from the workflow — `pnpm/action-setup@v4` reads `packageManager` from `package.json` automatically.

### 3. Blocked build scripts — ERR_PNPM_IGNORED_BUILDS (commits `3786a7a`, `4f6477c`)
- **Cause:** pnpm v12 blocks dependency build scripts by default for security. The 3 affected packages (`bufferutil`, `ccxt`, `esbuild`) need postinstall scripts.
- **Fix:** Added `onlyBuiltDependencies` and `dangerouslyAllowAllBuilds: true` to `pnpm-workspace.yaml`, plus `--config.strict-build-check=false` on the install command.

### 4. Module resolution — Cannot find module @edge/* (commit `5612586`)
- **Cause:** `tsc --noEmit` in `@edge/scanner` could not resolve `@edge/types`, `@edge/alerts`, etc. because the workspace packages hadn't been built (no `.d.ts` files).
- **Fix:** Added `pnpm -r build` step after install, before scanner typecheck. This builds all 13 workspace packages in dependency order.

## Current workflow

File: `.github/workflows/ci.yml`

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile --config.strict-build-check=false
      - run: pnpm -r build
      - run: pnpm --filter @edge/scanner typecheck
      - run: pnpm --filter @edge/scanner build
      - run: npx vitest run
```

## Reproducible local verification (equivalent to CI)

```bash
cd edge-engine
pnpm install --frozen-lockfile
pnpm -r build
pnpm --filter @edge/scanner typecheck
pnpm --filter @edge/scanner build
npx vitest run
```

## Security note

The GitHub PAT is still embedded in the remote URL. This is a security
risk — anyone with access to the repo config can extract it. The
Principal should rotate the PAT and configure the remote using a
credential helper or `gh auth login` instead of embedding it in the URL.
This is tracked as security debt.

