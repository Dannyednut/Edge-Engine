/**
 * EM-STRAT-014-E1 — shared test helpers (offline, deterministic).
 */

import { expect } from 'vitest';
import { rat, ratAbs, ratCmp, ratFromDecimalString, ratSub, type Rational } from '../src/math/rational.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReplay, type ReplayResult } from '../src/replay.js';

/** Parse "num/den" exact fraction strings produced by the study. */
export function parseExact(exact: string): Rational {
  const idx = exact.indexOf('/');
  if (idx === -1) return ratFromDecimalString(exact);
  return rat(BigInt(exact.slice(0, idx)), BigInt(exact.slice(idx + 1)));
}

/** Assert |actual - target| <= tolerance (all exact fraction or decimal strings). */
export function expectRatNear(actual: string, target: string, tolerance: string): void {
  const a = parseExact(actual);
  const t = parseExact(target);
  const tol = parseExact(tolerance);
  const diff = ratAbs(ratSub(a, t));
  const cmp = ratCmp(diff, tol);
  expect(cmp <= 0, `|${actual} - ${target}| = ${ratSub(a, t)} exceeded tolerance ${tolerance}`).toBe(true);
}

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES_DIR = join(PACKAGE_ROOT, 'fixtures', 'synthetic-48h');
export const RAW_DIR = join(FIXTURES_DIR, 'raw');

export interface LoadedFixtures {
  manifest: unknown;
  anchorJsonl: string;
  usdPriceJsonl: string;
  poolJsonls: Record<string, string>;
}

export function loadCommittedFixtures(): LoadedFixtures {
  const manifest = JSON.parse(readFileSync(join(FIXTURES_DIR, 'SYNTHETIC-manifest.json'), 'utf8')) as unknown;
  const anchorJsonl = readFileSync(join(RAW_DIR, 'anchor.jsonl'), 'utf8');
  const usdPriceJsonl = readFileSync(join(RAW_DIR, 'usd-price.jsonl'), 'utf8');
  const poolJsonls: Record<string, string> = {};
  for (const addr of [
    '0x00000000000000000000000000000000000000a1',
    '0x00000000000000000000000000000000000000a2',
    '0x00000000000000000000000000000000000000a3',
    '0x00000000000000000000000000000000000000a4',
  ]) {
    poolJsonls[addr] = readFileSync(join(RAW_DIR, `${addr}.jsonl`), 'utf8');
  }
  return { manifest, anchorJsonl, usdPriceJsonl, poolJsonls };
}

export function replayCommitted(): Extract<ReplayResult, { ok: true }> {
  const fx = loadCommittedFixtures();
  const result = runReplay(fx.manifest, {
    anchorJsonl: fx.anchorJsonl,
    usdPriceJsonl: fx.usdPriceJsonl,
    poolJsonls: fx.poolJsonls,
  });
  if (!result.ok) throw new Error(`replay failed: ${JSON.stringify(result.errors)}`);
  return result;
}

/** Build a full RawArchiveInput from a loaded fixture set (for variant tests). */
export function archiveFrom(fx: LoadedFixtures, overrides: Partial<{ anchorJsonl: string; usdPriceJsonl: string; poolJsonls: Record<string, string> }> = {}): { anchorJsonl: string; usdPriceJsonl: string; poolJsonls: Record<string, string> } {
  return {
    anchorJsonl: overrides.anchorJsonl ?? fx.anchorJsonl,
    usdPriceJsonl: overrides.usdPriceJsonl ?? fx.usdPriceJsonl,
    poolJsonls: overrides.poolJsonls ?? fx.poolJsonls,
  };
}

export function poolByAddress(result: Extract<ReplayResult, { ok: true }>, suffix: string) {
  const pool = result.reportObject.pools.find(p => p.address.endsWith(suffix));
  if (!pool) throw new Error(`pool ...${suffix} not found`);
  return pool;
}

/** Clone helper for manifest variants. */
export function cloneManifest(manifest: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
}
