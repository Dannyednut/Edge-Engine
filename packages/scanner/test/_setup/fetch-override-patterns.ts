/**
 * Fetch-override detection patterns and runtime guard-assertion helpers
 * for the EM-STRAT-008/009/010 static and runtime regression checks.
 *
 * EM-STRAT-009 §2: this file is scanned by the static checker alongside
 * every other .ts file under packages/scanner/test/. The regex literals
 * below do NOT contain the literal override syntax as plain text (the
 * backslash-escaped metacharacters prevent the scanner patterns from
 * matching this file's own source). Comments use abstract descriptions
 * only — no literal override syntax in prose.
 *
 * The ONLY file exempted from the static scan is the guard setup file
 * (_setup/offline-guard.ts), which legitimately installs the wrapped
 * fail-closed fetch.
 *
 * EM-STRAT-010 §1: the assertion helper imports the exact guard error
 * signature (OFFLINE_GUARD_ERROR_SIGNATURE) from the guard setup file.
 * This ensures the helper matches the specific stable error format
 * produced by the installed guard — NOT a loose /offline guard/i
 * substring. A substituted fetch that rejects with a generic message
 * containing "offline guard" but lacking the actual guard signature
 * will FAIL the assertion.
 */

import { OFFLINE_GUARD_ERROR_SIGNATURE } from './offline-guard.js';

// ─── Types ────────────────────────────────────────────────────────────

export interface FetchOverridePattern {
  /** Numeric ID for violation reporting (does not contain literal pattern text). */
  id: string;
  /** Abstract description (does not contain literal override syntax). */
  description: string;
  /** Regex that matches the override form in source text. */
  pattern: RegExp;
}

export interface FetchOverrideViolation {
  /** Relative path of the file that contained the violation. */
  file: string;
  /** Pattern ID that matched. */
  patternId: string;
  /** 1-based line number. */
  line: number;
  /** The source text of the offending line (trimmed). */
  source: string;
}

// ─── Detection patterns ───────────────────────────────────────────────
//
// Each pattern matches a common form of global-fetch reassignment, stubbing,
// or property redefinition in source text. The regex source text uses
// backslash-escaped metacharacters so the scanner does not self-trigger
// on this file.

