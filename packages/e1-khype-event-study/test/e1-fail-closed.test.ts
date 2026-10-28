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
import { buildDiscountSeries } from '../src/study/discount-series.js';
import { validateManifest } from '../src/study/manifest.js';
import { parseAnchorJsonl, parsePoolJsonl } from '../src/study/raw-archive.js';
import { TUNED_L } from '../src/fixtures/synthetic-generator.js';

function replayVariant(mutate: (m: Record<string, unknown>) => void): ReturnType<typeof runReplay> {
  const fx = loadCommittedFixtures();
  const m = cloneManifest(fx.manifest);
  mutate(m);
  return runReplay(m, { anchorJsonl: fx.anchorJsonl, usdPriceJsonl: fx.usdPriceJsonl, poolJsonls: fx.poolJsonls });
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
      usdPriceJsonl: fx.usdPriceJsonl,
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
      usdPriceJsonl: fx.usdPriceJsonl,
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
    const r = runReplay(fx.manifest, { anchorJsonl: fx.anchorJsonl, usdPriceJsonl: fx.usdPriceJsonl, poolJsonls: pools });
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
    const WHYPE = '0x' + '11'.repeat(20);
    const KHYPE = '0x' + '22'.repeat(20);
    const anchorLines: string[] = [];
    const usdLines: string[] = [];
    const poolLines: string[] = [];
    for (let i = 0; i < samples; i++) {
      const block = startBlock + i * step;
      const ts = 1700000000 + i * 600;
      if (i !== 5) {
        anchorLines.push(JSON.stringify({ chainId: 999, blockHeight: block, blockTimestampSec: ts, anchorRawHex: '0xde0b6b3a7640000', anchorReadAtSec: ts }));
      }
      usdLines.push(JSON.stringify({ chainId: 999, blockHeight: block, blockTimestampSec: ts, priceRawHex: '0x' + (20n * 10n ** 18n).toString(16), source: 'synthetic-usd-reference' }));
      const rawRatio = i >= 3 && i <= 6 ? (1006n * (1n << 192n)) / 1000n : 1n << 192n;
      const Sqrt = sqrtOf(rawRatio);
      poolLines.push(JSON.stringify({
        chainId: 999,
        poolAddress: '0x00000000000000000000000000000000000000bb',
        blockHeight: block,
        blockTimestampSec: ts,
        token0Address: WHYPE,
        token1Address: KHYPE,
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
        token0: { symbol: 'WHYPE', decimals: 18, address: WHYPE },
        token1: { symbol: 'KHYPE', decimals: 18, address: KHYPE },
        expectedFeeTier: 100,
      },
    ];
    const r = runReplay(manifest, {
      anchorJsonl: anchorLines.join('\n') + '\n',
      usdPriceJsonl: usdLines.join('\n') + '\n',
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

// ─── EM-STRAT-014-E1-R1 — USD depth, chain provenance, orientation, duplicates ──

describe('E1-R1: per-sample USD depth conversion (no 1 WHYPE = $1 anywhere)', () => {
  // Rewrite every committed USD line's price (full-series variant keeps the
  // 289-block coverage intact).
  function usdSeriesWith(usdPriceRaw: bigint): { usdPriceJsonl: string; source: string } {
    const fx = loadCommittedFixtures();
    const lines = fx.usdPriceJsonl.trim().split('\n').map(line => {
      const obj = JSON.parse(line) as Record<string, unknown>;
      return JSON.stringify({ ...obj, priceRawHex: '0x' + usdPriceRaw.toString(16) });
    });
    return { usdPriceJsonl: lines.join('\n') + '\n', source: (JSON.parse(lines[0]!) as Record<string, unknown>).source as string };
  }

  function replayWithUsd(usdPriceRaw: bigint) {
    const fx = loadCommittedFixtures();
    const usd = usdSeriesWith(usdPriceRaw);
    return runReplay(fx.manifest, { anchorJsonl: fx.anchorJsonl, usdPriceJsonl: usd.usdPriceJsonl, poolJsonls: fx.poolJsonls });
  }

  it('$20/WHYPE: $10,000 -> exactly 500*10^18 wei walked (T1 identity preserved)', () => {
    const r = replayWithUsd(20n * 10n ** 18n);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.reportObject.pools.find(x => x.address.endsWith('00a1'))!;
    const ev = p.events[0];
    expect(ev.passed).toBe(true);
    expect(ev.depthQuote).not.toBeNull();
    expect(BigInt(ev.depthQuote!.amountInGrossWei)).toBe(500n * 10n ** 18n);
    expect(ev.depthQuote!.usdPriceRaw).toBe((20n * 10n ** 18n).toString());
    expect(ev.netAtDMaxPctStr).toBe('0.500000000000');
  });

  it('$40/WHYPE: $10,000 -> exactly 250*10^18 wei walked (different non-$1 price)', () => {
    const r = replayWithUsd(40n * 10n ** 18n);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.reportObject.pools.find(x => x.address.endsWith('00a1'))!;
    const ev = p.events[0];
    expect(BigInt(ev.depthQuote!.amountInGrossWei)).toBe(250n * 10n ** 18n);
    expect(ev.depthQuote!.usdPriceRaw).toBe((40n * 10n ** 18n).toString());
  });

  it('non-divisible conversion ceil-conservatively per wei (price $30: 333.33..e18 -> +1 wei ≥ D)', () => {
    const r = replayWithUsd(30n * 10n ** 18n);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.reportObject.pools.find(x => x.address.endsWith('00a1'))!;
    const wei = BigInt(p.events[0].depthQuote!.amountInGrossWei);
    // 10^4*10^36 / (3*10^19) = 333.33..e18 wei -> ceil to the NEXT WEI
    // (conservative: the walked amount is never smaller than D USD implies).
    expect(wei).toBe(333333333333333333334n);
    expect(wei * 30n).toBeGreaterThanOrEqual(10_000n * 10n ** 18n); // notional >= D
  });

  it('missing USD record at a dip block -> sample excluded from pass rule with counted usd_price_unavailable', () => {
    const fx = loadCommittedFixtures();
    // Remove the USD records for the dip blocks of pool a1 (grid 48..66).
    const kept: string[] = [];
    for (const line of fx.usdPriceJsonl.trim().split('\n')) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const block = obj.blockHeight as number;
      if (block >= 5_000_000 + 48 * 50 && block <= 5_000_000 + 66 * 50) continue;
      kept.push(line);
    }
    const r = runReplay(fx.manifest, { anchorJsonl: fx.anchorJsonl, usdPriceJsonl: kept.join('\n') + '\n', poolJsonls: fx.poolJsonls });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.reportObject.pools.find(x => x.address.endsWith('00a1'))!;
    expect(p.events[0].passed).toBe(false);
    expect(p.events[0].failingReason).toBe('depth_unmeasurable');
    expect(p.depthExclusions.some(e => e.reason === 'usd_price_unavailable')).toBe(true);
    expect(r.reportObject.aggregate.exclusionsByReason['usd_price_unavailable']).toBeGreaterThan(0);
  });

  it('malformed USD price (zero) at an EVALUATED block -> counted usd_price_malformed, no default adopted', () => {
    const fx = loadCommittedFixtures();
    // Line index 48 = block 5,002,400 = grid 48 = the d_max sample of pool
    // a1's event (d is constant 0.6% across the dip; earliest block wins
    // ties) — the block the pass rule actually walks.
    const lines = fx.usdPriceJsonl.trim().split('\n').map((line, i) => {
      if (i !== 48) return line;
      const obj = JSON.parse(line) as Record<string, unknown>;
      return JSON.stringify({ ...obj, priceRawHex: '0x0' });
    });
    const r = runReplay(fx.manifest, { anchorJsonl: fx.anchorJsonl, usdPriceJsonl: lines.join('\n') + '\n', poolJsonls: fx.poolJsonls });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.reportObject.pools.find(x => x.address.endsWith('00a1'))!;
    // The d_max sample (grid 48) is excluded with a counted reason; the
    // event may still pass via another qualifying in-span sample (the pass
    // rule requires at least one) — the COUNTED exclusion is the invariant.
    expect(p.exclusions.some(e => e.reason === 'usd_price_malformed' && e.blockHeight === 5_002_400)).toBe(true);
    expect(r.reportObject.aggregate.exclusionsByReason['usd_price_malformed']).toBeGreaterThan(0);
  });

  it('USD record without provenance (empty source) at an EVALUATED block -> counted usd_price_malformed', () => {
    const fx = loadCommittedFixtures();
    const lines = fx.usdPriceJsonl.trim().split('\n').map((line, i) => {
      if (i !== 48) return line; // grid 48 = pool a1's d_max sample
      const obj = JSON.parse(line) as Record<string, unknown>;
      return JSON.stringify({ ...obj, source: '' });
    });
    const r = runReplay(fx.manifest, { anchorJsonl: fx.anchorJsonl, usdPriceJsonl: lines.join('\n') + '\n', poolJsonls: fx.poolJsonls });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.reportObject.pools.find(x => x.address.endsWith('00a1'))!;
    expect(p.exclusions.some(e => e.reason === 'usd_price_malformed' && e.blockHeight === 5_002_400)).toBe(true);
    expect(r.reportObject.aggregate.exclusionsByReason['usd_price_malformed']).toBeGreaterThan(0);
  });

  it('report declares the conversion rule + USD provenance sources; no fixed wei figure', () => {
    const r = replayWithUsd(20n * 10n ** 18n);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const params = r.reportObject.parameters;
    expect(params.depthWhypeWeiRule).toContain('usdPriceRaw');
    expect(params.depthWhypeWeiRule).not.toContain('10^18/');
    expect(params.usdPriceSources).toEqual(['synthetic-usd-reference']);
    expect((params as unknown as Record<string, unknown>).depthNotionalWei).toBeUndefined();
  });
});

describe('E1-R1: chain provenance fail-closed (chainId 999)', () => {
  function firstLineWithChain(text: string, chainId: number): string {
    const lines = text.trim().split('\n');
    const obj = JSON.parse(lines[0]) as Record<string, unknown>;
    obj.chainId = chainId;
    lines[0] = JSON.stringify(obj);
    return lines.join('\n') + '\n';
  }

  it('wrong-chain ANCHOR record -> replay fails even though every other field is valid', () => {
    const fx = loadCommittedFixtures();
    const r = runReplay(fx.manifest, {
      anchorJsonl: firstLineWithChain(fx.anchorJsonl, 1),
      usdPriceJsonl: fx.usdPriceJsonl,
      poolJsonls: fx.poolJsonls,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toContain('chain_id_mismatch:anchor');
    expect(r.errors.join(' ')).toContain('expected_999_got_1');
  });

  it('wrong-chain POOL record -> replay fails even though every other field is valid', () => {
    const fx = loadCommittedFixtures();
    const pools: Record<string, string> = { ...fx.poolJsonls };
    const a1Key = Object.keys(pools).find(k => k.endsWith('00a1'))!;
    pools[a1Key] = firstLineWithChain(pools[a1Key], 137);
    const r = runReplay(fx.manifest, {
      anchorJsonl: fx.anchorJsonl,
      usdPriceJsonl: fx.usdPriceJsonl,
      poolJsonls: pools,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toContain('chain_id_mismatch:pool_');
    expect(r.errors.join(' ')).toContain('expected_999_got_137');
  });

  it('wrong-chain USD record -> replay fails (same provenance rule)', () => {
    const fx = loadCommittedFixtures();
    const r = runReplay(fx.manifest, {
      anchorJsonl: fx.anchorJsonl,
      usdPriceJsonl: firstLineWithChain(fx.usdPriceJsonl, 42161),
      poolJsonls: fx.poolJsonls,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toContain('chain_id_mismatch:usd_price');
  });
});

describe('E1-R1: token identity / price orientation integrity', () => {
  it('census with inverted token order (token0=kHYPE, token1=WHYPE) -> manifest REJECTED, no unverified orientation', () => {
    const fx = loadCommittedFixtures();
    const m = cloneManifest(fx.manifest) as Record<string, unknown>;
    const census = (m.poolCensus as Array<Record<string, unknown>>);
    for (const e of census) {
      const t0 = e.token0 as Record<string, unknown>;
      const t1 = e.token1 as Record<string, unknown>;
      e.token0 = t1;
      e.token1 = t0;
    }
    const r = runReplay(m, { anchorJsonl: fx.anchorJsonl, usdPriceJsonl: fx.usdPriceJsonl, poolJsonls: fx.poolJsonls });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toContain('pool_orientation_unsupported');
  });

  it('pool record whose token addresses disagree with the census -> replay FAILS CLOSED', () => {
    const fx = loadCommittedFixtures();
    const pools: Record<string, string> = { ...fx.poolJsonls };
    const a1Key = Object.keys(pools).find(k => k.endsWith('00a1'))!;
    const lines = pools[a1Key].trim().split('\n');
    const obj = JSON.parse(lines[0]) as Record<string, unknown>;
    // Swap the recorded token addresses (data from a DIFFERENT market).
    const t0 = obj.token0Address as string;
    obj.token0Address = obj.token1Address;
    obj.token1Address = t0;
    lines[0] = JSON.stringify(obj);
    pools[a1Key] = lines.join('\n') + '\n';
    const r = runReplay(fx.manifest, { anchorJsonl: fx.anchorJsonl, usdPriceJsonl: fx.usdPriceJsonl, poolJsonls: pools });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toContain('token_address_mismatch');
  });

  it('pool record with malformed token address -> sample excluded (counted), replay survives', () => {
    const fx = loadCommittedFixtures();
    const pools: Record<string, string> = { ...fx.poolJsonls };
    const a1Key = Object.keys(pools).find(k => k.endsWith('00a1'))!;
    const lines = pools[a1Key].trim().split('\n');
    const obj = JSON.parse(lines[0]) as Record<string, unknown>;
    obj.token0Address = 'not-an-address';
    lines[0] = JSON.stringify(obj);
    pools[a1Key] = lines.join('\n') + '\n';
    const r = runReplay(fx.manifest, { anchorJsonl: fx.anchorJsonl, usdPriceJsonl: fx.usdPriceJsonl, poolJsonls: pools });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.reportObject.pools.find(x => x.address.endsWith('00a1'))!;
    expect(p.exclusions.some(e => e.reason === 'sample_field_invalid' && e.detail?.includes('invalid_address'))).toBe(true);
  });
});

describe('E1-R1: duplicate record handling (never silently first-wins)', () => {
  it('duplicate anchor record with IDENTICAL decoded content -> counted, replay succeeds', () => {
    const fx = loadCommittedFixtures();
    const lines = fx.anchorJsonl.trim().split('\n');
    const withDup = [lines[0], lines[0], ...lines.slice(1)].join('\n') + '\n';
    const r = runReplay(fx.manifest, { anchorJsonl: withDup, usdPriceJsonl: fx.usdPriceJsonl, poolJsonls: fx.poolJsonls });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reportObject.aggregate.duplicateRecords['duplicate_anchor_record']).toBe(1);
  });

  it('duplicate anchor record with CONFLICTING values -> replay FAILS CLOSED', () => {
    const fx = loadCommittedFixtures();
    const lines = fx.anchorJsonl.trim().split('\n');
    const obj = JSON.parse(lines[0]) as Record<string, unknown>;
    obj.anchorRawHex = '0xde0b6b3a7640001'; // different anchor value, same block
    const conflicting = [lines[0], JSON.stringify(obj), ...lines.slice(1)].join('\n') + '\n';
    const r = runReplay(fx.manifest, { anchorJsonl: conflicting, usdPriceJsonl: fx.usdPriceJsonl, poolJsonls: fx.poolJsonls });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toContain('duplicate_anchor_conflict');
  });

  it('duplicate USD record with conflicting price -> replay FAILS CLOSED', () => {
    const fx = loadCommittedFixtures();
    const lines = fx.usdPriceJsonl.trim().split('\n');
    const obj = JSON.parse(lines[0]) as Record<string, unknown>;
    obj.priceRawHex = '0x' + (25n * 10n ** 18n).toString(16);
    const conflicting = [lines[0], JSON.stringify(obj), ...lines.slice(1)].join('\n') + '\n';
    const r = runReplay(fx.manifest, { anchorJsonl: fx.anchorJsonl, usdPriceJsonl: conflicting, poolJsonls: fx.poolJsonls });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toContain('duplicate_usd_price_conflict');
  });

  it('duplicate USD record with IDENTICAL content -> counted, replay succeeds (policy unchanged in R2)', () => {
    const fx = loadCommittedFixtures();
    const lines = fx.usdPriceJsonl.trim().split('\n');
    const withDup = [lines[0], lines[0], ...lines.slice(1)].join('\n') + '\n';
    const r = runReplay(fx.manifest, { anchorJsonl: fx.anchorJsonl, usdPriceJsonl: withDup, poolJsonls: fx.poolJsonls });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reportObject.aggregate.duplicateRecords['duplicate_usd_price_record']).toBe(1);
  });
});

describe('E1-R2: pool duplicate integrity (never silently first-wins)', () => {
  const A1 = '0x00000000000000000000000000000000000000a1';

  function poolWithIdenticalDup(text: string): string {
    const lines = text.trim().split('\n');
    return [lines[0], lines[0], ...lines.slice(1)].join('\n') + '\n';
  }

  function poolWithMutatedDup(text: string, mutate: (obj: Record<string, unknown>) => void): string {
    const lines = text.trim().split('\n');
    const obj = JSON.parse(lines[0]) as Record<string, unknown>;
    mutate(obj);
    return [lines[0], JSON.stringify(obj), ...lines.slice(1)].join('\n') + '\n';
  }

  function replayPools(pools: Record<string, string>): ReturnType<typeof runReplay> {
    const fx = loadCommittedFixtures();
    return runReplay(fx.manifest, { anchorJsonl: fx.anchorJsonl, usdPriceJsonl: fx.usdPriceJsonl, poolJsonls: pools });
  }

  it('identical duplicate pool sample -> replay succeeds, visibly counted, study result unchanged (R3: FULL report equality except the duplicate counter)', () => {
    const fx = loadCommittedFixtures();
    const withDup: Record<string, string> = { ...fx.poolJsonls, [A1]: poolWithIdenticalDup(fx.poolJsonls[A1]) };
    const r = runReplay(fx.manifest, { anchorJsonl: fx.anchorJsonl, usdPriceJsonl: fx.usdPriceJsonl, poolJsonls: withDup });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The identical duplicate is counted EXACTLY once, under exactly this reason.
    expect(r.reportObject.aggregate.duplicateRecords).toEqual({ duplicate_pool_record: 1 });

    const baseline = runReplay(fx.manifest, { anchorJsonl: fx.anchorJsonl, usdPriceJsonl: fx.usdPriceJsonl, poolJsonls: fx.poolJsonls });
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;

    // EM-STRAT-014-E1-R3: the affected pool's ENTIRE report entry must be
    // deep-equal to the baseline's — the COMPLETE series content (every
    // sample field: gridIndex, block, ts, dPct 12dp + exact, withinBand,
    // liquidity, feeTier), the FULL exclusion list (block + reason +
    // detail), events, depth exclusions, fee tier, and usable/exclusion
    // counts. R2 compared only series length + dPctExact, which cannot
    // detect a reporting divergence hidden in the exclusion list.
    const pDup = r.reportObject.pools.find(x => x.address === A1)!;
    const pBase = baseline.reportObject.pools.find(x => x.address === A1)!;
    expect(pDup).toEqual(pBase);

    // R3 — the exact double-reporting concern: an identical duplicate that
    // runReplay already counted in aggregate.duplicateRecords must NOT
    // resurface as a per-series 'duplicate_sample' exclusion. runReplay
    // passes DEDUPLICATED records ([...poolByBlock.values()]) to
    // buildDiscountSeries, so the duplicate row is reported in exactly one
    // place: the aggregate counter.
    expect(pDup.exclusions.filter(e => e.reason === 'duplicate_sample')).toEqual([]);
    expect(r.reportObject.aggregate.exclusionsByReason['duplicate_sample']).toBeUndefined();

    // R3 — whole-report stability: the duplicate run is identical to the
    // baseline run everywhere except aggregate.duplicateRecords (same
    // series, exclusions, events, verdict, and all other aggregate
    // counters). If this assertion ever fails, the duplicate policy is
    // leaking into study results.
    const dupClone = JSON.parse(JSON.stringify(r.reportObject)) as { aggregate: Record<string, unknown> };
    const baseClone = JSON.parse(JSON.stringify(baseline.reportObject)) as { aggregate: Record<string, unknown> };
    const aggDup = { ...dupClone.aggregate };
    const aggBase = { ...baseClone.aggregate };
    delete aggDup.duplicateRecords;
    delete aggBase.duplicateRecords;
    dupClone.aggregate = aggDup;
    baseClone.aggregate = aggBase;
    expect(dupClone).toEqual(baseClone);
  });

  it('conflicting duplicate (sqrtPriceX96Hex differs) -> replay FAILS CLOSED naming pool and block', () => {
    const fx = loadCommittedFixtures();
    const pools: Record<string, string> = {
      ...fx.poolJsonls,
      [A1]: poolWithMutatedDup(fx.poolJsonls[A1], obj => { obj.sqrtPriceX96Hex = '0x1000000000000000000000001'; }),
    };
    const r = replayPools(pools);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toContain('duplicate_pool_conflict');
    expect(r.errors.join(' ')).toContain(`pool_${A1}`);
    expect(r.errors.join(' ')).toContain('block_5000000');
  });

  it('conflicting duplicate (liquidityHex differs) -> replay FAILS CLOSED', () => {
    const fx = loadCommittedFixtures();
    const pools: Record<string, string> = {
      ...fx.poolJsonls,
      [A1]: poolWithMutatedDup(fx.poolJsonls[A1], obj => { obj.liquidityHex = '0xd58f8b61c007fa015138'; }),
    };
    const r = replayPools(pools);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toContain('duplicate_pool_conflict');
  });

  it('conflicting duplicate (tick differs) -> replay FAILS CLOSED', () => {
    const fx = loadCommittedFixtures();
    const pools: Record<string, string> = {
      ...fx.poolJsonls,
      [A1]: poolWithMutatedDup(fx.poolJsonls[A1], obj => { obj.tick = 1; }),
    };
    const r = replayPools(pools);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toContain('duplicate_pool_conflict');
  });

  it('conflicting duplicate (tickData CONTENT differs, same length) -> replay FAILS CLOSED', () => {
    const fx = loadCommittedFixtures();
    const pools: Record<string, string> = {
      ...fx.poolJsonls,
      [A1]: poolWithMutatedDup(fx.poolJsonls[A1], obj => {
        const td = structuredClone(obj.tickData) as Array<Record<string, unknown>>;
        td[1].liquidityNetDec = String(BigInt(td[1].liquidityNetDec as string) - 1n);
        obj.tickData = td;
      }),
    };
    const r = replayPools(pools);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toContain('duplicate_pool_conflict');
  });

  it('conflicting duplicate (tickData ORDER differs, same entries) -> replay FAILS CLOSED (order is part of identity)', () => {
    const fx = loadCommittedFixtures();
    const pools: Record<string, string> = {
      ...fx.poolJsonls,
      [A1]: poolWithMutatedDup(fx.poolJsonls[A1], obj => {
        const td = structuredClone(obj.tickData) as Array<Record<string, unknown>>;
        obj.tickData = [td[1], td[0]];
      }),
    };
    const r = replayPools(pools);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toContain('duplicate_pool_conflict');
  });

  it('conflicting duplicate (blockTimestampSec differs) -> replay FAILS CLOSED', () => {
    const fx = loadCommittedFixtures();
    const pools: Record<string, string> = {
      ...fx.poolJsonls,
      [A1]: poolWithMutatedDup(fx.poolJsonls[A1], obj => { obj.blockTimestampSec = 1700000001; }),
    };
    const r = replayPools(pools);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toContain('duplicate_pool_conflict');
  });

  it('conflicting duplicate (decoder field-error state differs: malformed vs clean) -> replay FAILS CLOSED', () => {
    // One record at a block decodes cleanly; its duplicate carries a
    // malformed tick. First-wins would have silently chosen one of them —
    // the archive is instead declared self-contradictory.
    const fx = loadCommittedFixtures();
    const pools: Record<string, string> = {
      ...fx.poolJsonls,
      [A1]: poolWithMutatedDup(fx.poolJsonls[A1], obj => { obj.tick = 'not-an-integer'; }),
    };
    const r = replayPools(pools);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toContain('duplicate_pool_conflict');
  });

  it('conflicting duplicate (token-address orientation differs between duplicates) -> replay FAILS CLOSED', () => {
    // Both records keep token0=WHYPE/token1=kHYPE SET membership, but the
    // duplicate swaps the two addresses — an orientation conflict at the
    // same block. (One of the two also necessarily disagrees with the
    // census, and the census check fires first; this test pins that the
    // replay cannot return ok in either path.)
    const fx = loadCommittedFixtures();
    const pools: Record<string, string> = {
      ...fx.poolJsonls,
      [A1]: poolWithMutatedDup(fx.poolJsonls[A1], obj => {
        const t0 = obj.token0Address as string;
        obj.token0Address = obj.token1Address;
        obj.token1Address = t0;
      }),
    };
    const r = replayPools(pools);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const joined = r.errors.join(' ');
    expect(joined.includes('duplicate_pool_conflict') || joined.includes('token_address_mismatch')).toBe(true);
  });
});

// ─── EM-STRAT-014-E1-R3 — duplicate-accounting contract ─────────────────
//
// Reconciliation record (R3 work order): the preferred resolution — pass
// only the canonical first record per block to buildDiscountSeries — is
// ALREADY implemented at the R2 anchor 8712576 (runReplay calls
// buildDiscountSeries with [...poolByBlock.values()], proven by the R2
// commit diff `- records, + [...poolByBlock.values()]`); the R2 identical-
// duplicate test above now guards that wiring with full-report equality.
//
// What remained undefined was the CONTRACT BOUNDARY between the two
// duplicate-detection layers. runReplay pre-validates and pre-dedups, so
// its identical duplicates are reported ONLY in
// aggregate.duplicateRecords. buildDiscountSeries retains its own guard
// for DIRECT library callers (work order item 4: "keep the direct-call
// duplicate guard for library safety"). These tests pin that guard's own
// deterministic semantics so neither layer's behavior can drift silently.

describe('E1-R3: buildDiscountSeries direct-call duplicate guard (library safety; unreachable via runReplay)', () => {
  const A1 = '0x00000000000000000000000000000000000000a1';

  function directCallArgs() {
    const fx = loadCommittedFixtures();
    const parsed = validateManifest(fx.manifest);
    if (!parsed.ok) throw new Error(`fixture manifest failed validation: ${parsed.errors.join('; ')}`);
    const pm = parsed.parsed;
    const m = pm.manifest;
    const anchorParsed = parseAnchorJsonl(fx.anchorJsonl);
    if (!anchorParsed.ok) throw new Error(`fixture anchor failed parsing: ${anchorParsed.error}`);
    const anchorByBlock = new Map(anchorParsed.records.map(r => [r.blockHeight, r]));
    const poolParsed = parsePoolJsonl(fx.poolJsonls[A1], A1);
    if (!poolParsed.ok) throw new Error(`fixture pool failed parsing: ${poolParsed.error}`);
    const expectedBlockAt = (gridIndex: number): number => m.window.startBlock + gridIndex * m.window.blockStep;
    return {
      records: poolParsed.records,
      call: (records: typeof poolParsed.records) => buildDiscountSeries(
        A1,
        m.window.sampleCount,
        expectedBlockAt,
        { byBlock: anchorByBlock },
        records,
        m.conventions.anchorStalenessMaxSec,
        m.conventions.anchorFutureToleranceSec,
        pm.independenceBandPct,
      ),
    };
  }

  it('identical duplicate passed DIRECTLY -> visible duplicate_sample exclusion, first record kept, samples identical to single-record call', () => {
    const { records, call } = directCallArgs();
    const single = call(records);
    const withDup = call([records[0], records[0], ...records.slice(1)]);

    // The duplicate is a VISIBLE exclusion in the series (direct-call
    // semantic — distinct from the runReplay aggregate view). Exclusions
    // are deterministically sorted (block, then reason) inside
    // buildDiscountSeries, so the extra entry is compared by content, not
    // by position.
    expect(withDup.exclusions.filter(e => e.reason === 'duplicate_sample')).toEqual([
      {
        blockHeight: records[0].blockHeight,
        reason: 'duplicate_sample',
        detail: `duplicate_raw_record_for_block_${records[0].blockHeight}_first_record_kept`,
      },
    ]);
    expect(withDup.exclusions.length).toBe(single.exclusions.length + 1);
    // First record kept, deterministically: the usable samples are the same.
    expect(withDup.samples).toEqual(single.samples);
    expect(withDup.feeTierRecorded).toBe(single.feeTierRecorded);
  });

  it('conflicting duplicate passed DIRECTLY -> deterministic throw (defense-in-depth)', () => {
    const { records, call } = directCallArgs();
    const clean = records[0];
    expect(clean.fieldError).toBeNull();
    const mutated: typeof clean = {
      ...clean,
      sqrtPriceX96: (clean.sqrtPriceX96 as bigint) + 1n, // conflicts on price
    };
    expect(() => call([clean, mutated, ...records.slice(1)]))
      .toThrowError(/discount_series:conflicting_duplicate_pool_sample:block_\d+:records_disagree_on_decoded_values/);
  });
});
