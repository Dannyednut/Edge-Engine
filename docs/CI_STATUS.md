# CI Status and Permission Blocker

## Current state: NO CI is running

**As of Oct 13, 2026, no GitHub Actions CI runs on this repository.**
Any claim of "CI passing" or "CI validated" would be false.

## Root cause: two compounding issues

### Issue 1: `.github/workflows/` is gitignored

File: `.gitignore` line 53:
```
.github/workflows/
```

A local workflow file exists at `.github/workflows/ci.yml` but is **never
pushed** to GitHub because of this gitignore rule. The file is effectively
dead code — it has never executed.

### Issue 2: GitHub PAT lacks `workflow` scope

The repository is pushed using a Personal Access Token (PAT) embedded in
the remote URL (redacted here for security):

```
https://***@github.com/Dannyednut/Edge-Engine.git
```

This PAT does **not** have the `workflow` scope. Even if we removed the
`.gitignore` entry, any `git push` that includes files under
`.github/workflows/` would be rejected by GitHub with:

```
refspec 'refs/heads/main' -> main (denied)
! [remote rejected] main -> main (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflow` permission)
```

This was discovered in the prior shift (commit `694c60e`, which added the
gitignore rule as a workaround so that non-workflow commits could still
push).

## What the local ci.yml would do (if it could run)

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
        with: { version: 9 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: npx vitest run
```

This is a reasonable CI definition. It would run `pnpm install`, `pnpm build`,
and `npx vitest run` on every push/PR to `main`.

## Reproducible local verification (in lieu of CI)

Since CI cannot run, the following commands provide equivalent local
verification. All outputs are captured in the acceptance report.

```bash
# 1. Typecheck (zero errors expected)
cd edge-engine
./node_modules/.bin/tsc --noEmit -p packages/scanner/tsconfig.json

# 2. Build (zero errors expected)
./node_modules/.bin/tsc -p packages/scanner/tsconfig.json

# 3. Test (124 tests expected to pass)
npx vitest run
```

## Action required from principal

To enable real CI, the principal must:

1. **Rotate the GitHub PAT** (the current one is embedded in the remote
   URL — a security risk).
2. **Grant the `workflow` scope** to the new PAT.
3. **Update the remote URL** with the new PAT:
   ```bash
   git remote set-url origin https://<NEW_PAT>@github.com/Dannyednut/Edge-Engine.git
   ```
4. **Remove line 53** from `.gitignore` (the `.github/workflows/` entry).
5. **Commit and push** the `.github/workflows/ci.yml` file.

Until these steps are taken, CI will not run and any CI status claim
would be false.

## What will NOT be done (per principal's directive)

- The PAT will not be exposed in logs, commits, or messages.
- The `.gitignore` rule will not be removed without a PAT that has
  `workflow` scope (doing so would cause all pushes to fail).
- No workaround will be implemented that pretends ignored workflow
  files constitute CI.