export const FETCH_OVERRIDE_PATTERNS: FetchOverridePattern[] = [
  {
    id: 'P1',
    description: 'direct assignment to the global fetch property via the globalThis object',
    pattern: /globalThis\s*\.\s*fetch\s*=/,
  },
  {
    id: 'P2',
    description: 'direct assignment to the global fetch property via the global object',
    pattern: /\bglobal\s*\.\s*fetch\s*=/,
  },
  {
    id: 'P3',
    description: 'vitest stubGlobal call targeting the fetch property',
    pattern: /vi\s*\.\s*stubGlobal\s*\(\s*['"]fetch['"]\s*,/i,
  },
  {
    id: 'P4',
    description: 'defineProperty on the globalThis object targeting the fetch property',
    pattern: /Object\s*\.\s*defineProperty\s*\(\s*globalThis\s*,\s*['"]fetch['"]\s*,/i,
  },
  {
    id: 'P5',
    description: 'defineProperty on the global object targeting the fetch property',
    pattern: /Object\s*\.\s*defineProperty\s*\(\s*global\s*,\s*['"]fetch['"]\s*,/i,
  },
  {
    id: 'P6',
    description: 'defineProperty on any object targeting the fetch property',
    pattern: /Object\s*\.\s*defineProperty\s*\([^,]+,\s*['"]fetch['"]\s*,/i,
  },
  {
    id: 'P7',
    description: 'Reflect.defineProperty on any object targeting the fetch property',
    pattern: /Reflect\s*\.\s*defineProperty\s*\([^,]+,\s*['"]fetch['"]\s*,/i,
  },
];

/**
 * The ONLY file allowed to assign the global fetch property. This is the
 * guard setup file that installs the fail-closed wrapped fetch.
 */
export const GUARD_SETUP_FILE = '_setup/offline-guard.ts';

// ─── Static scanner ───────────────────────────────────────────────────

/**
 * Recursively scan a directory for .ts files.
 */
function scanTsFiles(dir: string, fs: any, path: any): string[] {
  const results: string[] = [];
  function walk(d: string) {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name.endsWith('.ts')) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

/**
 * Scan all .ts files under `testDir` for fetch-override patterns.
 *
 * EM-STRAT-009 §2: the scan covers EVERY .ts file under the test directory,
 * including offline-guard.test.ts and this helper file. The ONLY exempted
 * file is the guard setup file (GUARD_SETUP_FILE) which legitimately
 * installs the wrapped fail-closed fetch.
 *
 * Returns an array of violations. An empty array means no violations
 * were found.
 */
export function scanForFetchOverrides(testDir: string): FetchOverrideViolation[] {
  const fs = require('node:fs');
  const path = require('node:path');
  const allTsFiles = scanTsFiles(testDir, fs, path);
  const violations: FetchOverrideViolation[] = [];

  for (const filePath of allTsFiles) {
    const relPath = path.relative(testDir, filePath);
    // The guard setup file is the ONLY file allowed to assign the global
    // fetch property — it installs the wrapped fail-closed fetch.
    if (relPath === GUARD_SETUP_FILE) continue;

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { id, pattern } of FETCH_OVERRIDE_PATTERNS) {
        if (pattern.test(line)) {
          violations.push({
            file: relPath,
            patternId: id,
            line: i + 1,
            source: line.trim(),
          });
        }
      }
    }
  }
  return violations;
}

/**
 * Scan all .ts files under `testDir` for any assignment to the
 * originalFetch property on globalThis. No file should expose the
 * unwrapped real transport.
 */
export function scanForOriginalFetchExposure(testDir: string): string[] {
  const fs = require('node:fs');
  const path = require('node:path');
  const allTsFiles = scanTsFiles(testDir, fs, path);
  const violations: string[] = [];
  const pattern = /globalThis\s*\.\s*originalFetch\s*=/;
  for (const filePath of allTsFiles) {
    const relPath = path.relative(testDir, filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    if (pattern.test(content)) {
      violations.push(relPath);
    }
  }
  return violations;
}

// ─── Pattern self-test (samples constructed via concatenation) ────────
//
// EM-STRAT-009 §2: the sample strings below are constructed using
// concatenation so that the literal override syntax never appears as a
// contiguous substring in this file's source text. This prevents the
// static scanner from self-triggering on the helper file.

export interface PatternSelfTestResult {
  patternId: string;
  sample: string;
  matched: boolean;
}

/**
 * Verify that each detection pattern matches at least one known override
 * form. Returns an array of results — callers should assert that every
 * result has `matched: true`.
 *
 * EM-STRAT-009 §1: also verifies that the patterns do NOT match
 * legitimate (non-override) fetch usage.
 */
export function runPatternSelfTest(): {
  matches: PatternSelfTestResult[];
  falsePositives: PatternSelfTestResult[];
} {
  // Construct samples via concatenation — the literal override syntax
  // must NOT appear as a contiguous substring in the source.
  const gt = 'globalThis';
  const dot = '.';
  const fetch = 'fetch';
  const eq = ' =';
  const sp = ' ';

  const overrideSamples: Array<{ patternId: string; sample: string }> = [
    { patternId: 'P1', sample: gt + dot + fetch + eq + ' custom;' },
    { patternId: 'P1', sample: '  ' + gt + dot + fetch + '=custom;' },
    { patternId: 'P2', sample: 'global' + dot + fetch + eq + ' custom;' },
    { patternId: 'P3', sample: "vi.stubGlobal('" + fetch + "', custom);" },
    { patternId: 'P3', sample: 'vi.stubGlobal("' + fetch + '", custom);' },
    { patternId: 'P4', sample: "Object.defineProperty(" + gt + ", '" + fetch + "', { value: custom });" },
    { patternId: 'P5', sample: 'Object.defineProperty(global, "' + fetch + '", { value: custom });' },
    { patternId: 'P6', sample: "Object.defineProperty(someObj, '" + fetch + "', { value: custom });" },
    { patternId: 'P7', sample: "Reflect.defineProperty(" + gt + ", '" + fetch + "', { value: custom });" },
  ];

  const legitimateSamples: Array<{ patternId: string; sample: string }> = [
    { patternId: 'all', sample: 'const res = await ' + fetch + '("https://api.example.com/data");' },
    { patternId: 'all', sample: 'mockFetch.register("api.example.com", { status: 200 });' },
    { patternId: 'all', sample: 'expect(' + gt + dot + fetch + ').toBeDefined();' },
    { patternId: 'all', sample: 'const orig = ' + gt + dot + fetch + ';' },
  ];

  const matches: PatternSelfTestResult[] = overrideSamples.map(({ patternId, sample }) => {
    const pattern = FETCH_OVERRIDE_PATTERNS.find(p => p.id === patternId)!;
    return { patternId, sample, matched: pattern.pattern.test(sample) };
  });

  const falsePositives: PatternSelfTestResult[] = legitimateSamples.map(({ sample }) => {
    const matched = FETCH_OVERRIDE_PATTERNS.some(p => p.pattern.test(sample));
    return { patternId: 'all', sample, matched };
  });

  return { matches, falsePositives };
}

// ─── Runtime guard-assertion helper ───────────────────────────────────
//
// EM-STRAT-009 §1: the previous runtime check had a bug where a fulfilled
// fetch() would throw a synthetic error containing "offline guard", which
// was then caught by the same catch block and accepted as evidence that
// the guard worked. This helper fixes the bug by structuring the check
// so that:
//   - A fulfilled fetch() result fails the test OUTSIDE the rejection-
//     catching path.
//   - A rejected result passes only when the rejection is the expected
//     offline-guard error.
//   - An unrelated rejection fails the test.
//   - The assertion does not use its own synthetic error as evidence.
//
// EM-STRAT-010 §1: the rejection-matching logic now uses the EXACT guard
// error signature (OFFLINE_GUARD_ERROR_SIGNATURE, imported from the guard
// setup file) instead of a loose /offline guard/i substring. This prevents
// a substituted fetch from passing the assertion by rejecting with a
// generic message that merely contains the words "offline guard". The
// signature verifies the full prefix and the blocked-URL line format —
// only the actual installed guard produces this exact format.

/**
 * Assert that a given fetch function is fail-closed for the given URL.
 *
 * This helper is used both by the per-test beforeEach runtime check and
 * by regression tests that verify the helper itself works correctly.
 *
 * EM-STRAT-010 §1: a rejection passes ONLY when the error message matches
 * OFFLINE_GUARD_ERROR_SIGNATURE — the exact stable prefix and blocked-URL
 * line format produced by the installed guard. A rejection whose message
 * merely contains the substring "offline guard" but does NOT match the
 * full signature will FAIL the assertion.
 *
 * @param fetchFn The fetch function to test (typically the global fetch,
 *                or a substituted function for regression testing).
 * @param url     An unregistered URL that the guard should reject.
 *
 * @throws Error if fetchFn resolves (guard bypassed), rejects with a
 *         non-guard error, or rejects with a lookalike error that does
 *         not match the exact guard signature. Returns normally only if
 *         fetchFn rejects with the exact guard error format.
 */
export async function assertFetchIsGuarded(
  fetchFn: typeof fetch,
  url: string,
): Promise<void> {
  let resolved = false;
  let rejection: unknown = null;

  try {
    await fetchFn(url);
    resolved = true;
  } catch (e) {
    rejection = e;
  }

  // EM-STRAT-009 §1: the "fetch resolved" failure is OUTSIDE the catch
  // block. It throws directly to vitest, not through the catch path.
  // The error message intentionally does NOT contain "offline guard" so
  // it cannot be confused with the expected rejection.
  if (resolved) {
    throw new Error(
      'EM-STRAT-009 runtime-check: fetch RESOLVED but should have REJECTED. ' +
      'The fail-closed guard has been bypassed — the global fetch transport ' +
      'may have been overwritten. Review the test file for reassignment.',
    );
  }

  // fetch rejected — verify the rejection matches the EXACT guard signature.
  const message = rejection instanceof Error
    ? rejection.message
    : String(rejection);

  // EM-STRAT-010 §1: match the exact stable signature, NOT a loose
  // /offline guard/i substring. The signature verifies the full prefix
  // AND the blocked-URL line format. Only the actual installed guard
  // produces this exact format.
  if (!OFFLINE_GUARD_ERROR_SIGNATURE.test(message)) {
    // EM-STRAT-010 §1: the rejection is NOT the expected guard error.
    // This covers two cases:
    //   (a) The rejection is a completely unrelated error (e.g., TypeError).
    //   (b) The rejection message contains "offline guard" but does NOT
    //       match the full guard signature — a lookalike that must be
    //       rejected to prevent false positives.
    throw new Error(
      `EM-STRAT-010 runtime-check: fetch rejected with an error that does ` +
      `NOT match the exact guard signature. The rejection is either an ` +
      `unrelated error or a lookalike containing the substring but not the ` +
      `full guard format. This suggests the transport was overwritten with ` +
      `a function that throws a non-guard error. ` +
      `Original rejection: ${message}`,
    );
  }

  // Success: fetch rejected with the exact expected guard error format.
}
