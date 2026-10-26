/**
 * EM-STRAT-014-E1 — fail-closed manifest/archive tests + guards.
 *
 * The tool must REFUSE to run (with explicit, deterministic errors) on any
 * missing or malformed pre-registration input, and must never reach for
 * defaults. Also guards the declared architectural isolation: this package
 * must not import the scanner's view-quoter (no chain-999 deployment) and
 * must not couple to packages/scanner at all.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cloneManifest, loadCommittedFixtures, PACKAGE_ROOT } from './_helpers.js';
import { runReplay } from '../src/replay.js';
import { TUNED_L } from '../src/fixtures/synthetic-generator.js';

function replayVariant(mutate: (m: Record<string, unknown>) => void): ReturnType<typeof runReplay> {
  const fx = loadCommittedFixtures();
  const m = cloneManifest(fx.manifest);
  mutate(m);
  return runReplay(m, { anchorJsonl: fx.anchorJsonl, poolJsonls: fx.poolJsonls });
}

describe('fail-closed manifest validation', () => {
  it('missing D -> explicit error, no default adopted', () => {
    const r = replayVariant(m => delete (m.parameters as Record<string, unknown>).depthUsd);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some(e => e.includes('parameters.depthUsd'))).toBe(true);
  });

  it('missing N -> explicit error, no default adopted (E1-T11 precondition)', () => {
    const r = replayVariant(m => delete (m.parameters as Record<string, unknown>).nEventsPerWeek);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some(e => e.includes('parameters.nEventsPerWeek'))).toBe(true);
  });

  it('missing costs (flashloan fee) -> explicit error', () => {
    const r = replayVariant(m => delete (m.costs as Record<string, unknown>).flashloanFeePct);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some(e => e.includes('costs.flashloanFeePct'))).toBe(true);
  });

  it('non-synthetic manifest is REFUSED (real-study manifests are not authorized under E1)', () => {
    const r = replayVariant(m => {
      m.synthetic = false;
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toContain('real-study-manifest-not-authorized-EM-STRAT-014-E1');
  });

  it('convention drift is rejected exactly (price convention / formula / sign / assumption)', () => {
    const wrongPrice = replayVariant(m => {
      (m.conventions as Record<string, unknown>).priceConvention = 'whype_per_khype';
    });
    expect(wrongPrice.ok).toBe(false);
    if (!wrongPrice.ok) expect(wrongPrice.errors.join(' ')).toContain('conventions.priceConvention');

    const wrongFormula = replayVariant(m => {
      (m.conventions as Record<string, unknown>).discountFormula = 'd = 1 - price * anchorRate';
    });
    expect(wrongFormula.ok).toBe(false);

    const wrongAssumption = replayVariant(m => {
      (m.conventions as Record<string, unknown>).whypeEqualsHype = 'FACT';
    });
    expect(wrongAssumption.ok).toBe(false);
    if (!wrongAssumption.ok) expect(wrongAssumption.errors.join(' ')).toContain('ASSUMPTION_NOT_FACT');
  });

  it('non-18-decimal tokens are rejected (raw price == human price convention)', () => {
    const r = replayVariant(m => {
      const census = m.poolCensus as Array<Record<string, unknown>>;
      census[0] = {
        ...census[0],
        token0: { symbol: 'WHYPE', decimals: 17 },
      };
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toContain('decimals:expected-18-code-convention');
  });

  it('validation returns ALL violations at once (not just the first)', () => {
    const r = replayVariant(m => {
      delete (m.parameters as Record<string, unknown>).nEventsPerWeek;
      delete (m.parameters as Record<string, unknown>).depthUsd;
      delete (m.costs as Record<string, unknown>).redemptionFeePct;
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('fail-closed archive handling', () => {
  it('a structurally unparseable raw line poisons the replay with the line number', () => {
    const fx = loadCommittedFixtures();
    const broken = fx.anchorJsonl.split('\n');
    broken[10] = '{not-json';
    const r = runReplay(fx.manifest, {
      anchorJsonl: broken.join('\n'),
      poolJsonls: fx.poolJsonls,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain('anchor_line_11');
  });

  it('a pool file referencing an address outside the census is refused', () => {
    const fx = loadCommittedFixtures();
    const r = runReplay(fx.manifest, {
      anchorJsonl: fx.anchorJsonl,
      poolJsonls: { ...fx.poolJsonls, '0x9999999999999999999999999999999999999999': '' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toContain('pool_file_not_in_census');
  });

  it('a census pool without a raw file is refused', () => {
    const fx = loadCommittedFixtures();
    const pools = { ...fx.poolJsonls };
    delete pools['0x00000000000000000000000000000000000000a3'];
    const r = runReplay(fx.manifest, { anchorJsonl: fx.anchorJsonl, poolJsonls: pools });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toContain('pool_file_missing');
  });

  it('an anchor gap INSIDE a dip merges the excursion and flags spannedExclusionGap (fail-closed contiguity)', () => {
    // Tiny inline archive: 10 samples, dip i=3..6 with the anchor record
    // missing at i=5 (inside the dip). Pre-registered rules: the excursion
    // is broken by the gap; no reversion is observable between the two
    // halves; the pre-registered merge rule therefore yields ONE event
    // flagged spannedExclusionGap=true.
    const startBlock = 1000;
    const step = 10;
    const samples = 10;
    const anchorLines: string[] = [];
    const poolLines: string[] = [];
    for (let i = 0; i < samples; i++) {
      const block = startBlock + i * step;
      const ts = 1700000000 + i * 600;
      if (i !== 5) {
        anchorLines.push(JSON.stringify({ chainId: 999, blockHeight: block, blockTimestampSec: ts, anchorRawHex: '0xde0b6b3a7640000', anchorReadAtSec: ts }));
      }
      const rawRatio = i >= 3 && i <= 6 ? (1006n * (1n << 192n)) / 1000n : 1n << 192n;
      const Sqrt = sqrtOf(rawRatio);
      poolLines.push(JSON.stringify({
        chainId: 999,
        poolAddress: '0x00000000000000000000000000000000000000bb',
        blockHeight: block,
        blockTimestampSec: ts,
        sqrtPriceX96Hex: '0x' + Sqrt.toString(16),
        tick: tickOf(Sqrt),
        liquidityHex: '0x' + TUNED_L.toString(16),
        feeTierMillionths: 100,
        tickData: [{ tick: -6000, liquidityNetDec: TUNED_L.toString() }, { tick: 6000, liquidityNetDec: '-' + TUNED_L.toString() }],
      }));
    }
    const manifest = cloneManifest(loadCommittedFixtures().manifest) as Record<string, unknown>;
    manifest.window = { startBlock, blockStep: step, sampleCount: samples, startTimestampSec: 1700000000, gridStepSec: 600 };
    manifest.poolCensus = [
      {
        address: '0x00000000000000000000000000000000000000bb',
        venue: 'synthetic-inline',
        token0: { symbol: 'WHYPE', decimals: 18 },
        token1: { symbol: 'kHYPE', decimals: 18 },
        expectedFeeTier: 100,
      },
    ];
    const r = runReplay(manifest, {
      anchorJsonl: anchorLines.join('\n') + '\n',
      poolJsonls: { '0x00000000000000000000000000000000000000bb': poolLines.join('\n') + '\n' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pool = r.reportObject.pools[0];
    // exactly one sample_missing exclusion (the in-dip anchor gap)
    expect(pool.exclusions.filter(e => e.reason === 'anchor_unusable')).toHaveLength(1);
    // the dip yields ONE merged event with the gap flag
    expect(pool.events).toHaveLength(1);
    expect(pool.events[0].spannedExclusionGap).toBe(true);
    expect(pool.events[0].passed).toBe(true);
  });
});

/** Local isqrt for the inline fixture (mirrors src convention). */
function sqrtOf(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2) + 1);
  let next = (x + n / x) >> 1n;
  while (next < x) {
    x = next;
    next = (x + n / x) >> 1n;
  }
  while (x * x > n) x -= 1n;
  return x;
}

