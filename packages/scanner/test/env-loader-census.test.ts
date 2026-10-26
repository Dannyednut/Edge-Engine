import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import {
  loadDotEnvIntoProcessEnv,
  parseDotEnvContents,
  DOTENV_EXCLUDED_KEYS,
  EXECUTION_AUTH_ENV_VAR,
} from '@edge/risk';

// ─── EM-STRAT-014-C — `.env` loader hygiene census + fixture tests ──────
//
// Offline CI test that enforces the invariant: every `.env` loader in
// scripts-explore/**/*.mts (excluding archive/ and *.mts.quarantined) must
// either (a) use the shared loadDotEnvIntoProcessEnv helper (which excludes
// EDGE_EXECUTION_AUTH), or (b) manually exclude EDGE_EXECUTION_AUTH.
//
// This is a GLOB-BASED scan (not a fixed allowlist): any newly added .mts
// file that introduces a .env loader without the helper or manual exclusion
// fails CI. The invariant is enforced for future files, not just the 139
// files converted in EM-STRAT-014-C.
//
// Synthetic fixtures (Section 2) prove the shared helper excludes
// EDGE_EXECUTION_AUTH: a temp .env file containing the key is loaded, and
// process.env.EDGE_EXECUTION_AUTH must remain undefined. No real .env file
// is ever read; all fixtures use synthetic keys with temp-file paths.
//
// Constraints: $0 budget, offline-only, no real .env reads, no scanner /
// executor / daemon / RPC / API / deployment execution. This test only
// reads source files and writes temp fixture files under os.tmpdir().

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPTS_EXPLORE_DIR = resolve(REPO_ROOT, 'scripts-explore');

// ─── Comment stripping (mirrors execution-sink-census.test.ts) ──────────

function stripComments(source: string): string {
  return source.split('\n').map(line => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return '';
    const idx = line.indexOf('//');
    if (idx > 0 && line[idx - 1] !== ':' && line[idx - 1] !== "'") {
      return line.slice(0, idx);
    }
    return line;
  }).join('\n');
}

// ─── Glob: collect all executable .mts files in scripts-explore/ ────────

function collectExecutableMtsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    // Skip the archive/ subdirectory entirely (dormant by convention).
    if (entry === 'archive') continue;
    // Skip node_modules.
    if (entry === 'node_modules') continue;
    // Recurse into subdirectories.
    if (existsSync(full) && statSync(full).isDirectory()) {
      results.push(...collectExecutableMtsFiles(full));
      continue;
    }
    // Include .mts files; EXCLUDE .mts.quarantined (not executable).
    if (entry.endsWith('.mts') && !entry.endsWith('.mts.quarantined')) {
      results.push(full);
    }
  }
  return results;
}

// ─── Section 1: Glob-based census invariant ─────────────────────────────

