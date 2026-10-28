import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import ts from 'typescript';
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
// either (a) call the shared loadDotEnvIntoProcessEnv helper whose IMPORTED
// SYMBOL is exactly that export of an APPROVED module (packages/risk/src/
// dotenv-safety.ts / @edge/risk), or (b) carry a PROVEN ACTIVE manual
// exclusion of EDGE_EXECUTION_AUTH.
//
// EM-STRAT-014-C-R1 — HARDENED ADVERSARIAL DETECTION:
//   - Detection broadened beyond readFileSync(resolve(REPO_ROOT, '.env')):
//     join(...), __dirname, any root name, both quotes, wrapped helpers,
//     dotenv npm imports.
//
// EM-STRAT-014-C-R2 — PROOF-BASED CLASSIFICATION (TypeScript AST):
//   The `typescript` package is already a devDependency of this package;
//   no new dependency is added. Two proven R1 false-negative paths are
//   closed:
//
//   1. A bare mention of EDGE_EXECUTION_AUTH is NOT proof of exclusion
//      (R1 accepted any occurrence — a log, a stale comment, an unrelated
//      branch, or dead code counted as "safe"). The classifier now
//      requires an ACTIVE GUARD tied to the loader's key variable: an
//      `if` statement comparing some identifier K to the literal
//      'EDGE_EXECUTION_AUTH' (===/==, either operand order) whose taken
//      branch contains `continue` or `return`, where the SAME identifier
//      K is used as the KEY of a `process.env[K] = ...` (or ??=/||=)
//      assignment. Anything the recognizer cannot prove is UNSAFE.
//   2. The approved-import check now proves IMPORTED SYMBOL IDENTITY, not
//      alias text: the named import's propertyName must be exactly
//      `loadDotEnvIntoProcessEnv` from an approved module specifier.
//      `import { unrelatedFn as loadDotEnvIntoProcessEnv } from
//      '@edge/risk'` is rejected (helper_imported_symbol_not_approved).
//
// KNOWN LIMITS OF STATIC ANALYSIS (declared, per the work orders):
//   - Still not a proof of arbitrary program semantics. The identifier tie
//     between guard and assignment is name-based, not full dataflow (two
//     same-named variables in unrelated scopes could in principle defeat
//     it — deliberate evasion is out of scope for an accident-prevention
//     control). require()-based dynamic loading, re-export indirection,
//     and reads routed through a non-fs helper module are not resolved.
//     Guard styles other than continue/return fail closed.
//   - Comment and string content are invisible to the AST walk (R1's
//     line-based comment stripper is gone — comments can never make a
//     loader safe anymore).
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

// ─── EM-STRAT-014-C-R2: AST-based classifier (the EXACT logic CI runs) ──
//
// Pure functions over source text so the adversarial synthetic fixtures
// exercise the same logic as the live tree scan (execution-sink-census
// pattern).

const AUTH_KEY_LITERAL = 'EDGE_EXECUTION_AUTH';
const HELPER_NAME = 'loadDotEnvIntoProcessEnv';

/** The ONLY module specifiers the shared helper may be imported from. */
export function isApprovedModuleSpecifier(spec: string): boolean {
  return (
    spec === '@edge/risk' ||
    /^@edge\/risk\/[a-z-]+$/.test(spec) ||
    /^(?:\.\.?\/)+packages\/risk\/src\/dotenv-safety\.(?:ts|js)$/.test(spec)
  );
}

function isDotenvModuleSpecifier(spec: string): boolean {
  return /^dotenv(?:\/[a-z-]+)?$/.test(spec);
}

export interface ImportFact {
  /** Local binding name in the file. */
  localName: string;
  /** The symbol name AS EXPORTED by the module (propertyName when aliased). */
  importedName: string;
  module: string;
}

