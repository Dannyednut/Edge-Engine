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
// either (a) call the shared loadDotEnvIntoProcessEnv helper IMPORTED FROM
// THE APPROVED MODULE (packages/risk/src/dotenv-safety.ts / @edge/risk), or
// (b) manually exclude EDGE_EXECUTION_AUTH.
//
// EM-STRAT-014-C-R1 — HARDENED ADVERSARIAL DETECTION:
//   - Detection is BROADENED beyond `readFileSync(resolve(REPO_ROOT, '.env'))`:
//     any readFileSync/readFile whose argument list references a `.env`
//     string literal (covers join(...), resolve(...), __dirname, any
//     differently named root constant, single/double quotes), plus any call
//     receiving a `.env` path literal, plus `dotenv` npm-module imports.
//   - A `loadDotEnvIntoProcessEnv(...)` call is only SAFE when the name is
//     IMPORTED from the approved shared module. A locally defined lookalike
//     (function/const with the same name, or a call without the approved
//     import) FAILS the census.
//   - The adversarial fixtures below feed SYNTHETIC SOURCE STRINGS through
//     the EXACT classification function CI runs, proving: join/__dirname
//     variants are caught, a local fake helper is caught, and the approved
//     import passes.
//
// KNOWN LIMITS OF STATIC ANALYSIS (declared, per the work order):
//   - This is a regex tripwire, not a proof. It cannot see through:
//     multiline call arguments (`.env` on a different line from the call
//     name), dynamic path construction ('.en' + 'v'), aliased imports
//     (`import { x as loadDotEnvIntoProcessEnv }`), re-exported helpers,
//     or reads routed through a non-fs indirection module. Deliberate
//     evasion is out of scope for an accident-prevention control; the
//     detection above aims to catch ACCIDENTAL reintroductions of the
//     hand-rolled loader pattern in its common shapes.
//   - The scan is GLOB-BASED (no fixed allowlist): future files are
//     automatically covered. archive/ and *.mts.quarantined are excluded
//     exactly as documented (dormant, not executable) and are NOT edited.
//
// Synthetic fixtures (Section 2) prove the shared helper excludes
// EDGE_EXECUTION_AUTH at runtime: a temp synthetic .env is loaded and the
// key must stay absent from process.env. No real .env file is ever read;
// no .env value is ever logged.
//
// Constraints: $0 budget, offline-only, no real .env inspection, no scanner
// / executor / daemon / RPC / API / deployment execution.

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
    if (entry === 'archive') continue; // dormant by convention (documented)
    if (entry === 'node_modules') continue;
    if (existsSync(full) && statSync(full).isDirectory()) {
      results.push(...collectExecutableMtsFiles(full));
      continue;
    }
    if (entry.endsWith('.mts') && !entry.endsWith('.mts.quarantined')) {
      results.push(full);
    }
  }
  return results;
}

// ─── EM-STRAT-014-C-R1: the EXACT detection/classification CI runs ──────
//
// Pure functions over source text so the adversarial synthetic fixtures
// exercise the same logic as the live tree scan (execution-sink-census
// pattern).

