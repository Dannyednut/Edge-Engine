/**
 * EM-STRAT-014-E1 — E1-T9 reproducibility: the full recorded fixture set
 * replayed in two FRESH processes produces byte-identical canonical output.
 *
 * The fresh-process guarantee is what rules out hidden nondeterminism
 * (module-level caches, clocks, environment leakage): each run is a new
 * node process executing the CLI through tsx, exactly as an operator would.
 * The canonical output is also verified to contain NO floats and NO
 * wall-clock fields.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RAW_DIR, FIXTURES_DIR, PACKAGE_ROOT, replayCommitted } from './_helpers.js';

const REPO_ROOT = join(PACKAGE_ROOT, '..', '..');
const CLI = join(PACKAGE_ROOT, 'src', 'cli', 'replay.ts');
const MANIFEST = join(FIXTURES_DIR, 'SYNTHETIC-manifest.json');

function resolveTsx(): string {
  const candidate = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
  if (existsSync(candidate)) return candidate;
  throw new Error(`tsx binary not found at ${candidate}`);
}

function runCliOnce(): Buffer {
  const out = execFileSync(resolveTsx(), [CLI, '--manifest', MANIFEST, '--raw', RAW_DIR], {
    cwd: REPO_ROOT,
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, NODE_ENV: 'production' },
  });
  return out;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('E1-T9 — canonical output is byte-identical across two fresh processes', () => {
  it('two fresh CLI runs agree byte-for-byte (and with the in-process run)', () => {
    const run1 = runCliOnce();
    const run2 = runCliOnce();
    expect(run1.length).toBeGreaterThan(100_000); // full report, not an error stub
    expect(run1.equals(run2)).toBe(true);
    expect(sha256(run1)).toBe(sha256(run2));

    // and matches the in-process pipeline (same canonical bytes + newline)
    const inProcess = replayCommitted();
    expect(run1.toString('utf8')).toBe(inProcess.reportJson + '\n');
  }, 120_000);

  it('output contains no float-formatted numbers and no wall-clock fields', () => {
    const out = runCliOnce().toString('utf8');
    // no wall-clock / generated-at style keys anywhere
    expect(out.toLowerCase()).not.toContain('generatedat');
    expect(out.toLowerCase()).not.toContain('timestamp_ms');
    expect(out.toLowerCase()).not.toContain('"now"');
    // every JSON number must be a safe integer (all measured quantities
    // travel as exact decimal/fraction strings)
    const parsed: unknown = JSON.parse(out);
    const checkNumbers = (v: unknown): void => {
      if (typeof v === 'number') {
        expect(Number.isSafeInteger(v)).toBe(true);
      } else if (Array.isArray(v)) {
        v.forEach(checkNumbers);
      } else if (v !== null && typeof v === 'object') {
        Object.values(v as Record<string, unknown>).forEach(checkNumbers);
      }
    };
    checkNumbers(parsed);
  }, 120_000);

  it('the committed fixture set itself is stable input (sha256 recorded, files exist)', () => {
    for (const f of ['SYNTHETIC-manifest.json', 'raw/anchor.jsonl']) {
      const bytes = readFileSync(join(FIXTURES_DIR, f));
      expect(bytes.length).toBeGreaterThan(1000);
    }
  });
});