export interface EnvLoaderFacts {
  /** Any call receiving a '.env' string literal, any helper-name call, or any dotenv import. */
  isLoader: boolean;
  /** Calls whose callee is LITERALLY named loadDotEnvIntoProcessEnv. */
  helperNameCallCount: number;
  /** True when a call resolves to the helper through an import binding (direct or deliberately aliased). */
  hasHelperCall: boolean;
  /** readFileSync/readFile (plain or property-named) receiving a '.env' literal. */
  fsReadEnvLiteralCallCount: number;
  /** ANY call receiving a '.env' literal anywhere in its argument subtree. */
  envArgCallCount: number;
  imports: ImportFact[];
  dotenvImport: boolean;
  /** Locally declared function/const/let/var named loadDotEnvIntoProcessEnv. */
  localHelperDef: boolean;
  /** Identifiers K used as the KEY of a process.env[K] = ... (or ??=/||=) assignment. */
  envAssignKeyIds: Set<string>;
  /** Identifiers K guarded by `if (K === 'EDGE_EXECUTION_AUTH') <continue|return>`. */
  activeGuardKeyIds: Set<string>;
  /** All plain-identifier callee names observed (for import-binding resolution). */
  callCalleeNames: Set<string>;
}

function containsEnvLiteral(root: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isStringLiteral(n) && n.text === '.env') {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return found;
}