/** Broadened `.env`-loader detection (see the limits note above). */
export function detectEnvLoaderSource(src: string): boolean {
  const helperCall = /loadDotEnvIntoProcessEnv\s*\(/.test(src);
  // readFileSync/readFile whose single-line argument list references a
  // `.env` string literal — catches resolve(...), join(...), __dirname,
  // REPO_ROOT, differently named roots, relative/absolute literals, and
  // both quote styles.
  const fsReadEnv = /\b(?:readFileSync|readFile)\s*\([^)]*?['"]\.env['"]/.test(src);
  // Any call whose argument list ENDS with a `.env` path literal (wrapped
  // read helpers, e.g. loadDotEnv(resolve(ROOT, '.env')) or readEnv(join(d, '.env'))).
  const envArgCall = /['"]\.env['"]\s*\)/.test(src);
  // The dotenv npm module (its config() does NOT exclude EDGE_EXECUTION_AUTH).
  const dotenvModule = /(?:import\s[^;]*from\s*|require\(\s*)['"]dotenv(?:\/[a-z-]+)?['"]/.test(src);
  return helperCall || fsReadEnv || envArgCall || dotenvModule;
}

/** The ONLY import sources the shared helper may come from. */
const APPROVED_HELPER_IMPORT_RE =
  /import\s*\{[^}]*loadDotEnvIntoProcessEnv[^}]*\}\s*from\s*['"](?:@edge\/risk(?:\/[a-z-]+)?|(?:\.\.?\/)+packages\/risk\/src\/dotenv-safety\.(?:ts|js))['"]/;

/** A locally defined lookalike helper is NEVER the approved import. */
const LOCAL_HELPER_DEF_RE =
  /(?:function\s+loadDotEnvIntoProcessEnv\b|(?:const|let|var)\s+loadDotEnvIntoProcessEnv\s*[:=])/;

export interface EnvLoaderClassification {
  isLoader: boolean;
  safe: boolean;
  /** Why the loader is unsafe (only when isLoader && !safe). */
  violation?: string;
}

/** Classify one source file's `.env`-loader posture (the census invariant). */
export function classifyEnvLoaderSource(src: string): EnvLoaderClassification {
  const s = stripComments(src);
  if (!detectEnvLoaderSource(s)) return { isLoader: false, safe: true };

  const hasManualExclusion = /EDGE_EXECUTION_AUTH/.test(s);
  const hasApprovedImport = APPROVED_HELPER_IMPORT_RE.test(s);
  const hasLocalDef = LOCAL_HELPER_DEF_RE.test(s);
  const fsReadEnv = /\b(?:readFileSync|readFile)\s*\([^)]*?['"]\.env['"]/.test(s);
  const dotenvModule = /(?:import\s[^;]*from\s*|require\(\s*)['"]dotenv(?:\/[a-z-]+)?['"]/.test(s);

  if (hasLocalDef) {
    return { isLoader: true, safe: false, violation: 'local_lookalike_helper_definition' };
  }
  if (dotenvModule) {
    return { isLoader: true, safe: false, violation: 'dotenv_npm_module_config_does_not_exclude_edge_execution_auth' };
  }
  if (fsReadEnv && !hasManualExclusion) {
    return { isLoader: true, safe: false, violation: 'inline_env_file_read_without_edge_execution_auth_exclusion' };
  }
  if (/loadDotEnvIntoProcessEnv\s*\(/.test(s) && !hasApprovedImport) {
    return { isLoader: true, safe: false, violation: 'helper_name_called_without_approved_import' };
  }
  return { isLoader: true, safe: true };
}

// ─── Section 1: Glob-based census invariant ─────────────────────────────

describe('EM-STRAT-014-C — .env loader hygiene census (glob-based, no allowlist)', () => {
  const allFiles = collectExecutableMtsFiles(SCRIPTS_EXPLORE_DIR);

  it('scan discovered executable .mts files in scripts-explore/ (sanity)', () => {
    expect(allFiles.length).toBeGreaterThan(100);
  });

  it('every .env loader uses the approved imported helper OR manually excludes EDGE_EXECUTION_AUTH', () => {
    const violations: string[] = [];
    const helperLoaders: string[] = [];
    const safeManualLoaders: string[] = [];

    for (const filepath of allFiles) {
      const rel = relative(REPO_ROOT, filepath);
      const src = readFileSync(filepath, 'utf8');
      const cls = classifyEnvLoaderSource(src);
      if (!cls.isLoader) continue;
      if (cls.safe) {
        if (/EDGE_EXECUTION_AUTH/.test(stripComments(src))) safeManualLoaders.push(rel);
        else helperLoaders.push(rel);
      } else {
        violations.push(`${rel}: ${cls.violation}`);
      }
    }

    expect(violations).toEqual([]);

    // Sanity counts on the remediated tree: 139 approved-helper loaders +
    // 5 safe manual-exclusion loaders. Use >= so adding MORE safe loaders
    // does not break the census.
    expect(helperLoaders.length).toBeGreaterThanOrEqual(139);
    expect(safeManualLoaders.length).toBeGreaterThanOrEqual(5);
  });

  it('helper loaders import from the APPROVED shared module (not a lookalike source)', () => {
    for (const filepath of allFiles) {
      const src = readFileSync(filepath, 'utf8');
      const s = stripComments(src);
      if (!/loadDotEnvIntoProcessEnv\s*\(/.test(s)) continue;
      expect(
        APPROVED_HELPER_IMPORT_RE.test(s),
        `${relative(REPO_ROOT, filepath)} must import loadDotEnvIntoProcessEnv from @edge/risk or ../packages/risk/src/dotenv-safety.{ts,js}`,
      ).toBe(true);
      expect(
        LOCAL_HELPER_DEF_RE.test(s),
        `${relative(REPO_ROOT, filepath)} must not define a local lookalike helper`,
      ).toBe(false);
    }
  });

  it('archive/ and .mts.quarantined files are excluded from the scan (dormant)', () => {
    for (const filepath of allFiles) {
      const rel = relative(REPO_ROOT, filepath);
      expect(rel).not.toContain('archive/');
      expect(rel).not.toMatch(/\.mts\.quarantined$/);
    }
  });
});

// ─── Section 1b: Adversarial synthetic source fixtures (C-R1) ───────────

describe('EM-STRAT-014-C-R1 — adversarial synthetic source fixtures (the exact CI classifier)', () => {
  it('UNSAFE: readFileSync(join(ROOT, \'.env\')) — differently named root via join — is caught', () => {
    const src = [
      "import { readFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const ROOT = '/somewhere';",
      "const env = readFileSync(join(ROOT, '.env'), 'utf8');",
      "process.env.FOO = 'bar';",
    ].join('\n');
    const cls = classifyEnvLoaderSource(src);
    expect(cls.isLoader).toBe(true);
    expect(cls.safe).toBe(false);
    expect(cls.violation).toBe('inline_env_file_read_without_edge_execution_auth_exclusion');
  });

  it('UNSAFE: readFileSync(resolve(__dirname, \'.env\')) — __dirname root — is caught', () => {
    const src = [
      "import { readFileSync } from 'node:fs';",
      "import { resolve } from 'node:path';",
      "const env = readFileSync(resolve(__dirname, '.env'), 'utf8');",
    ].join('\n');
    const cls = classifyEnvLoaderSource(src);
    expect(cls.isLoader).toBe(true);
    expect(cls.safe).toBe(false);
    expect(cls.violation).toBe('inline_env_file_read_without_edge_execution_auth_exclusion');
  });

  it('UNSAFE: locally defined fake helper with the approved name is caught (no approved import)', () => {
    const src = [
      "import { readFileSync } from 'node:fs';",
      "function loadDotEnvIntoProcessEnv(p: string): void {",
      "  const c = readFileSync(p, 'utf8');",
      "  for (const line of c.split('\\n')) {",
      "    const [k, v] = line.split('=');",
      "    if (k && v && !process.env[k]) process.env[k] = v; // NO exclusion!",
      "  }",
      "}",
      "loadDotEnvIntoProcessEnv('.env');",
    ].join('\n');
    const cls = classifyEnvLoaderSource(src);
    expect(cls.isLoader).toBe(true);
    expect(cls.safe).toBe(false);
    expect(cls.violation).toBe('local_lookalike_helper_definition');
  });

  it('UNSAFE: helper-name call without ANY approved import is caught (renamed-source evasion)', () => {
    const src = [
      "import { loadDotEnvIntoProcessEnv } from './my-own-env-helper';",
      "loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));",
    ].join('\n');
    const cls = classifyEnvLoaderSource(src);
    expect(cls.isLoader).toBe(true);
    expect(cls.safe).toBe(false);
    expect(cls.violation).toBe('helper_name_called_without_approved_import');
  });

  it('UNSAFE: dotenv npm module import is caught (config() does not exclude the auth key)', () => {
    const src = [
      "import dotenv from 'dotenv';",
      "dotenv.config();",
    ].join('\n');
    const cls = classifyEnvLoaderSource(src);
    expect(cls.isLoader).toBe(true);
    expect(cls.safe).toBe(false);
    expect(cls.violation).toBe('dotenv_npm_module_config_does_not_exclude_edge_execution_auth');
  });

  it('SAFE: the approved import from ../packages/risk/src/dotenv-safety.ts passes', () => {
    const src = [
      "import { readFileSync } from 'node:fs';",
      "import { resolve } from 'node:path';",
      "import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';",
      "const REPO_ROOT = resolve(__dirname, '..');",
      "loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));",
    ].join('\n');
    const cls = classifyEnvLoaderSource(src);
    expect(cls.isLoader).toBe(true);
    expect(cls.safe).toBe(true);
    expect(cls.violation).toBeUndefined();
  });

  it('SAFE: the approved import from the @edge/risk package export passes', () => {
    const src = [
      "import { loadDotEnvIntoProcessEnv } from '@edge/risk';",
      "loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));",
    ].join('\n');
    const cls = classifyEnvLoaderSource(src);
    expect(cls.isLoader).toBe(true);
    expect(cls.safe).toBe(true);
  });

  it('SAFE: inline read WITH the EDGE_EXECUTION_AUTH manual exclusion passes (the 5 legacy safe loaders)', () => {
    const src = [
      "import { readFileSync } from 'node:fs';",
      "try {",
      "  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');",
      "  for (const line of env.split('\\n')) {",
      "    const m = line.match(/^\\\\s*([A-Z_][A-Z0-9_]*)\\\\s*=\\\\s*(.*)\\\\s*$/);",
      "    if (!m) continue;",
      "    const [, k, v] = m;",
      "    if (k === 'EDGE_EXECUTION_AUTH') continue;",
      "    if (!process.env[k]) process.env[k] = v;",
      "  }",
      "} catch {}",
    ].join('\n');
    const cls = classifyEnvLoaderSource(src);
    expect(cls.isLoader).toBe(true);
    expect(cls.safe).toBe(true);
  });

  it('SAFE: a file with no .env reference at all is not a loader', () => {
    const src = "console.log('hello');\n";
    const cls = classifyEnvLoaderSource(src);
    expect(cls.isLoader).toBe(false);
    expect(cls.safe).toBe(true);
  });
});

// ─── Section 2: Synthetic runtime fixtures — .env cannot arm the guard ──

describe('EM-STRAT-014-C — synthetic runtime fixtures: helper excludes EDGE_EXECUTION_AUTH', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(process.cwd(), '.tmp-env-loader-test-' + process.pid + '-' + Date.now());
    mkdirSync(tempDir, { recursive: true });
    delete process.env[EXECUTION_AUTH_ENV_VAR];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env[EXECUTION_AUTH_ENV_VAR];
    delete process.env.SYNTHETIC_API_KEY;
    delete process.env.SYNTHETIC_RPC_URL;
    delete process.env.SYNTHETIC_TOKEN;
  });

  it('EDGE_EXECUTION_AUTH in .env is NOT copied to process.env (the helper excludes it)', () => {
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

    loadDotEnvIntoProcessEnv(envPath);

    expect(process.env.SYNTHETIC_API_KEY).toBe('test-key-12345');
    expect(process.env.SYNTHETIC_RPC_URL).toBe('https://synthetic.example.com');
    expect(process.env.SYNTHETIC_TOKEN).toBe('abc123');
    expect(process.env[EXECUTION_AUTH_ENV_VAR]).toBeUndefined();
  });

  it('parseDotEnvContents excludes EDGE_EXECUTION_AUTH from the returned record', () => {
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

    expect(parsed.SYNTHETIC_API_KEY).toBe('parser-test-key');
    expect(parsed.SYNTHETIC_TOKEN).toBe('parser-test-token');
    expect(parsed[EXECUTION_AUTH_ENV_VAR]).toBeUndefined();
    expect(Object.keys(parsed)).not.toContain(EXECUTION_AUTH_ENV_VAR);
  });

  it('DOTENV_EXCLUDED_KEYS contains EDGE_EXECUTION_AUTH', () => {
    expect(DOTENV_EXCLUDED_KEYS.has(EXECUTION_AUTH_ENV_VAR)).toBe(true);
    expect(DOTENV_EXCLUDED_KEYS.size).toBeGreaterThanOrEqual(1);
  });

  it('parent-process EDGE_EXECUTION_AUTH is NOT overwritten by .env (parent wins)', () => {
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

    expect(process.env[EXECUTION_AUTH_ENV_VAR]).toBe(parentDescriptor);
    expect(process.env.SYNTHETIC_API_KEY).toBe('parent-wins-test');
  });

  it('missing .env file is a no-op (no throw, no mutation)', () => {
    const missingPath = join(tempDir, 'does-not-exist.env');
    expect(() => loadDotEnvIntoProcessEnv(missingPath)).not.toThrow();
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

    loadDotEnvIntoProcessEnv(envPath);

    expect(process.env.SYNTHETIC_GUARD_TEST_KEY).toBe('loaded');
    expect(process.env[EXECUTION_AUTH_ENV_VAR]).toBeUndefined();

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