/** Local tick derivation (mirrors src convention: largest t with sqrtP(t) <= S). */
function tickOf(S: bigint): number {
  let t = 0;
  // price 1.006 -> tick ~59; price 1 -> tick 0; search downward/UPper bounded
  const sqrtAt = (k: number) => {
    const abs = k >= 0 ? k : -k;
    const base = sqrtOf(((1n << 192n) * (10001n ** BigInt(abs))) / (10000n ** BigInt(abs)));
    return k >= 0 ? base : (1n << 192n) / base;
  };
  if (sqrtAt(0) > S) return -1; // not expected in this fixture
  while (sqrtAt(t + 1) <= S && t < 6000) t++;
  return t;
}

describe('architectural isolation guards', () => {
  function listTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) out.push(...listTsFiles(p));
      else if (entry.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  it('the package never references the view-quoter or imports packages/scanner', () => {
    const srcDir = join(PACKAGE_ROOT, 'src');
    for (const f of listTsFiles(srcDir)) {
      const text = readFileSync(f, 'utf8');
      expect(text.includes('uniswap-quoter'), `view-quoter reference in ${f}`).toBe(false);
      expect(text.includes('VIEW_QUOTER'), `VIEW_QUOTER reference in ${f}`).toBe(false);
      expect(text.includes('@edge/scanner'), `scanner import in ${f}`).toBe(false);
    }
  });
});
