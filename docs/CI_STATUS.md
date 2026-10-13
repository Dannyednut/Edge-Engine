# CI Status

## Current state: CI ENABLED (as of Oct 13, 2026, 14:26 UTC)

**GitHub Actions CI is now enabled.** The `.github/workflows/` gitignore
entry has been removed and the workflow file has been pushed (commit
`0764a68`). The Principal granted `workflow` scope to the PAT, resolving
the prior blocker.

## History

### Prior blocker (resolved Oct 13, 2026)

Two compounding issues previously prevented CI from running:

1. `.github/workflows/` was gitignored (added in commit `694c60e` as a
   workaround so that non-workflow commits could push).
2. The GitHub PAT lacked the `workflow` scope, so pushes containing
   workflow files would be rejected by GitHub.

**Resolution:** The Principal granted `workflow` scope to the PAT.
Commit `0764a68` removed the gitignore entry and pushed `ci.yml`.

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
        with: { version: 12 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @edge/scanner typecheck
      - run: pnpm --filter @edge/scanner build
      - run: npx vitest run
```

This runs on every push/PR to `main`:
1. Install dependencies (pnpm, frozen lockfile)
2. Typecheck the scanner package
3. Build the scanner package
4. Run the full vitest suite

## Reproducible local verification (equivalent to CI)

```bash
cd edge-engine
./node_modules/.bin/tsc --noEmit -p packages/scanner/tsconfig.json   # typecheck
./node_modules/.bin/tsc -p packages/scanner/tsconfig.json            # build
npx vitest run                                                       # tests
```

## Security note

The GitHub PAT is still embedded in the remote URL. This is a security
risk — anyone with access to the repo config can extract it. The
Principal should rotate the PAT and configure the remote using a
credential helper or `gh auth login` instead of embedding it in the URL.
This is tracked as security debt.