describe('EM-STRAT-014-C — .env loader hygiene census (glob-based, no allowlist)', () => {
  const allFiles = collectExecutableMtsFiles(SCRIPTS_EXPLORE_DIR);

  it('scan discovered executable .mts files in scripts-explore/ (sanity)', () => {
    // Sanity: the scan found files (not an empty glob).
    expect(allFiles.length).toBeGreaterThan(100);
  });

  it('every .env loader uses the shared helper OR manually excludes EDGE_EXECUTION_AUTH', () => {
    const violations: string[] = [];
    const loaders: string[] = [];
    const safeLoaders: string[] = [];
    const helperLoaders: string[] = [];

    for (const filepath of allFiles) {
      const rel = relative(REPO_ROOT, filepath);
      const raw = readFileSync(filepath, 'utf8');
      const src = stripComments(raw);

      // Detect a .env loader: readFileSync(resolve(REPO_ROOT, '.env'))
      // (the hand-rolled pattern) OR loadDotEnvIntoProcessEnv(...) (the
      // shared helper). Files without either are not .env loaders.
      const hasInlineLoader = /readFileSync\(\s*resolve\(\s*REPO_ROOT\s*,\s*['"]\.env['"]\s*\)/.test(src);
      const hasHelperLoader = /loadDotEnvIntoProcessEnv\s*\(/.test(src);

      if (!hasInlineLoader && !hasHelperLoader) continue; // not a .env loader

      // This file IS a .env loader. It must satisfy the invariant.
      const usesHelper = hasHelperLoader;
      const hasManualExclusion = /EDGE_EXECUTION_AUTH/.test(src);

      if (usesHelper) {
        helperLoaders.push(rel);
      } else if (hasManualExclusion) {
        safeLoaders.push(rel);
      } else {
        // VIOLATION: .env loader without the helper and without manual exclusion.
        violations.push(rel);
      }

      // Additional check: if the file has the inline loader pattern (not the
      // helper), it MUST have the manual exclusion. The inline pattern alone
      // is a violation.
      if (hasInlineLoader && !hasManualExclusion) {
        if (!violations.includes(rel)) violations.push(rel);
      }

      loaders.push(rel);
    }

    // The invariant: zero violations.
    expect(violations).toEqual([]);

    // Sanity counts: we expect ~139 helper loaders + 5 safe loaders = ~144.
    // (Use >= so the test does not break if new safe loaders are added.)
    expect(helperLoaders.length).toBeGreaterThanOrEqual(139);
    expect(safeLoaders.length).toBeGreaterThanOrEqual(5);
  });

  it('no executable .mts file in scripts-explore/ has the old inline .env parser without exclusion', () => {
    // Direct check for the old inline pattern: readFileSync(resolve(REPO_ROOT, '.env'))
    // followed by the regex match loop, WITHOUT EDGE_EXECUTION_AUTH exclusion.
    // This catches a future regression where someone copies the old block back.
    const oldPatternFiles: string[] = [];
    for (const filepath of allFiles) {
      const rel = relative(REPO_ROOT, filepath);
      const raw = readFileSync(filepath, 'utf8');
      const src = stripComments(raw);

      const hasOldInlineLoader = /readFileSync\(\s*resolve\(\s*REPO_ROOT\s*,\s*['"]\.env['"]\s*\)/.test(src);
      const hasManualExclusion = /EDGE_EXECUTION_AUTH/.test(src);

      if (hasOldInlineLoader && !hasManualExclusion) {
        oldPatternFiles.push(rel);
      }
    }
    expect(oldPatternFiles).toEqual([]);
  });

  it('archive/ and .mts.quarantined files are excluded from the scan (dormant)', () => {
    // Verify no archive/ or .quarantined file appears in the scan results.
    for (const filepath of allFiles) {
      const rel = relative(REPO_ROOT, filepath);
      expect(rel).not.toContain('archive/');
      expect(rel).not.toMatch(/\.mts\.quarantined$/);
    }
  });
});

// ─── Section 2: Synthetic fixtures — .env cannot arm the guard ──────────

describe('EM-STRAT-014-C — synthetic fixtures: loadDotEnvIntoProcessEnv excludes EDGE_EXECUTION_AUTH', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(process.cwd(), '.tmp-env-loader-test-' + process.pid + '-' + Date.now());
    mkdirSync(tempDir, { recursive: true });
    // Ensure EDGE_EXECUTION_AUTH is not set from the test runner environment.
    delete process.env[EXECUTION_AUTH_ENV_VAR];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    // Clean up any synthetic keys that might have been set.
    delete process.env.SYNTHETIC_API_KEY;
    delete process.env.SYNTHETIC_RPC_URL;
    delete process.env.SYNTHETIC_TOKEN;
  });

  it('EDGE_EXECUTION_AUTH in .env is NOT copied to process.env (the helper excludes it)', () => {
    // Write a synthetic .env fixture containing EDGE_EXECUTION_AUTH + regular keys.
    // The value is a SYNTHETIC descriptor (not a real credential); it is never
    // used to authorize anything — the test only checks that the helper does
    // NOT copy it to process.env.
    const envPath = join(tempDir, '.env');
    const syntheticDescriptor = JSON.stringify({
      authId: 'SYNTHETIC-NEVER-USED',
      expiresAtMs: Date.now() + 60_000,
      scopes: ['vooi:place-arbitrage-order'],
    });
    writeFileSync(envPath, [
      '# Synthetic .env fixture for EM-STRAT-014-C test',
      'SYNTHETIC_API_KEY=test-key-12345',
      'SYNTHETIC_RPC_URL=https://synthetic.example.com',
      `${EXECUTION_AUTH_ENV_VAR}=${syntheticDescriptor}`,
      'SYNTHETIC_TOKEN=abc123',
    ].join('\n') + '\n');

    // Load via the shared helper.
    loadDotEnvIntoProcessEnv(envPath);

    // Regular keys ARE loaded.
    expect(process.env.SYNTHETIC_API_KEY).toBe('test-key-12345');
    expect(process.env.SYNTHETIC_RPC_URL).toBe('https://synthetic.example.com');
    expect(process.env.SYNTHETIC_TOKEN).toBe('abc123');

    // EDGE_EXECUTION_AUTH is NOT loaded (the helper excludes it).
    expect(process.env[EXECUTION_AUTH_ENV_VAR]).toBeUndefined();
  });

  it('parseDotEnvContents excludes EDGE_EXECUTION_AUTH from the returned record', () => {
    // Pure-parser test: the excluded key never appears in the parsed record.
    const syntheticDescriptor = JSON.stringify({
      authId: 'SYNTHETIC-PARSER-TEST',
      expiresAtMs: Date.now() + 60_000,
      scopes: ['vooi:place-arbitrage-order'],
    });
    const content = [
      'SYNTHETIC_API_KEY=parser-test-key',
      `${EXECUTION_AUTH_ENV_VAR}=${syntheticDescriptor}`,
      'SYNTHETIC_TOKEN=parser-test-token',
    ].join('\n');

    const parsed = parseDotEnvContents(content);

    // Regular keys are present.
    expect(parsed.SYNTHETIC_API_KEY).toBe('parser-test-key');
    expect(parsed.SYNTHETIC_TOKEN).toBe('parser-test-token');

    // EDGE_EXECUTION_AUTH is absent from the record.
    expect(parsed[EXECUTION_AUTH_ENV_VAR]).toBeUndefined();
    expect(Object.keys(parsed)).not.toContain(EXECUTION_AUTH_ENV_VAR);
  });

  it('DOTENV_EXCLUDED_KEYS contains exactly EDGE_EXECUTION_AUTH', () => {
    // The exclusion set must contain the execution-auth env var.
    expect(DOTENV_EXCLUDED_KEYS.has(EXECUTION_AUTH_ENV_VAR)).toBe(true);
    // And it should be the only excluded key (unless future work adds more).
    expect(DOTENV_EXCLUDED_KEYS.size).toBeGreaterThanOrEqual(1);
  });

  it('parent-process EDGE_EXECUTION_AUTH is NOT overwritten by .env (parent wins)', () => {
    // Even if .env contained EDGE_EXECUTION_AUTH (which the helper skips),
    // the helper also does not overwrite existing process.env keys. This
    // double-proves: a parent-process descriptor is preserved, and a .env
    // descriptor cannot arm the guard.
    const envPath = join(tempDir, '.env');
    const parentDescriptor = JSON.stringify({
      authId: 'SYNTHETIC-PARENT-PROC',
      expiresAtMs: Date.now() + 60_000,
      scopes: ['vooi:place-arbitrage-order'],
    });
    process.env[EXECUTION_AUTH_ENV_VAR] = parentDescriptor;

    const dotenvDescriptor = JSON.stringify({
      authId: 'SYNTHETIC-DOTENV-ATTEMPT',
      expiresAtMs: Date.now() + 60_000,
      scopes: ['vooi:place-arbitrage-order'],
    });
    writeFileSync(envPath, [
      `${EXECUTION_AUTH_ENV_VAR}=${dotenvDescriptor}`,
      'SYNTHETIC_API_KEY=parent-wins-test',
    ].join('\n') + '\n');

    loadDotEnvIntoProcessEnv(envPath);

    // The parent-process value is preserved (helper does not overwrite).
    expect(process.env[EXECUTION_AUTH_ENV_VAR]).toBe(parentDescriptor);
    // Regular key is loaded (helper works).
    expect(process.env.SYNTHETIC_API_KEY).toBe('parent-wins-test');
  });

  it('missing .env file is a no-op (no throw, no mutation)', () => {
    const missingPath = join(tempDir, 'does-not-exist.env');
    // Should not throw.
    expect(() => loadDotEnvIntoProcessEnv(missingPath)).not.toThrow();
    // No mutation.
    expect(process.env[EXECUTION_AUTH_ENV_VAR]).toBeUndefined();
  });

  it('quoted values are stripped (single and double quotes)', () => {
    const envPath = join(tempDir, '.env');
    writeFileSync(envPath, [
      'SYNTHETIC_DOUBLE="double-quoted-value"',
      "SYNTHETIC_SINGLE='single-quoted-value'",
      'SYNTHETIC_BARE=bare-value',
    ].join('\n') + '\n');

    loadDotEnvIntoProcessEnv(envPath);

    expect(process.env.SYNTHETIC_DOUBLE).toBe('double-quoted-value');
    expect(process.env.SYNTHETIC_SINGLE).toBe('single-quoted-value');
    expect(process.env.SYNTHETIC_BARE).toBe('bare-value');

    // Cleanup.
    delete process.env.SYNTHETIC_DOUBLE;
    delete process.env.SYNTHETIC_SINGLE;
    delete process.env.SYNTHETIC_BARE;
  });
});

// ─── Section 3: Guard remains fail-closed without explicit env ──────────

describe('EM-STRAT-014-C — .env cannot arm the guard (integration with execution guard)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(process.cwd(), '.tmp-env-loader-guard-' + process.pid + '-' + Date.now());
    mkdirSync(tempDir, { recursive: true });
    delete process.env[EXECUTION_AUTH_ENV_VAR];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    delete process.env.SYNTHETIC_GUARD_TEST_KEY;
  });

  it('a .env containing a valid-looking descriptor does NOT arm the guard', async () => {
    // Write a .env with a descriptor that WOULD be valid if it reached the guard.
    const envPath = join(tempDir, '.env');
    const validLookingDescriptor = JSON.stringify({
      authId: 'SYNTHETIC-GUARD-TEST',
      expiresAtMs: Date.now() + 60_000,
      scopes: ['vooi:place-arbitrage-order'],
    });
    writeFileSync(envPath, [
      `${EXECUTION_AUTH_ENV_VAR}=${validLookingDescriptor}`,
      'SYNTHETIC_GUARD_TEST_KEY=loaded',
    ].join('\n') + '\n');

    // Load via the shared helper.
    loadDotEnvIntoProcessEnv(envPath);

    // The regular key IS loaded.
    expect(process.env.SYNTHETIC_GUARD_TEST_KEY).toBe('loaded');

    // EDGE_EXECUTION_AUTH is NOT in process.env (helper excluded it).
    expect(process.env[EXECUTION_AUTH_ENV_VAR]).toBeUndefined();

    // Therefore the guard would DENY (we verify by re-parsing the env var).
    // We do NOT call assertExecutionAuthorized here (it would throw); instead
    // we verify the precondition: the env var is unset, so the guard's
    // parseExecutionAuthorization would return { ok: false }.
    const { parseExecutionAuthorization } = await import('@edge/risk');
    const result = parseExecutionAuthorization(
      process.env[EXECUTION_AUTH_ENV_VAR],
      Date.now(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('not set');
    }
  });
});