function subtreeHasContinueOrReturn(root: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isContinueStatement(n) || ts.isReturnStatement(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return found;
}

/** Collect the structural facts the classifier needs (one AST walk). */
export function collectEnvLoaderFacts(src: string): EnvLoaderFacts {
  const sf = ts.createSourceFile('census-target.mts', src, ts.ScriptTarget.ES2022, /* setParentNodes */ true, ts.ScriptKind.TS);
  const facts: EnvLoaderFacts = {
    isLoader: false,
    helperNameCallCount: 0,
    hasHelperCall: false,
    fsReadEnvLiteralCallCount: 0,
    envArgCallCount: 0,
    imports: [],
    dotenvImport: false,
    localHelperDef: false,
    envAssignKeyIds: new Set(),
    activeGuardKeyIds: new Set(),
    callCalleeNames: new Set(),
  };

  const visit = (node: ts.Node): void => {
    // Imports (ESM): record every named binding with its EXPORTED name.
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const mod = node.moduleSpecifier.text;
      if (isDotenvModuleSpecifier(mod)) facts.dotenvImport = true;
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          facts.imports.push({ localName: el.name.text, importedName: (el.propertyName ?? el.name).text, module: mod });
        }
      }
    }
    // require('dotenv') form.
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      isDotenvModuleSpecifier(node.arguments[0].text)
    ) {
      facts.dotenvImport = true;
    }
    // Calls: helper-name calls and '.env'-receiving calls (deep argument
    // search — multiline and nested-call shapes the R1 regex missed).
    if (ts.isCallExpression(node)) {
      const calleeName = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : null;
      if (calleeName !== null) facts.callCalleeNames.add(calleeName);
      if (calleeName === HELPER_NAME) facts.helperNameCallCount++;
      if (node.arguments.some(containsEnvLiteral)) {
        facts.envArgCallCount++;
        if (calleeName === 'readFileSync' || calleeName === 'readFile') facts.fsReadEnvLiteralCallCount++;
      }
    }
    // Local lookalike helper definitions.
    if (ts.isFunctionDeclaration(node) && node.name?.text === HELPER_NAME) facts.localHelperDef = true;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === HELPER_NAME) facts.localHelperDef = true;
    // process.env[K] assignments (K must be a plain identifier).
    if (ts.isAssignmentExpression(node) && ts.isElementAccessExpression(node.left)) {
      const target = node.left;
      if (
        ts.isPropertyAccessExpression(target.expression) &&
        ts.isIdentifier(target.expression.expression) &&
        target.expression.expression.text === 'process' &&
        target.expression.name.text === 'env' &&
        ts.isIdentifier(target.argumentExpression)
      ) {
        facts.envAssignKeyIds.add(target.argumentExpression.text);
      }
    }
    // Active exclusion guards: if (K === 'EDGE_EXECUTION_AUTH') { continue|return }.
    // NOTE: TypeScript's IfStatement node names its condition property
    // `expression` (historical API), not `condition`.
    if (ts.isIfStatement(node) && ts.isBinaryExpression(node.expression)) {
      const op = node.expression.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
        const { left, right } = node.expression;
        const idSide = ts.isIdentifier(left) ? left : ts.isIdentifier(right) ? right : null;
        const litSide = ts.isStringLiteral(left) ? left : ts.isStringLiteral(right) ? right : null;
        if (idSide && litSide && litSide.text === AUTH_KEY_LITERAL && subtreeHasContinueOrReturn(node.thenStatement)) {
          facts.activeGuardKeyIds.add(idSide.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // A helper call is EITHER a call literally named loadDotEnvIntoProcessEnv
  // OR a call through a deliberate local alias whose IMPORTED SYMBOL is the
  // helper (identity, not alias text — R2).
  const helperBindings = facts.imports.filter(i => i.importedName === HELPER_NAME);
  facts.hasHelperCall =
    facts.helperNameCallCount > 0 ||
    [...facts.callCalleeNames].some(
      n => n !== HELPER_NAME && helperBindings.some(b => b.localName === n),
    );

  facts.isLoader =
    facts.dotenvImport || facts.hasHelperCall || facts.envArgCallCount > 0;
  return facts;
}

export interface EnvLoaderClassification {
  isLoader: boolean;
  safe: boolean;
  /** True when the loader was proven safe via an ACTIVE manual-exclusion guard. */
  manualExclusion?: boolean;
  /** Why the loader is unsafe (only when isLoader && !safe). */
  violation?: string;
}

/** Classify one source file's `.env`-loader posture (the census invariant). */
export function classifyEnvLoaderSource(src: string): EnvLoaderClassification {
  const facts = collectEnvLoaderFacts(src);
  if (!facts.isLoader) return { isLoader: false, safe: true };

  if (facts.localHelperDef) {
    return { isLoader: true, safe: false, violation: 'local_lookalike_helper_definition' };
  }
  if (facts.dotenvImport) {
    return { isLoader: true, safe: false, violation: 'dotenv_npm_module_config_does_not_exclude_edge_execution_auth' };
  }

  // R2: manual exclusion must be PROVEN — an active continue/return guard
  // on the literal, tied to the SAME identifier used as a process.env key.
  // A bare mention (log/comment/unrelated branch/dead check) never proves.
  const hasActiveExclusion =
    facts.activeGuardKeyIds.size > 0 &&
    [...facts.activeGuardKeyIds].some(k => facts.envAssignKeyIds.has(k));

  // Inline fs reads of .env are only safe behind a proven active guard.
  if (facts.fsReadEnvLiteralCallCount > 0 && !hasActiveExclusion) {
    return { isLoader: true, safe: false, violation: 'inline_env_file_read_without_edge_execution_auth_exclusion' };
  }

  // R2: helper calls resolve to the IMPORTED SYMBOL, not the alias text —
  // both for direct-name calls and for deliberately aliased calls.
  if (facts.hasHelperCall) {
    const helperBindings = facts.imports.filter(i => i.importedName === HELPER_NAME);
    const approvedUsed =
      // direct-name call bound to the approved export
      (facts.helperNameCallCount > 0 &&
        helperBindings.some(b => b.localName === HELPER_NAME && isApprovedModuleSpecifier(b.module))) ||
      // deliberately aliased call bound to the approved export
      helperBindings.some(
        b => b.localName !== HELPER_NAME &&
          isApprovedModuleSpecifier(b.module) &&
          facts.callCalleeNames.has(b.localName),
      );
    if (!approvedUsed) {
      const masquerade =
        facts.imports.some(i => i.localName === HELPER_NAME && i.importedName !== HELPER_NAME);
      return {
        isLoader: true,
        safe: false,
        violation: masquerade ? 'helper_imported_symbol_not_approved' : 'helper_name_called_without_approved_import',
      };
    }
  }

  return { isLoader: true, safe: true, manualExclusion: hasActiveExclusion };
}

// ─── Section 1: Glob-based census invariant ─────────────────────────────

describe('EM-STRAT-014-C — .env loader hygiene census (glob-based, no allowlist)', () => {
  const allFiles = collectExecutableMtsFiles(SCRIPTS_EXPLORE_DIR);

  it('scan discovered executable .mts files in scripts-explore/ (sanity)', () => {
    expect(allFiles.length).toBeGreaterThan(100);
  });

  it('every .env loader uses the approved imported helper OR a PROVEN active exclusion guard', () => {
    const violations: string[] = [];
    const helperLoaders: string[] = [];
    const safeManualLoaders: string[] = [];

    for (const filepath of allFiles) {
      const rel = relative(REPO_ROOT, filepath);
      const src = readFileSync(filepath, 'utf8');
      const cls = classifyEnvLoaderSource(src);
      if (!cls.isLoader) continue;
      if (cls.safe) {
        if (cls.manualExclusion) safeManualLoaders.push(rel);
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

    // R2: the manual-exclusion classification must be a PROOF (active
    // guard), not a keyword search — every safe manual loader's source
    // must contain the structural guard the recognizer requires.
    for (const filepath of allFiles) {
      const src = readFileSync(filepath, 'utf8');
      const facts = collectEnvLoaderFacts(src);
      if (!facts.isLoader || facts.helperNameCallCount > 0) continue;
      const proven = [...facts.activeGuardKeyIds].some(k => facts.envAssignKeyIds.has(k));
      expect(proven, `${relative(REPO_ROOT, filepath)} classified as manual-exclusion must have an active guard tied to its process.env key`).toBe(true);
    }
  });

  it('helper loaders import the APPROVED SYMBOL from the APPROVED module (R2: identity, not alias text)', () => {
    for (const filepath of allFiles) {
      const src = readFileSync(filepath, 'utf8');
      const facts = collectEnvLoaderFacts(src);
      if (!facts.hasHelperCall) continue;
      const rel = relative(REPO_ROOT, filepath);
      const cls = classifyEnvLoaderSource(src);
      expect(cls.safe, `${rel}: ${cls.violation ?? 'unexpectedly unsafe'}`).toBe(true);
      expect(cls.manualExclusion, `${rel} must use the approved import, not a manual guard`).toBe(false);
      // The imported symbol itself must be the approved export — a local
      // alias of an unrelated function does NOT satisfy this.
      const approvedBinding = facts.imports.some(
        i => i.importedName === HELPER_NAME && isApprovedModuleSpecifier(i.module),
      );
      expect(
        approvedBinding,
        `${rel} must import loadDotEnvIntoProcessEnv (exact exported symbol) from @edge/risk or ../packages/risk/src/dotenv-safety.{ts,js}`,
      ).toBe(true);
      expect(facts.localHelperDef, `${rel} must not define a local lookalike helper`).toBe(false);
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

// ─── Section 1b: Adversarial synthetic source fixtures (C-R1 + C-R2) ────

describe('EM-STRAT-014-C-R2 — adversarial synthetic source fixtures (the exact CI classifier)', () => {
  it('UNSAFE (R2 mandated): loader that LOGS the auth key but does not skip its assignment', () => {
    const src = [
      "import { readFileSync } from 'node:fs';",
      "import { resolve } from 'node:path';",
      "const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');",
      "for (const line of env.split('\\n')) {",
      "  const m = line.match(/^\\\\s*([A-Z_][A-Z0-9_]*)\\\\s*=\\\\s*(.*)\\\\s*$/);",
      "  if (!m) continue;",
      "  const [, k, v] = m;",
      "  if (k === 'EDGE_EXECUTION_AUTH') console.log('saw auth key', k); // mention, NO skip",
      "  if (!process.env[k]) process.env[k] = v;",
      "}",
    ].join('\n');
    const cls = classifyEnvLoaderSource(src);
    expect(cls.isLoader).toBe(true);
    expect(cls.safe).toBe(false);
    expect(cls.violation).toBe('inline_env_file_read_without_edge_execution_auth_exclusion');
  });

  it('UNSAFE (R2 mandated): stale COMMENT mentioning the key cannot make a loader safe', () => {
    // Comments are invisible to the AST walk — the R1 keyword search could
    // be satisfied by a comment; R2 cannot.
    const src = [
      "import { readFileSync } from 'node:fs';",
      "// NOTE: EDGE_EXECUTION_AUTH is excluded here (stale comment — it is not).",
      "const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');",
      "for (const line of env.split('\\n')) {",
      "  const m = line.match(/^\\\\s*([A-Z_][A-Z0-9_]*)\\\\s*=\\\\s*(.*)\\\\s*$/);",
      "  if (!m) continue;",
      "  const [, k, v] = m;",
      "  if (!process.env[k]) process.env[k] = v; // copies EVERY key incl. the auth descriptor",
      "}",
    ].join('\n');
    const cls = classifyEnvLoaderSource(src);
    expect(cls.isLoader).toBe(true);
    expect(cls.safe).toBe(false);
    expect(cls.violation).toBe('inline_env_file_read_without_edge_execution_auth_exclusion');
  });

  it('UNSAFE: guard checks a DIFFERENT literal (related key name) and skips — not proof for the auth key', () => {
    const src = [
      "import { readFileSync } from 'node:fs';",
      "const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');",
      "for (const line of env.split('\\n')) {",
      "  const m = line.match(/^\\\\s*([A-Z_][A-Z0-9_]*)\\\\s*=\\\\s*(.*)\\\\s*$/);",
      "  if (!m) continue;",
      "  const [, k, v] = m;",
      "  if (k === 'EDGE_EXECUTION_AUTH_TIMEOUT') continue; // wrong key!",
      "  if (!process.env[k]) process.env[k] = v;",
      "}",
    ].join('\n');
    const cls = classifyEnvLoaderSource(src);
    expect(cls.isLoader).toBe(true);
    expect(cls.safe).toBe(false);
    expect(cls.violation).toBe('inline_env_file_read_without_edge_execution_auth_exclusion');
  });

  it('UNSAFE: guard on the right key but body only logs (no continue/return) — not an active exclusion', () => {
    const src = [
      "import { readFileSync } from 'node:fs';",
      "const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');",
      "for (const line of env.split('\\n')) {",
      "  const m = line.match(/^\\\\s*([A-Z_][A-Z0-9_]*)\\\\s*=\\\\s*(.*)\\\\s*$/);",
      "  if (!m) continue;",
      "  const [, k, v] = m;",
      "  if (k === 'EDGE_EXECUTION_AUTH') { console.warn('refusing?'); } // no skip",
      "  if (!process.env[k]) process.env[k] = v;",
      "}",
    ].join('\n');
    const cls = classifyEnvLoaderSource(src);
    expect(cls.safe).toBe(false);
    expect(cls.violation).toBe('inline_env_file_read_without_edge_execution_auth_exclusion');
  });

  it('UNSAFE (R2 mandated): guard and assignment use DIFFERENT identifiers — tie not proven', () => {
    const src = [
      "import { readFileSync } from 'node:fs';",
      "const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');",
      "for (const line of env.split('\\n')) {",
      "  const m = line.match(/^\\\\s*([A-Z_][A-Z0-9_]*)\\\\s*=\\\\s*(.*)\\\\s*$/);",
      "  if (!m) continue;",
      "  const [, key, v] = m;",
      "  if (key === 'EDGE_EXECUTION_AUTH') continue; // guards `key`",
      "  if (!process.env[k]) process.env[k] = v;     // assigns `k` (unrelated)",
      "}",
    ].join('\n');
    const cls = classifyEnvLoaderSource(src);
    expect(cls.safe).toBe(false);
    expect(cls.violation).toBe('inline_env_file_read_without_edge_execution_auth_exclusion');
  });

  it('UNSAFE (R2 mandated): aliased import — an UNRELATED symbol renamed to the helper name — is rejected', () => {
    const src = [
      "import { unrelatedFunction as loadDotEnvIntoProcessEnv } from '@edge/risk';",
      "loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));",
    ].join('\n');
    const cls = classifyEnvLoaderSource(src);
    expect(cls.isLoader).toBe(true);
    expect(cls.safe).toBe(false);
    expect(cls.violation).toBe('helper_imported_symbol_not_approved');
  });

  it('UNSAFE: deliberately ALIASED call but the MODULE is not approved — the alias does not launder the source', () => {
    const src = [
      "import { loadDotEnvIntoProcessEnv as loadEnv } from './my-own-env-helper';",
      "loadEnv(resolve(REPO_ROOT, '.env'));",
    ].join('\n');
    const cls = classifyEnvLoaderSource(src);
    expect(cls.isLoader).toBe(true);
    expect(cls.safe).toBe(false);
    expect(cls.violation).toBe('helper_name_called_without_approved_import');
  });

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

  it('UNSAFE: multiline readFileSync argument with a nested call is STILL caught (R1 regex limit closed)', () => {
    const src = [
      "import { readFileSync } from 'node:fs';",
      "import { resolve } from 'node:path';",
      "const env = readFileSync(",
      "  getBase(),",
      "  resolve(getBase(), '.env'),",
      "  'utf8',",
      ");",
      "for (const line of env.split('\\n')) { const [k, v] = line.split('='); if (k && v && !process.env[k]) process.env[k] = v; }",
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

  it('SAFE: a deliberately ALIASED import of the REAL approved export passes (identity, not alias text)', () => {
    // R2 validates the IMPORTED SYMBOL (propertyName), so a deliberate local
    // rename of the genuine export is still provably the approved helper.
    const src = [
      "import { loadDotEnvIntoProcessEnv as loadEnv } from '@edge/risk';",
      "loadEnv(resolve(REPO_ROOT, '.env'));",
    ].join('\n');
    const cls = classifyEnvLoaderSource(src);
    expect(cls.isLoader).toBe(true);
    expect(cls.safe).toBe(true);
  });

  it('SAFE: inline read WITH the active exclusion guard passes (the 5 legacy safe loaders, exact shape)', () => {
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
    expect(cls.manualExclusion).toBe(true);
  });

  it('SAFE: guard in block-brace form and guard via return (wrapped in a function) both pass', () => {
    const blockForm = [
      "import { readFileSync } from 'node:fs';",
      "const env = readFileSync(resolve(ROOT, '.env'), 'utf8');",
      "for (const line of env.split('\\n')) {",
      "  const m = line.match(/^\\\\s*([A-Z_][A-Z0-9_]*)\\\\s*=\\\\s*(.*)\\\\s*$/);",
      "  if (!m) continue;",
      "  const [, k, v] = m;",
      "  if (k === 'EDGE_EXECUTION_AUTH') { continue; }",
      "  if (!process.env[k]) process.env[k] = v;",
      "}",
    ].join('\n');
    expect(classifyEnvLoaderSource(blockForm).safe).toBe(true);

    const returnForm = [
      "import { readFileSync } from 'node:fs';",
      "export function applyEnv(): void {",
      "  const env = readFileSync(resolve(ROOT, '.env'), 'utf8');",
      "  for (const line of env.split('\\n')) {",
      "    const m = line.match(/^\\\\s*([A-Z_][A-Z0-9_]*)\\\\s*=\\\\s*(.*)\\\\s*$/);",
      "    if (!m) continue;",
      "    const [, k, v] = m;",
      "    if (k === 'EDGE_EXECUTION_AUTH') return;",
      "    if (!process.env[k]) process.env[k] = v;",
      "  }",
      "}",
    ].join('\n');
    expect(classifyEnvLoaderSource(returnForm).safe).toBe(true);
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

// ─── Section 4: EM-STRAT-014-C-R3 — generated SDK example hygiene ───────
//
// The #15 codemod correctly added a real top-level
// `loadDotEnvIntoProcessEnv` import and call to
// `scripts-explore/builder-code-sdk.mts` (those satisfy the loader census
// above). It also accidentally inserted the SAME helper import inside the
// template literal returned by `generateSdkCode()`. That line is emitted as
// TEXT into the SDK example shown to consumers — a developer who copied the
// example would inherit an Edge-Engine repository-relative dependency that
// does not exist in any normal external project. R3 removes the accidental
// template-literal line while preserving the real top-level loader.
//
// This test reads the source OFFLINE (no execution of `builder-code-sdk.mts`,
// no access to any real `.env`) and uses TypeScript AST to extract the
// template literal returned by `generateSdkCode()`, then asserts:
//   1. The emitted SDK example contains neither `loadDotEnvIntoProcessEnv`
//      nor `../packages/risk/src/dotenv-safety`.
//   2. The source file still retains the legitimate top-level approved
//      import (identity, not alias text) and the top-level helper call —
//      i.e. the R3 cleanup did not silently remove the real loader.

describe('EM-STRAT-014-C-R3 — generated SDK example carries no repository-internal helper import', () => {
  const BUILDER_SDK_PATH = resolve(SCRIPTS_EXPLORE_DIR, 'builder-code-sdk.mts');

  /**
   * Walk a TypeScript AST and return the concatenated text of the FIRST
   * template literal returned by a function named `generateSdkCode()`.
   * Returns `null` if no such function-or-method declaration with a
   * returned template literal is found.
   */
  function extractGenerateSdkCodeTemplate(src: string): string | null {
    const sf = ts.createSourceFile(
      'builder-code-sdk.mts',
      src,
      ts.ScriptTarget.ES2022,
      /* setParentNodes */ true,
      ts.ScriptKind.TS,
    );
    let extracted: string | null = null;
    const visit = (node: ts.Node): void => {
      if (extracted !== null) return;
      // Function declaration: `function generateSdkCode(): string { return \`...\`; }`
      if (
        ts.isFunctionDeclaration(node) &&
        node.name?.text === 'generateSdkCode'
      ) {
        const found = findFirstReturnedTemplateLiteral(node);
        if (found !== null) extracted = found;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return extracted;
  }

  function findFirstReturnedTemplateLiteral(scope: ts.Node): string | null {
    let found: string | null = null;
    const walk = (n: ts.Node): void => {
      if (found !== null) return;
      // return <TemplateLiteral>;
      if (ts.isReturnStatement(n) && n.expression) {
        const expr = n.expression;
        if (ts.isTemplateExpression(expr)) {
          // Template with ${...} spans.
          found = templateLiteralFullText(expr);
          return;
        }
        if (ts.isNoSubstitutionTemplateLiteral(expr)) {
          // Plain template literal with no interpolations — TS exposes the
          // raw inner text via `text` (the surrounding backticks are NOT
          // part of `text`).
          found = expr.text;
          return;
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(scope);
    return found;
  }

  /** Concatenate head + each middle + each span's text into a single string. */
  function templateLiteralFullText(node: ts.TemplateExpression): string {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      out += span.expression.getText();
      out += span.literal.text;
    }
    return out;
  }

  it('reads the source offline (file exists; no execution)', () => {
    // Sanity: the source file is present at the expected path so the
    // assertions below are exercising the real R3 target.
    expect(existsSync(BUILDER_SDK_PATH)).toBe(true);
    const src = readFileSync(BUILDER_SDK_PATH, 'utf8');
    // The source must declare a generateSdkCode function — otherwise the
    // R3 regression test would silently pass against a refactored file.
    expect(src).toMatch(/function\s+generateSdkCode\s*\(/);
  });

  it('AST-extracts the generateSdkCode() template (test harness sanity)', () => {
    const src = readFileSync(BUILDER_SDK_PATH, 'utf8');
    const tpl = extractGenerateSdkCodeTemplate(src);
    expect(tpl, 'generateSdkCode() must return a template literal so R3 can inspect emitted text').not.toBeNull();
    // The generated example must still carry its intended public import —
    // otherwise the cleanup went too far and stripped the real SDK API.
    expect(tpl!).toContain("import { getBuilderField } from '@edge/builder-sdk'");
  });

  it('R3 mandated: emitted SDK example does NOT contain the helper import statement', () => {
    const src = readFileSync(BUILDER_SDK_PATH, 'utf8');
    const tpl = extractGenerateSdkCodeTemplate(src);
    expect(tpl).not.toBeNull();
    // The exact line the codemod accidentally inserted inside the template:
    expect(tpl!).not.toContain('loadDotEnvIntoProcessEnv');
  });

  it('R3 mandated: emitted SDK example does NOT reference the repository-internal dotenv-safety path', () => {
    const src = readFileSync(BUILDER_SDK_PATH, 'utf8');
    const tpl = extractGenerateSdkCodeTemplate(src);
    expect(tpl).not.toBeNull();
    expect(tpl!).not.toContain('../packages/risk/src/dotenv-safety');
  });

  it('source retains the legitimate top-level approved import (identity, not alias text)', () => {
    const src = readFileSync(BUILDER_SDK_PATH, 'utf8');
    const facts = collectEnvLoaderFacts(src);
    const approvedBinding = facts.imports.some(
      i => i.importedName === HELPER_NAME && isApprovedModuleSpecifier(i.module),
    );
    expect(
      approvedBinding,
      'builder-code-sdk.mts must keep its real top-level import of loadDotEnvIntoProcessEnv from @edge/risk or ../packages/risk/src/dotenv-safety.{ts,js}',
    ).toBe(true);
  });

  it('source retains the legitimate top-level helper call (the loader census must still see it)', () => {
    const src = readFileSync(BUILDER_SDK_PATH, 'utf8');
    const facts = collectEnvLoaderFacts(src);
    expect(facts.hasHelperCall, 'top-level loadDotEnvIntoProcessEnv(...) call must remain').toBe(true);
    expect(facts.helperNameCallCount).toBeGreaterThanOrEqual(1);
    // And the file is still classified as a SAFE loader by the R2 classifier.
    const cls = classifyEnvLoaderSource(src);
    expect(cls.safe, `builder-code-sdk.mts must remain a safe loader: ${cls.violation ?? ''}`).toBe(true);
  });

  it('regression guard: a synthetic source that RE-INSERTS the helper import into the template literal fails R3', () => {
    // Construct a deliberately-broken source by re-adding the exact line
    // into the template literal of a minimal generateSdkCode() — this
    // proves the R3 assertions above would catch a reintroduction.
    const brokenSrc = [
      "import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';",
      'loadDotEnvIntoProcessEnv("/dev/null");',
      'function generateSdkCode(): string {',
      "  return `import { getBuilderField } from '@edge/builder-sdk';",
      "import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';",
      'const order = {};',
      '`;',
      '}',
    ].join('\n');
    const tpl = extractGenerateSdkCodeTemplate(brokenSrc);
    expect(tpl).not.toBeNull();
    expect(tpl!).toContain('loadDotEnvIntoProcessEnv');
    expect(tpl!).toContain('../packages/risk/src/dotenv-safety');
  });
});
